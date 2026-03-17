import cors from 'cors'
import express from 'express'
import { readConfig } from './config'
import { stemsRouter } from './routes/stems'
import { startStemsArchiveWorker } from './workers/createStemsArchive/createStemsArchive'
import { startCleanupOrphanedFilesWorker } from './workers/cleanupOrphanedFiles'
import { scheduleCleanupOrphanedFilesJob } from './jobs/cleanupOrphanedFiles'
import { getStemsArchiveQueue } from './jobs/createStemsArchive'
import { getCleanupOrphanedFilesQueue } from './jobs/cleanupOrphanedFiles'
import { logger, httpLogger } from './logger'
import { createDefaultWorkerServices } from './workers/services'
import { ensureTempDirectory } from './workers/ensureTempDirectory'

const health = (_req: express.Request, res: express.Response) => {
  res.json({ status: 'healthy' })
}

const main = async () => {
  const config = readConfig()

  try {
    await getStemsArchiveQueue().obliterate({ force: true })
    await getCleanupOrphanedFilesQueue().obliterate({ force: true })
  } catch (error) {
    logger.error({ error }, 'Error clearing queues')
  }

  const services = createDefaultWorkerServices()
  await ensureTempDirectory(services)

  const {
    worker: stemsWorker,
    removeStemsArchiveJob,
    cancelStemsArchiveJob
  } = startStemsArchiveWorker(services)
  const cleanupWorker = startCleanupOrphanedFilesWorker(services)

  await scheduleCleanupOrphanedFilesJob()

  const app = express()
  app.use(cors())

  app.get('/archive/health_check', health)
  app.use(httpLogger)
  app.use(
    '/archive/stems',
    stemsRouter({ removeStemsArchiveJob, cancelStemsArchiveJob })
  )

  app.listen(config.serverPort, config.serverHost, () => {
    logger.info(
      { serverHost: config.serverHost, serverPort: config.serverPort },
      'Server initialized'
    )
  })

  const shutdown = async () => {
    logger.info('Shutting down gracefully...')
    await Promise.all([stemsWorker.close(), cleanupWorker.close()])
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled promise rejection')
})

main().catch((error: unknown) => {
  logger.error({ error }, 'Error starting archiver')
  process.exit(1)
})
