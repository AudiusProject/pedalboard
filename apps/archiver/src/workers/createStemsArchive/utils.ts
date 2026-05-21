import { WorkerServices } from '../services'
import {
  ARCHIVE_FALLBACK_HOST,
  MIRROR_DOWNLOAD_TIMEOUT_MS
} from '../../constants'

// Retry budget for the initial redirect-resolve hop against api.audius.co.
// The API rate-limits aggressively when the archiver fires N parallel
// stem-resolution requests; with concurrentJobs jobs in flight, a pod can
// easily punch through the per-IP limit. Retry on 429/5xx with exponential
// backoff + jitter, honoring Retry-After when set. The content-node download
// itself doesn't use these retries — it fails over to the next mirror.
const MAX_REDIRECT_RESOLVE_ATTEMPTS = 5
const BASE_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000

const isRetryableStatus = (status: number) =>
  status === 429 || status === 502 || status === 503 || status === 504

// Returns ms to wait. Prefers the server's Retry-After header when present and
// parseable; otherwise falls back to exponential backoff with jitter. Clamped
// to MAX_BACKOFF_MS so a hostile header can't stall the job indefinitely.
const computeBackoffMs = (attempt: number, retryAfter: string | null) => {
  if (retryAfter != null) {
    const asSeconds = Number(retryAfter)
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
      return Math.min(asSeconds * 1000, MAX_BACKOFF_MS)
    }
    const asDate = Date.parse(retryAfter)
    if (!Number.isNaN(asDate)) {
      return Math.min(Math.max(asDate - Date.now(), 0), MAX_BACKOFF_MS)
    }
  }
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
  // Full jitter: pick uniformly from [0, exp]. Parallel retries are otherwise
  // phase-locked and dogpile the rate limiter on the same ticks.
  return Math.floor(Math.random() * exp)
}

// Normalize a mirror entry to an origin (https://host[:port]). Mirror entries
// from the API are usually bare origins, but accept full URLs defensively so a
// stray path component doesn't get spliced into the candidate URL.
const toOrigin = (mirror: string): string | null => {
  try {
    return new URL(mirror).origin
  } catch {
    return null
  }
}

// Fisher–Yates shuffle. We want randomized mirror order across jobs so load
// spreads evenly, rather than every archiver instance always trying the same
// node first.
const shuffle = <T>(items: readonly T[]): T[] => {
  const copy = items.slice()
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

// Build the ordered list of hosts to try, preserving first-occurrence order
// after dedupe. Mirrors are shuffled; the archive fallback is appended last
// so it only gets hit when every mirror fails.
const buildCandidateHosts = (mirrors: readonly string[]): string[] => {
  const ordered = [...shuffle(mirrors), ARCHIVE_FALLBACK_HOST]
  const seen = new Set<string>()
  const result: string[] = []
  for (const m of ordered) {
    const origin = toOrigin(m)
    if (origin && !seen.has(origin)) {
      seen.add(origin)
      result.push(origin)
    }
  }
  return result
}

// Swap the host on the canonical signed content-node URL. The signature in
// the query is host-agnostic — the content node validates it against the cid
// and timestamp, not the request's authority — so swapping origins is safe.
const swapHost = (canonicalUrl: string, host: string): string => {
  const parsed = new URL(canonicalUrl)
  const target = new URL(host)
  parsed.protocol = target.protocol
  parsed.host = target.host
  return parsed.toString()
}

// Combine the job's overall abort signal with a per-mirror timeout. We can't
// share the job AbortController across mirrors — aborting it would cancel the
// whole job — so we make a fresh one and abort it from both inputs.
const linkAbort = (
  signal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } => {
  const controller = new AbortController()
  let didTimeOut = false
  const timer = setTimeout(() => {
    didTimeOut = true
    controller.abort()
  }, timeoutMs)
  const onParentAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) {
      controller.abort()
    } else {
      signal.addEventListener('abort', onParentAbort)
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onParentAbort)
    },
    timedOut: () => didTimeOut
  }
}

// Append `?api_key=<key>` to an existing URL (preserving any query string
// already present). Returns the original URL unchanged when no key is set.
// Parses via URL rather than string-splicing so we don't have to know whether
// the caller already added a `?`.
const appendApiKey = (url: string, apiKey: string | undefined): string => {
  if (!apiKey) return url
  try {
    const parsed = new URL(url)
    parsed.searchParams.set('api_key', apiKey)
    return parsed.toString()
  } catch {
    // If the URL is somehow unparseable we can't safely rewrite it — let the
    // fetch fail on the original string rather than mangle it silently.
    return url
  }
}

// Signal-aware sleep that rejects on abort rather than silently waiting out the
// delay after cancellation.
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'))
      return
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      signal?.removeEventListener('abort', onAbort)
      reject(new Error('Aborted'))
    }
    signal?.addEventListener('abort', onAbort)
  })

export const createUtils = (services: WorkerServices) => {
  const { archiver, config, fetch, fs, fsSync, path, logger } = services
  const fileExists = async (path: string) => {
    return await fs.access(path).then(
      () => true,
      () => false
    )
  }

  // Resolve api.audius.co's /tracks/{id}/download endpoint into the canonical
  // signed content-node URL (the Location header on the 302). The signature
  // and path are host-agnostic, so once we have this we can swap origins to
  // try different mirrors without re-hitting the API. Retries 429/5xx with
  // backoff because the API's per-IP limiter punishes parallel stem
  // resolution under load.
  const resolveCanonicalUrl = async ({
    url,
    jobId,
    filePath,
    signal
  }: {
    url: string
    jobId: string
    filePath: string
    signal?: AbortSignal
  }): Promise<string> => {
    const authedUrl = appendApiKey(url, config.apiKey)

    for (
      let attempt = 0;
      attempt < MAX_REDIRECT_RESOLVE_ATTEMPTS;
      attempt++
    ) {
      const res = await fetch(authedUrl, {
        redirect: 'manual',
        signal
      })
      const { status, statusText, body } = res

      // 3xx is the success case here — we want the Location, not the body.
      if (status >= 300 && status < 400) {
        const location = res.headers.get('location')
        try {
          body?.resume()
        } catch {
          /* best effort */
        }
        if (!location) {
          throw new Error(
            `Redirect from api.audius.co missing Location header — ${filePath}`
          )
        }
        return location
      }

      // 2xx means the API served the file directly (no redirect). Unusual
      // but valid — treat the API URL itself as the canonical URL.
      if (status >= 200 && status < 300) {
        try {
          body?.resume()
        } catch {
          /* best effort */
        }
        return authedUrl
      }

      const attemptsLeft = MAX_REDIRECT_RESOLVE_ATTEMPTS - attempt - 1
      if (isRetryableStatus(status) && attemptsLeft > 0) {
        const retryAfter = res.headers.get('retry-after')
        const delayMs = computeBackoffMs(attempt, retryAfter)
        logger.warn(
          {
            jobId,
            url,
            filePath,
            status,
            statusText,
            retryAfter,
            attempt: attempt + 1,
            attemptsLeft,
            delayMs
          },
          'Redirect-resolve retryable error, backing off'
        )
        try {
          body?.resume()
        } catch {
          /* best effort */
        }
        await sleep(delayMs, signal)
        continue
      }

      logger.error(
        { jobId, url, filePath, status, statusText },
        'Redirect-resolve failed'
      )
      throw new Error(
        `Failed to resolve download URL: ${statusText} (${status}) — ${filePath}`
      )
    }

    throw new Error(
      `Failed to resolve download URL after ${MAX_REDIRECT_RESOLVE_ATTEMPTS} attempts — ${filePath}`
    )
  }

  // Try a single mirror. Streams the response body straight to disk. Returns
  // true on success, false on any error (HTTP, network, timeout). Aborts via
  // the per-mirror timeout if the node is slow; the parent job's signal also
  // aborts mid-stream if the whole job is cancelled.
  const tryMirror = async ({
    candidateUrl,
    host,
    filePath,
    jobId,
    signal
  }: {
    candidateUrl: string
    host: string
    filePath: string
    jobId: string
    signal?: AbortSignal
  }): Promise<boolean> => {
    const linked = linkAbort(signal, MIRROR_DOWNLOAD_TIMEOUT_MS)
    const startedAt = Date.now()
    try {
      const res = await fetch(candidateUrl, { signal: linked.signal })
      const { ok, body, status, statusText } = res
      if (!ok) {
        try {
          body?.resume()
        } catch {
          /* best effort */
        }
        logger.warn(
          {
            jobId,
            host,
            filePath,
            status,
            statusText,
            elapsedMs: Date.now() - startedAt
          },
          'Mirror download failed (HTTP error)'
        )
        return false
      }
      if (!body) {
        logger.warn(
          { jobId, host, filePath, status },
          'Mirror download failed (empty body)'
        )
        return false
      }

      const fileStream = fsSync.createWriteStream(filePath)
      try {
        await new Promise<void>((resolve, reject) => {
          body.pipe(fileStream)
          body.on('error', reject)
          fileStream.on('error', reject)
          fileStream.on('finish', () => resolve())
        })
      } catch (streamError) {
        // Partial file on disk — caller's catch will unlink the temp dir, but
        // wipe this file too so a subsequent mirror attempt can re-create it
        // cleanly without an EEXIST or stale-bytes surprise.
        try {
          await fs.unlink(filePath)
        } catch {
          /* best effort */
        }
        logger.warn(
          {
            jobId,
            host,
            filePath,
            err: streamError,
            timedOut: linked.timedOut(),
            elapsedMs: Date.now() - startedAt
          },
          'Mirror download failed (stream error)'
        )
        return false
      }

      logger.info(
        {
          jobId,
          host,
          filePath,
          elapsedMs: Date.now() - startedAt
        },
        'Mirror download succeeded'
      )
      return true
    } catch (fetchError) {
      // The job-level abort propagates here too. If it's the job (not the
      // per-mirror timeout) we need to surface it so the caller stops trying
      // additional mirrors.
      if (signal?.aborted) {
        throw fetchError
      }
      logger.warn(
        {
          jobId,
          host,
          filePath,
          err: fetchError,
          timedOut: linked.timedOut(),
          elapsedMs: Date.now() - startedAt
        },
        'Mirror download failed (network error)'
      )
      return false
    } finally {
      linked.cleanup()
    }
  }

  const downloadFile = async ({
    url,
    filePath,
    jobId,
    mirrors,
    signal
  }: {
    url: string
    filePath: string
    jobId: string
    /**
     * Content-node origins from the track's upload metadata (e.g.
     * `track.download.mirrors`). Tried in shuffled order before falling back
     * to the archive node. Empty/undefined is fine — we'll go straight to
     * the archive fallback.
     */
    mirrors?: readonly string[]
    signal?: AbortSignal
  }): Promise<string> => {
    logger.info(
      { jobId, url, filePath, mirrorCount: mirrors?.length ?? 0 },
      'Downloading stem file'
    )

    const canonicalUrl = await resolveCanonicalUrl({
      url,
      jobId,
      filePath,
      signal
    })

    const candidateHosts = buildCandidateHosts(mirrors ?? [])
    const attempted: { host: string; error?: string }[] = []

    for (const host of candidateHosts) {
      if (signal?.aborted) {
        throw new Error('Aborted')
      }
      const candidateUrl = swapHost(canonicalUrl, host)
      const ok = await tryMirror({
        candidateUrl,
        host,
        filePath,
        jobId,
        signal
      })
      if (ok) {
        return filePath
      }
      attempted.push({ host })
    }

    logger.error(
      { jobId, url, filePath, attempted },
      'All mirrors failed for stem download'
    )
    throw new Error(
      `Failed to download stem from all mirrors (${attempted.length}) — ${filePath}`
    )
  }

  const removeTempFiles = async (jobId: string) => {
    const jobTempDir = path.join(config.archiverTmpDir, jobId)
    if (await fileExists(jobTempDir)) {
      await fs.rm(jobTempDir, { recursive: true, force: true })
    }
  }

  const createArchive = async ({
    files,
    jobId,
    archiveName,
    signal
  }: {
    files: string[]
    jobId: string
    archiveName: string
    signal?: AbortSignal
  }): Promise<string> => {
    const jobTempDir = path.join(config.archiverTmpDir, jobId)
    const outputPath = path.join(jobTempDir, archiveName)

    const output = fsSync.createWriteStream(outputPath)
    const archive = archiver('zip', {
      zlib: { level: 6 }
    })

    try {
      if (signal) {
        signal.addEventListener('abort', () => {
          archive.abort()
        })
      }

      archive.on('error', (error: Error) => {
        throw error
      })

      archive.pipe(output)

      for (const file of files) {
        const filename = path.basename(file)
        archive.file(file, { name: filename })
      }

      const finishPromise = new Promise((resolve, reject) => {
        output.on('close', resolve)
        output.on('error', reject)
      })

      await archive.finalize()
      await finishPromise

      return outputPath
    } finally {
      output.destroy()
      archive.destroy()
    }
  }

  return {
    createArchive,
    downloadFile,
    fileExists,
    removeTempFiles
  }
}
