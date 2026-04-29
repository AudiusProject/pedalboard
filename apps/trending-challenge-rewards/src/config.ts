import { audiusSdk } from './sdk'
import {
  AudiusSdk,
  developmentConfig,
  productionConfig
} from '@audius/sdk'
import dotenv from 'dotenv'

dotenv.config()

export type SharedData = {
  apiEndpoint: string
  sdk: AudiusSdk
  runNow: boolean
  dryRun: boolean
  audiusDbUrl: string
  slackChannel?: string
  slackSigningSecret?: string
  slackBotToken?: string
  slackAppToken?: string
}

let sharedData: SharedData | undefined = undefined

const getApiEndpoint = (
  environment: 'development' | 'production'
) => {
  const sdkConfig =
    environment === 'development'
      ? developmentConfig
      : productionConfig
  return sdkConfig.network.apiEndpoint
}

export const initSharedData = async (): Promise<SharedData> => {
  if (sharedData !== undefined) return sharedData

  sharedData = {
    sdk: audiusSdk({
      environment: process.env.ENVIRONMENT as
        | 'development'
        | 'production',
      solanaRpcEndpoint: process.env.SOLANA_RPC_ENDPOINT,
      solanaRelayNode: process.env.SOLANA_RELAY_NODE!
    }),
    apiEndpoint: getApiEndpoint(
      process.env.ENVIRONMENT as 'development' | 'production'
    ),
    runNow: process.env.RUN_NOW?.toLowerCase() === 'true',
    dryRun: process.env.TCR_DRY_RUN?.toLowerCase() === 'true',
    audiusDbUrl: process.env.AUDIUS_DB_URL!,
    slackChannel: process.env.SLACK_CHANNEL,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackAppToken: process.env.SLACK_APP_TOKEN
  }
  return sharedData
}
