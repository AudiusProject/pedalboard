import { sdk, AudiusSdk, TracksApi } from '@audius/sdk'
import { readConfig, Environment } from './config'

const environmentToSdkEnvironment: Record<
  Environment,
  'development' | 'production'
> = {
  dev: 'development',
  prod: 'production'
}

// The published sdk()/createSdk type annotations declare `tracks` as the
// *generated* TracksApi, but at runtime createSdk instantiates the extended
// TracksApi (which adds getTrackDownloadUrl and friends — it's also what the
// package root exports as `TracksApi`). Patch the type at this boundary so
// callers see the methods that actually exist.
type ArchiverAudiusSdk = Omit<AudiusSdk, 'tracks'> & { tracks: TracksApi }

let audiusSdk: ArchiverAudiusSdk | undefined = undefined

export const getAudiusSdk = () => {
  if (audiusSdk === undefined) {
    const config = readConfig()
    // Passing apiKey here makes the SDK's addAppInfoMiddleware append
    // `?api_key=<key>` to every outbound request, so getTrack/getTrackStems/
    // inspectTrack land in the configured app's rps/rpm bucket on the server's
    // rate-limit middleware. The raw downloadFile fetch (which bypasses the
    // SDK entirely) attaches api_key itself — see downloadFile in utils.ts.
    audiusSdk = sdk({
      appName: 'audius-archiver',
      environment: environmentToSdkEnvironment[config.environment],
      apiKey: config.apiKey
    }) as unknown as ArchiverAudiusSdk
  }
  return audiusSdk
}
