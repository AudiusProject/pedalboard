import { WorkerServices } from '../services'

// Retry budget for downloadFile. api.audius.co rate-limits aggressively when
// the archiver fires N parallel stem-resolution requests; with concurrentJobs
// jobs in flight, a pod can easily punch through the per-IP limit. Retry on
// 429/5xx with exponential backoff + jitter, honoring Retry-After when set.
const MAX_DOWNLOAD_ATTEMPTS = 5
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

  const downloadFile = async ({
    url,
    filePath,
    jobId,
    signal
  }: {
    url: string
    filePath: string
    jobId: string
    signal?: AbortSignal
  }): Promise<string> => {
    // Attach the app api_key so api.audius.co's rate limit middleware
    // resolves us as the configured developer app (rps/rpm from the
    // api_keys table) instead of the anonymous IP bucket (5 RPS).
    // downloadFile doesn't go through the SDK's middleware chain, so the
    // param has to land here. api_key is a public identifier so there's
    // no secret to scrub — but we log `url` (the pre-auth input) rather
    // than `authedUrl` anyway to keep log lines stable and readable.
    const authedUrl = appendApiKey(url, config.apiKey)

    logger.info({ jobId, url, filePath }, 'Downloading stem file')

    for (let attempt = 0; attempt < MAX_DOWNLOAD_ATTEMPTS; attempt++) {
      const res = await fetch(authedUrl, {
        signal
      })
      const { ok, body, statusText, status } = res
      // res.url is the final URL after node-fetch follows redirects, so it
      // tells us whether the error came from api.audius.co or from whichever
      // content node the API picked. The input `url` alone is ambiguous.
      const finalUrl = (res as { url?: string }).url ?? url

      if (!ok) {
        const attemptsLeft = MAX_DOWNLOAD_ATTEMPTS - attempt - 1
        if (isRetryableStatus(status) && attemptsLeft > 0) {
          const retryAfter = res.headers.get('retry-after')
          const delayMs = computeBackoffMs(attempt, retryAfter)
          logger.warn(
            {
              jobId,
              url,
              finalUrl,
              filePath,
              status,
              statusText,
              retryAfter,
              attempt: attempt + 1,
              attemptsLeft,
              delayMs
            },
            'Stem download retryable error, backing off'
          )
          // Drain body so the connection can be released to the pool before
          // we sleep — otherwise node-fetch holds the socket open.
          try {
            body?.resume()
          } catch {
            /* best effort */
          }
          await sleep(delayMs, signal)
          continue
        }

        // Parallel downloads log "Downloading stem file" in arbitrary order; this line
        // is the definitive record of which URL failed.
        logger.error(
          { jobId, url, finalUrl, filePath, status, statusText },
          'Stem download failed (HTTP error)'
        )
        throw new Error(
          `Failed to download stem: ${statusText} (${status}) — ${filePath}`
        )
      }

      if (!body) {
        logger.error(
          { jobId, url, finalUrl, filePath, status },
          'Stem download failed (empty body)'
        )
        throw new Error(`Response body is null — ${filePath}`)
      }

      const fileStream = fsSync.createWriteStream(filePath)
      await new Promise((resolve, reject) => {
        body.pipe(fileStream)
        body.on('error', reject)
        fileStream.on('error', reject)
        fileStream.on('finish', resolve)
      })

      return filePath
    }

    // Unreachable: the loop either returns on success or throws on the final
    // non-retryable failure. This line satisfies the compiler and guards
    // against future edits that break that invariant.
    throw new Error(
      `Failed to download stem after ${MAX_DOWNLOAD_ATTEMPTS} attempts — ${filePath}`
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
