import dotenv from 'dotenv'
import { initAudiusLibs } from './libs'
import { Ok, type Result } from 'ts-results'
import { logger } from './logger'

export type SharedData = {
  libs: Awaited<ReturnType<typeof initAudiusLibs>>
  dryRun: boolean
}

export const initSharedData = async (): Promise<Result<SharedData, unknown>> => {
  dotenv.config({ path: './.env' })
  const libs = await initAudiusLibs()
  const dryRun = process.env.dryRun === 'true'
  logger.info(`Dry run: ${dryRun}`)
  return new Ok({ libs, dryRun })
}
