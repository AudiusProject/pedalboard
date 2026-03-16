import { log } from '@pedalboard/logger'
import { App, initializeDiscoveryDb } from '@pedalboard/basekit'
import { getConfig } from './config'
import { logger } from './logger'
import { backfillDiscovery } from './backfill_discovery'

export const config = getConfig()

const main = async (): Promise<void> => {
  const discoveryDb = initializeDiscoveryDb(process.env.audius_db_url)
  await new App({ discoveryDb }).task(backfillDiscovery).run()
  process.exit(0)
}

main().catch(logger.error.bind(logger))
main().catch(log)
