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

export const getOrCreateStemsArchiveJob = async (
  data: Omit<StemsArchiveJobData, 'jobId'>
) => {
  const config = readConfig()
  const queue = getStemsArchiveQueue()
  const jobId = generateJobId(data)

  const existingJob = await queue.getJob(jobId)
  if (existingJob) {
    const state = await existingJob.getState()
    if (state !== 'failed') {
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
