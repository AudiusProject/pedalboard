import { Queue } from 'bullmq'
import { readConfig } from '../config'
import { logger } from '../logger'
import { CLEANUP_ORPHANED_FILES_QUEUE_NAME } from '../constants'

export interface CleanupOrphanedFilesJobData {
  timestamp: number
}

let queue: Queue<CleanupOrphanedFilesJobData, void> | null = null

export const getCleanupOrphanedFilesQueue = () => {
  if (!queue) {
    const config = readConfig()
    queue = new Queue<CleanupOrphanedFilesJobData, void>(
      CLEANUP_ORPHANED_FILES_QUEUE_NAME,
      {
        connection: {
          url: config.redisUrl
        },
        defaultJobOptions: {
          removeOnComplete: true,
          removeOnFail: true
        }
      }
    )
  }
  return queue
}

export const scheduleCleanupOrphanedFilesJob = async () => {
  const config = readConfig()
  const queue = getCleanupOrphanedFilesQueue()

  await queue.add(
    CLEANUP_ORPHANED_FILES_QUEUE_NAME,
    { timestamp: Date.now() },
    {
      repeat: {
        every: config.cleanupOrphanedFilesIntervalSeconds * 1000
      }
    }
  )

  logger.info(
    {
      intervalSeconds: config.cleanupOrphanedFilesIntervalSeconds
    },
    'Scheduled cleanup orphaned files job'
  )
}
