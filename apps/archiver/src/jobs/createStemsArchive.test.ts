import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockQueue = {
  getJob: vi.fn(),
  add: vi.fn()
}

vi.mock('bullmq', () => ({
  // `new Queue(...)` in getStemsArchiveQueue needs a real constructor;
  // returning an object from one hands back the shared mock.
  Queue: class {
    constructor() {
      return mockQueue
    }
  }
}))

const STALE_JOB_SECONDS = 900

vi.mock('../config', () => ({
  readConfig: () => ({
    redisUrl: 'redis://localhost:6379',
    maxStemsArchiveAttempts: 3,
    orphanedJobsLifetimeSeconds: 600,
    staleJobSeconds: STALE_JOB_SECONDS
  })
}))

import {
  getOrCreateStemsArchiveJob,
  isStaleJob,
  generateJobId
} from './createStemsArchive'

const STALE_MS = STALE_JOB_SECONDS * 1000

const jobData = {
  trackId: 1595511751,
  userId: 700900251,
  messageHeader: 'signature:1785215370374',
  signatureHeader: '0xdeadbeef',
  includeParentTrack: false
}

const makeJob = ({
  state,
  timestamp,
  processedOn
}: {
  state: string
  timestamp?: number
  processedOn?: number
}) => ({
  getState: vi.fn().mockResolvedValue(state),
  remove: vi.fn().mockResolvedValue(undefined),
  timestamp,
  processedOn,
  progress: 0,
  failedReason: undefined,
  returnvalue: undefined
})

describe('isStaleJob', () => {
  const now = 1_000_000_000

  it('is false for a job that was picked up recently', () => {
    expect(
      isStaleJob({ processedOn: now - 1000, timestamp: now - 5000 }, STALE_MS, now)
    ).toBe(false)
  })

  it('is true once the job has been running past the threshold', () => {
    expect(
      isStaleJob(
        { processedOn: now - (STALE_MS + 1), timestamp: now - STALE_MS * 2 },
        STALE_MS,
        now
      )
    ).toBe(true)
  })

  it('falls back to queue time for a job that never started', () => {
    // The wedged-worker case: parked in `waiting`, so no processedOn at all.
    expect(
      isStaleJob(
        { processedOn: undefined, timestamp: now - (STALE_MS + 1) },
        STALE_MS,
        now
      )
    ).toBe(true)
    expect(
      isStaleJob({ processedOn: undefined, timestamp: now - 1000 }, STALE_MS, now)
    ).toBe(false)
  })

  it('prefers processedOn over timestamp', () => {
    // Queued long ago but picked up just now — actively being worked, not stale.
    expect(
      isStaleJob(
        { processedOn: now - 1000, timestamp: now - STALE_MS * 10 },
        STALE_MS,
        now
      )
    ).toBe(false)
  })

  it('treats a job with no usable timestamp as fresh', () => {
    expect(
      isStaleJob({ processedOn: undefined, timestamp: undefined }, STALE_MS, now)
    ).toBe(false)
  })
})

describe('getOrCreateStemsArchiveJob', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockQueue.add.mockImplementation(async () =>
      makeJob({ state: 'waiting', timestamp: Date.now() })
    )
  })

  it('returns a completed job instead of rebuilding the archive', async () => {
    const existing = makeJob({
      state: 'completed',
      timestamp: Date.now() - STALE_MS * 10
    })
    mockQueue.getJob.mockResolvedValue(existing)

    const status = await getOrCreateStemsArchiveJob(jobData)

    expect(existing.remove).not.toHaveBeenCalled()
    expect(mockQueue.add).not.toHaveBeenCalled()
    expect(status.state).toBe('completed')
  })

  it('rejoins an in-flight job that is still making progress', async () => {
    const existing = makeJob({
      state: 'active',
      timestamp: Date.now() - 5000,
      processedOn: Date.now() - 5000
    })
    mockQueue.getJob.mockResolvedValue(existing)

    await getOrCreateStemsArchiveJob(jobData)

    // Dedupes double-clicks and multiple tabs onto the same job.
    expect(existing.remove).not.toHaveBeenCalled()
    expect(mockQueue.add).not.toHaveBeenCalled()
  })

  it('replaces a job wedged in waiting past the stale threshold', async () => {
    // The 2026-07-28 outage: worker lost its Redis lock, held every slot, and
    // jobs sat in `waiting` forever. Retry used to be handed this same job.
    const existing = makeJob({
      state: 'waiting',
      timestamp: Date.now() - (STALE_MS + 60_000)
    })
    mockQueue.getJob.mockResolvedValue(existing)

    await getOrCreateStemsArchiveJob(jobData)

    expect(existing.remove).toHaveBeenCalledOnce()
    expect(mockQueue.add).toHaveBeenCalledOnce()
  })

  it('replaces a job stuck in active past the stale threshold', async () => {
    const existing = makeJob({
      state: 'active',
      timestamp: Date.now() - STALE_MS * 3,
      processedOn: Date.now() - (STALE_MS + 1000)
    })
    mockQueue.getJob.mockResolvedValue(existing)

    await getOrCreateStemsArchiveJob(jobData)

    expect(existing.remove).toHaveBeenCalledOnce()
    expect(mockQueue.add).toHaveBeenCalledOnce()
  })

  it('still replaces a failed job regardless of age', async () => {
    const existing = makeJob({ state: 'failed', timestamp: Date.now() })
    mockQueue.getJob.mockResolvedValue(existing)

    await getOrCreateStemsArchiveJob(jobData)

    expect(existing.remove).toHaveBeenCalledOnce()
    expect(mockQueue.add).toHaveBeenCalledOnce()
  })

  it('creates a job when none exists, keyed by the deterministic id', async () => {
    mockQueue.getJob.mockResolvedValue(null)

    await getOrCreateStemsArchiveJob(jobData)

    const expectedId = generateJobId({
      userId: jobData.userId,
      trackId: jobData.trackId
    })
    expect(mockQueue.add).toHaveBeenCalledOnce()
    expect(mockQueue.add.mock.calls[0][2]).toMatchObject({ jobId: expectedId })
  })
})
