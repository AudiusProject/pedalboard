import { createSdkWithServices } from '@audius/sdk'
import { readConfig, Environment } from './config'

const environmentToSdkEnvironment: Record<
  Environment,
  'development' | 'production'
> = {
  dev: 'development',
  prod: 'production'
}

let audiusSdk: ReturnType<typeof createSdkWithServices> | undefined = undefined

export const getAudiusSdk = () => {
  if (audiusSdk === undefined) {
    const config = readConfig()
    // Passing apiKey here makes the SDK's addAppInfoMiddleware append
    // `?api_key=<key>` to every outbound request, so getTrack/getTrackStems/
    // inspectTrack land in the configured app's rps/rpm bucket on the server's
    // rate-limit middleware. The raw downloadFile fetch (which bypasses the
    // SDK entirely) attaches api_key itself — see downloadFile in utils.ts.
    // Use createSdkWithServices (not sdk()) so tracks.getTrackDownloadUrl is
    // available — the bare sdk() factory exposes only the generated TracksApi.
    audiusSdk = createSdkWithServices({
      appName: 'audius-archiver',
      environment: environmentToSdkEnvironment[config.environment],
      apiKey: config.apiKey
    })
  }
  return audiusSdk
}
