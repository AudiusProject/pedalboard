import cron from 'node-cron'
import { App } from '@pedalboard/basekit'
import { createLogger } from '@pedalboard/logger'
import { SharedData, initSharedData } from './config'
import { disburseTrendingRewards } from './rewards'
import { establishSlackConnection } from './slack'
import { announceTopFiveTrending } from './trending'

const logger = createLogger('trending-challenge-rewards')

const onDemandRun = async (app: App<SharedData>) => {
  // Run on demand only if runNow is true
  const { runNow } = app.viewAppData()
  if (runNow) {
    // Uncomment to also announce to slack
    // await announceTopFiveTrending(app)
    await disburseTrendingRewards(app)
  }
}

export const main = async () => {
  const data = await initSharedData()

  await new App<SharedData>({ appData: data })
    .task(establishSlackConnection)
    .task(onDemandRun)
    .run()
}

// Friday at 12:15 pm PST, extra minutes for trending to calculate
cron.schedule(
  '15 12 * * 5',
  () => {
    initSharedData().then((data) => {
      // make new appdata instance to satisfy types
      const appData = new App<SharedData>({ appData: data })
      appData.updateAppData((data) => {
        data.dryRun = false
        return data
      })
      announceTopFiveTrending(appData).catch((e) =>
        logger.error({ err: e }, 'Announcement failed')
      )
      disburseTrendingRewards(appData).catch((e) =>
        logger.error({ err: e }, 'Disbursment failed')
      )
    })
  },
  {
    timezone: 'America/Los_Angeles'
  }
)
