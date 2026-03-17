import { sdk } from '@audius/sdk'
import { readConfig, Environment } from './config'

const environmentToSdkEnvironment: Record<
  Environment,
  'development' | 'production'
> = {
  dev: 'development',
  prod: 'production'
}

let audiusSdk: ReturnType<typeof sdk> | undefined = undefined

export const getAudiusSdk = () => {
  if (audiusSdk === undefined) {
    const config = readConfig()
    audiusSdk = sdk({
      appName: 'audius-client',
      environment: environmentToSdkEnvironment[config.environment]
    })
  }
  return audiusSdk
}
