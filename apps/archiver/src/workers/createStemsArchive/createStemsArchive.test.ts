import { Job } from 'bullmq'
import archiver from 'archiver'
import fs from 'fs/promises'
import fsSync from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Config } from '../../config'
import {
  StemsArchiveJobData,
  StemsArchiveJobResult
} from '../../jobs/createStemsArchive'
import { createSpaceManager } from '../spaceManager'
import { WorkerServices } from '../services'

import { createStemsArchiveWorker } from './createStemsArchive'

const PARENT_ID = 'PARENT'
const STEM_IDS = ['STEM1', 'STEM2']

type FetchBehavior = {
  /** Track ids whose canonical download URL should 404 on every mirror. */
  brokenTrackIds?: string[]
  /** Track ids whose /download endpoint should fail to resolve entirely. */
  unresolvableTrackIds?: string[]
  /** Origins whose cidstream endpoint should 404 for every track. */
  brokenHosts?: string[]
}

// Stand-in for node-fetch: /v1/tracks/{id}/download resolves to a 302 whose
// Location keeps the track id in the path (like the real signed cidstream
// URL), and mirror fetches stream a small body — or 404, per behavior.
const createMockFetch = (behavior: FetchBehavior = {}) => {
  const mockFetch = async (url: string) => {
    const downloadMatch = url.match(/\/v1\/tracks\/([^/]+)\/download/)
    if (downloadMatch) {
      const trackId = downloadMatch[1]
      if (behavior.unresolvableTrackIds?.includes(trackId)) {
        return {
          status: 404,
          statusText: 'Not Found',
          headers: { get: () => null },
          body: undefined
        }
      }
      return {
        status: 302,
        statusText: 'Found',
        headers: {
          get: (header: string) =>
            header === 'location'
              ? `https://mirror-a.test/tracks/cidstream/${trackId}?signature=sig`
              : null
        },
        body: undefined
      }
    }

    const cidstreamMatch = url.match(/\/tracks\/cidstream\/([^?/]+)/)
    if (cidstreamMatch) {
      const trackId = cidstreamMatch[1]
      if (
        behavior.brokenTrackIds?.includes(trackId) ||
        behavior.brokenHosts?.includes(new URL(url).origin)
      ) {
        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          body: { resume: () => {} }
        }
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: Readable.from(Buffer.from(`audio-bytes-${trackId}`))
      }
    }

    throw new Error(`Unexpected fetch in test: ${url}`)
  }
  return vi.fn(mockFetch) as unknown as WorkerServices['fetch']
}

// Origins of all cidstream requests made through the (vi.fn-wrapped) mock fetch.
const cidstreamOrigins = (fetch: WorkerServices['fetch']): string[] =>
  (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes('/tracks/cidstream/'))
    .map((url) => new URL(url).origin)

const createMockSdk = ({
  parentInspectFails = false
}: { parentInspectFails?: boolean } = {}) => {
  const sdk = {
    tracks: {
      // No download/stream fields: the pinned @audius/sdk (10.0.0) drops them
      // during deserialization, so at runtime the archiver never sees mirrors.
      // The mock must mirror that or it hides the empty-mirror-list path
      // (2026-07-16 stems incident).
      getTrack: vi.fn(async () => ({
        data: {
          id: PARENT_ID,
          title: 'Parent Track',
          isDownloadable: true,
          origFilename: 'parent.wav'
        }
      })),
      getTrackStems: vi.fn(async () => ({
        data: STEM_IDS.map((id) => ({ id, origFilename: `${id}.wav` }))
      })),
      inspectTrack: vi.fn(async ({ trackId }: { trackId: string }) => {
        if (parentInspectFails && trackId === PARENT_ID) {
          return { data: undefined }
        }
        return { data: { size: 64 } }
      }),
      getTrackDownloadUrl: vi.fn(
        async ({ trackId }: { trackId: string }) =>
          `https://api.test/v1/tracks/${trackId}/download`
      )
    }
  }
  return sdk as unknown as WorkerServices['sdk']
}

const createMockLogger = () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => mockLogger
  }
  return mockLogger
}

describe('createStemsArchiveWorker parent-track handling', () => {
  let tmpDir: string
  let mockLogger: ReturnType<typeof createMockLogger>

  const createServices = ({
    fetchBehavior,
    parentInspectFails
  }: {
    fetchBehavior?: FetchBehavior
    parentInspectFails?: boolean
  } = {}): WorkerServices => {
    const config = {
      archiverTmpDir: tmpDir,
      maxDiskSpaceWaitSeconds: 5
    } as Config
    return {
      archiver,
      config,
      fetch: createMockFetch(fetchBehavior),
      spaceManager: createSpaceManager({
        maxSpaceBytes: 1024 * 1024,
        logger: mockLogger as unknown as WorkerServices['logger']
      }),
      fs,
      fsSync,
      path,
      sdk: createMockSdk({ parentInspectFails }),
      logger: mockLogger as unknown as WorkerServices['logger']
    }
  }

  const createJob = () =>
    ({
      data: {
        jobId: 'test-job',
        trackId: 123,
        userId: 456,
        messageHeader: 'message',
        signatureHeader: 'signature',
        includeParentTrack: true
      }
    }) as Job<StemsArchiveJobData, StemsArchiveJobResult>

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archiver-test-'))
    mockLogger = createMockLogger()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('includes the parent track when it downloads successfully', async () => {
    const { processJob } = createStemsArchiveWorker(createServices())

    const result = await processJob(createJob())

    expect(result.outputFile).toMatch(/Parent Track\.zip$/)
    expect(fsSync.existsSync(result.outputFile)).toBe(true)
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/Skipping parent track/)
    )
  })

  it('still produces a stems-only archive when every mirror 404s the parent', async () => {
    const { processJob } = createStemsArchiveWorker(
      createServices({ fetchBehavior: { brokenTrackIds: [PARENT_ID] } })
    )

    const result = await processJob(createJob())

    expect(fsSync.existsSync(result.outputFile)).toBe(true)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ parentTrackId: PARENT_ID }),
      'Skipping parent track: download failed'
    )
  })

  it('still produces a stems-only archive when the parent download URL cannot be resolved', async () => {
    const { processJob } = createStemsArchiveWorker(
      createServices({ fetchBehavior: { unresolvableTrackIds: [PARENT_ID] } })
    )

    const result = await processJob(createJob())

    expect(fsSync.existsSync(result.outputFile)).toBe(true)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ parentTrackId: PARENT_ID }),
      'Skipping parent track: download failed'
    )
  })

  it('skips the parent up front when its original file cannot be inspected', async () => {
    const services = createServices({ parentInspectFails: true })
    const { processJob } = createStemsArchiveWorker(services)

    const result = await processJob(createJob())

    expect(fsSync.existsSync(result.outputFile)).toBe(true)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ parentTrackId: PARENT_ID }),
      'Skipping parent track: original file not available'
    )
    // The parent must not be downloaded at all in this case
    const sdk = services.sdk as unknown as {
      tracks: { getTrackDownloadUrl: ReturnType<typeof vi.fn> }
    }
    for (const call of sdk.tracks.getTrackDownloadUrl.mock.calls) {
      expect(call[0].trackId).not.toBe(PARENT_ID)
    }
  })

  it('downloads via the canonical redirect host when the SDK provides no mirrors', async () => {
    const services = createServices()
    const { processJob } = createStemsArchiveWorker(services)

    const result = await processJob(createJob())

    expect(fsSync.existsSync(result.outputFile)).toBe(true)
    // Every file must come from the canonical host on the first try — no
    // fallback traffic when the redirect target is healthy.
    const origins = cidstreamOrigins(services.fetch)
    expect(origins.length).toBeGreaterThan(0)
    expect(new Set(origins)).toEqual(new Set(['https://mirror-a.test']))
  })

  it('falls back to the archive node when the canonical host cannot serve the file', async () => {
    const services = createServices({
      fetchBehavior: { brokenHosts: ['https://mirror-a.test'] }
    })
    const { processJob } = createStemsArchiveWorker(services)

    const result = await processJob(createJob())

    expect(fsSync.existsSync(result.outputFile)).toBe(true)
    expect(cidstreamOrigins(services.fetch)).toContain(
      'https://creatornode.audius.co'
    )
  })

  it('still fails the job when a stem download fails', async () => {
    const { processJob } = createStemsArchiveWorker(
      createServices({ fetchBehavior: { brokenTrackIds: [STEM_IDS[0]] } })
    )

    // A stem failure aborts the job's controller to cancel sibling downloads,
    // so the surfaced error is the abort, not the underlying download error.
    await expect(processJob(createJob())).rejects.toThrow('Job aborted')
  })
})
