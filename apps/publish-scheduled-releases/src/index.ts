import 'dotenv/config'
import { log } from '@pedalboard/logger'
import { App, initializeDiscoveryDb } from '@pedalboard/basekit'
import { startHealthServer } from './healthServer'
import { logger } from './logger'
import { publishScheduledReleases } from './publish'

const DEFAULT_PORT = 6000

type AppData = { port: number }

const main = async (): Promise<void> => {
  const port = process.env.port
    ? parseInt(process.env.port, 10)
    : DEFAULT_PORT
  const discoveryDb = initializeDiscoveryDb(process.env.audius_db_url)

  await new App<AppData>({ discoveryDb, appData: { port } })
    .task(async () => {
      await startHealthServer(port)
      logger.info({ port }, 'health server listening')
    })
    .tick({ minutes: 1 }, async (self) => {
      await publishScheduledReleases(self.getDnDb(), logger)
    })
    .run()
}

main().catch((err) => {
  logger.error({ err }, 'fatal')
  log(err)
  process.exit(1)
})
