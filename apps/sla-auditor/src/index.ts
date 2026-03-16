import { log } from '@pedalboard/logger'
import { App, initializeDiscoveryDb } from '@pedalboard/basekit'
import type { SharedData } from './config'
import { initSharedData } from './config'
import { createTables } from './db'
import { audit } from './audit'
import { logger } from './logger'

const main = async (): Promise<void> => {
  const dataRes = await initSharedData()
  if (dataRes.err) {
    logger.error({ err: dataRes }, 'SETUP ERROR')
    return
  }
  const data = dataRes.val
  const discoveryDb = initializeDiscoveryDb(process.env.audius_db_url)
  await new App<SharedData>({ discoveryDb, appData: data })
    .task(createTables)
    .tick({ minutes: 10 }, audit)
    .run()
}

main().catch(log)
