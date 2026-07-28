import { Job, JobState, Queue } from 'bullmq'
import { readConfig } from '../config'
import { STEMS_ARCHIVE_QUEUE_NAME } from '../constants'

export interface StemsArchiveJobData {
  jobId: string
  trackId: number
  userId: number
  messageHeader: string
  signatureHeader: string
  includeParentTrack: boolean
}

export interface StemsArchiveJobResult {
  outputFile: string
}

export interface JobStatus {
  id: string
  state: JobState | 'unknown'
  progress?: number
  failedReason?: string
  returnvalue?: StemsArchiveJobResult
}

export const generateJobId = ({
  userId,
  trackId
}: {
  userId: number
  trackId: number
}): string => {
  const input = `${userId}-${trackId}`
  return Buffer.from(input).toString('base64url')
}

let queue: Queue<StemsArchiveJobData, StemsArchiveJobResult> | null = null

export const getStemsArchiveQueue = () => {
  if (!queue) {
    const config = readConfig()
    queue = new Queue<StemsArchiveJobData, StemsArchiveJobResult>(
      STEMS_ARCHIVE_QUEUE_NAME,
      {
        connection: {
          url: config.redisUrl
        },
        defaultJobOptions: {
          removeOnComplete: {
            age: config.orphanedJobsLifetimeSeconds
          },
          removeOnFail: {
            age: 60
          }
        }
      }
    )
  }
  return queue
}

const getJobStatus = async (
  jobId: string,
  job: Job<StemsArchiveJobData, StemsArchiveJobResult>
): Promise<JobStatus> => {
  const state = await job.getState()
  const failedReason = job.failedReason
  const returnvalue = job.returnvalue
  const progress = typeof job.progress === 'number' ? job.progress : undefined

  return {
    id: jobId,
    state,
    progress,
    ...(failedReason && { failedReason }),
    ...(returnvalue && { returnvalue })
  }
}

/**
 * Whether a job has been sitting in a non-terminal state long enough that we
 * should assume nobody is going to finish it.
 *
 * Measured from when the job was last picked up, falling back to when it was
 * queued — a job wedged in `waiting` never gets a `processedOn` at all, and
 * that is the case we most need to catch.
 */
export const isStaleJob = (
  // Deliberately wider than bullmq's `Job`, which types `timestamp` as always
  // present. These come back off a Redis hash that a previous process wrote,
  // so treat both fields as possibly missing rather than trusting the type.
  job: { processedOn?: number | null; timestamp?: number | null },
  staleAfterMs: number,
  now: number = Date.now()
): boolean => {
  const startedAt = job.processedOn ?? job.timestamp
  if (typeof startedAt !== 'number') {
    // No usable timestamp — treat as fresh rather than churning a live job.
    return false
  }
  return now - startedAt > staleAfterMs
}

export const getOrCreateStemsArchiveJob = async (
  data: Omit<StemsArchiveJobData, 'jobId'>
) => {
  const config = readConfig()
  const queue = getStemsArchiveQueue()
  const jobId = generateJobId(data)

  const existingJob = await queue.getJob(jobId)
  if (existingJob) {
    const state = await existingJob.getState()

    // Completed means the archive is on disk waiting to be collected — hand
    // it straight back so the client downloads it instead of rebuilding it.
    if (state === 'completed') {
      return getJobStatus(jobId, existingJob)
    }

    // Job ids are deterministic (`{userId}-{trackId}`), so a user retrying the
    // same track always lands on their existing job. Rejoining it is right
    // while it's making progress — that's what dedupes double-clicks and
    // multiple tabs — but it's a trap once the job can no longer finish. A
    // worker that died or lost its Redis lock leaves the job parked in
    // `waiting`/`active` forever, and because that isn't `failed`, every
    // retry used to be handed the same dead job. Retry was a no-op and the
    // download was unrecoverable from the client. Replace it instead.
    if (
      state !== 'failed' &&
      !isStaleJob(existingJob, config.staleJobSeconds * 1000)
    ) {
      return getJobStatus(jobId, existingJob)
    }

    await existingJob.remove()
  }

  const job = await queue.add(
    STEMS_ARCHIVE_QUEUE_NAME,
    { ...data, jobId },
    {
      jobId,
      attempts: config.maxStemsArchiveAttempts,
      backoff: {
        type: 'exponential',
        delay: 1000
      }
    }
  )

  return getJobStatus(jobId, job)
}

export const getStemsArchiveJob = async (
  jobId: string
): Promise<JobStatus | null> => {
  const queue = getStemsArchiveQueue()
  const job = await queue.getJob(jobId)

  if (!job) {
    return null
  }

  return getJobStatus(jobId, job)
}
