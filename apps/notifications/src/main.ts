import { Knex, knex } from 'knex'
import moment from 'moment-timezone'
import { log } from '@pedalboard/logger'
import { App, initializeDiscoveryDb } from '@pedalboard/basekit'

import { config } from './config'
import { logger } from './logger'
import { setupTriggers } from './setup'
import { getDB } from './conn'
import {
  PendingUpdates,
  Listener,
  getNotificationById,
  type ListenerAdapter
} from './listener'
import {
  updateBadgeCount,
  NotificationSeenListener
} from './notificationSeenListener'
import { AppNotificationsProcessor } from './processNotifications/indexAppNotifications'
import { sendDMNotifications } from './tasks/dmNotifications'
import { processEmailNotifications } from './email/notifications/index'
import { sendAppNotifications } from './tasks/appNotifications'
import {
  BrowserPluginMappings,
  BrowserPushPlugin,
  EmailPluginMappings,
  NotificationsEmailPlugin,
  RemoteConfig
} from './remoteConfig'
import { Server } from './server'
import { configureWebPush } from './web'
import { logMemStats } from './utils/memStats'

/** Legacy Processor class for test harness (init/start/close + discoveryDB, listener, server, etc.). */
export class Processor {
  discoveryDB: Knex
  identityDB: Knex
  appNotificationsProcessor: AppNotificationsProcessor
  isRunning: boolean
  listener: Listener
  notificationSeenListener: NotificationSeenListener
  lastDailyEmailSent: moment.Moment | null
  lastWeeklyEmailSent: moment.Moment | null
  remoteConfig: RemoteConfig
  server: Server

  constructor() {
    this.isRunning = false
    this.lastDailyEmailSent = null
    this.lastWeeklyEmailSent = null
    this.remoteConfig = new RemoteConfig()
    this.server = new Server()
    this.discoveryDB = null as unknown as Knex
    this.identityDB = null as unknown as Knex
    this.appNotificationsProcessor =
      null as unknown as AppNotificationsProcessor
    this.listener = null as unknown as Listener
    this.notificationSeenListener = null as unknown as NotificationSeenListener
  }

  init = async ({
    discoveryDBUrl,
    identityDBUrl
  }: {
    discoveryDBUrl?: string
    identityDBUrl?: string
  } = {}) => {
    await this.remoteConfig.init()

    logger.info('starting up!!!')

    const discoveryDBConnection = discoveryDBUrl ?? process.env.DN_DB_URL
    const identityDBConnection = identityDBUrl ?? process.env.IDENTITY_DB_URL
    this.discoveryDB = getDB(discoveryDBConnection!)
    this.identityDB = getDB(identityDBConnection!)

    configureWebPush()
    logMemStats()

    this.listener = new Listener()
    await this.listener.start(discoveryDBConnection ?? process.env.DN_DB_URL!)

    this.notificationSeenListener = new NotificationSeenListener(
      this.identityDB
    )
    await this.notificationSeenListener.start(
      discoveryDBConnection ?? process.env.DN_DB_URL!
    )

    await setupTriggers(this.discoveryDB)
    this.appNotificationsProcessor = new AppNotificationsProcessor(
      this.discoveryDB,
      this.identityDB,
      this.remoteConfig
    )
    await this.server.init(this.identityDB)
  }

  getIsScheduledEmailEnabled() {
    const isEnabled = this.remoteConfig.getFeatureVariableEnabled(
      NotificationsEmailPlugin,
      EmailPluginMappings.Scheduled
    )
    return Boolean(isEnabled)
  }

  getIsBrowserPushEnabled(): boolean {
    const isEnabled = this.remoteConfig.getFeatureVariableEnabled(
      BrowserPushPlugin,
      BrowserPluginMappings.Enabled
    )
    return Boolean(isEnabled)
  }

  start = async () => {
    logger.info('processing events')
    this.isRunning = true
    while (this.isRunning) {
      logger.debug('Processing app notifications (new)')
      await sendAppNotifications(this.listener, this.appNotificationsProcessor)
      logger.debug('Processing app notifications (needs reprocessing)')
      await this.appNotificationsProcessor.reprocess()

      logger.debug('Processing DM notifications')
      await sendDMNotifications(
        this.discoveryDB,
        this.identityDB,
        this.getIsBrowserPushEnabled()
      )

      if (
        this.getIsScheduledEmailEnabled() &&
        (!this.lastDailyEmailSent ||
          this.lastDailyEmailSent < moment.utc().subtract(1, 'days'))
      ) {
        logger.info('Processing daily emails...')
        processEmailNotifications(
          this.discoveryDB,
          this.identityDB,
          'daily',
          this.remoteConfig
        )
        this.lastDailyEmailSent = moment.utc()
      }

      if (
        this.getIsScheduledEmailEnabled() &&
        (!this.lastWeeklyEmailSent ||
          this.lastWeeklyEmailSent < moment.utc().subtract(7, 'days'))
      ) {
        logger.info('Processing weekly emails')
        processEmailNotifications(
          this.discoveryDB,
          this.identityDB,
          'weekly',
          this.remoteConfig
        )
        this.lastWeeklyEmailSent = moment.utc()
      }
      await new Promise((r) => setTimeout(r, config.pollInterval))
    }
  }

  stop = () => {
    logger.info('stopping notification processor')
    this.isRunning = false
  }

  close = async () => {
    this.remoteConfig.close()
    await this.listener?.close()
    await this.notificationSeenListener?.close()
    await this.discoveryDB?.destroy()
    await this.identityDB?.destroy()
  }
}

export type NotificationsAppData = {
  remoteConfig: RemoteConfig
  appNotificationsProcessor: AppNotificationsProcessor
  listenerPending: PendingUpdates
  lastDailyEmailSent: moment.Moment | null
  lastWeeklyEmailSent: moment.Moment | null
}

function getIsScheduledEmailEnabled(remoteConfig: RemoteConfig): boolean {
  const isEnabled = remoteConfig.getFeatureVariableEnabled(
    NotificationsEmailPlugin,
    EmailPluginMappings.Scheduled
  )
  return Boolean(isEnabled)
}

function getIsBrowserPushEnabled(remoteConfig: RemoteConfig): boolean {
  const isEnabled = remoteConfig.getFeatureVariableEnabled(
    BrowserPushPlugin,
    BrowserPluginMappings.Enabled
  )
  return Boolean(isEnabled)
}

async function main() {
  const discoveryDbUrl = process.env.DN_DB_URL
  const identityDbUrl =
    process.env.IDENTITY_DB_URL ??
    process.env.identity_db_url ??
    'postgresql://postgres:postgres@db:5432/audius_identity_service'

  const discoveryDb = initializeDiscoveryDb(discoveryDbUrl)
  // Identity DB with larger pool to avoid KnexTimeoutError when many
  // notification_seen events (badge updates) run alongside tick-loop work.
  const identityDb: Knex = knex({
    client: 'pg',
    connection: identityDbUrl,
    pool: {
      min: 2,
      max: Number(process.env.IDENTITY_DB_POOL_MAX) || 30,
      acquireTimeoutMillis: 30000
    }
  })

  const remoteConfig = new RemoteConfig()
  await remoteConfig.init()

  logger.info('starting up!!!')

  configureWebPush()
  logMemStats()

  await setupTriggers(discoveryDb)

  const appNotificationsProcessor = new AppNotificationsProcessor(
    discoveryDb,
    identityDb,
    remoteConfig
  )

  const listenerPending = new PendingUpdates()
  const appData: NotificationsAppData = {
    remoteConfig,
    appNotificationsProcessor,
    listenerPending,
    lastDailyEmailSent: null,
    lastWeeklyEmailSent: null
  }

  const server = new Server()

  const app = new App<NotificationsAppData>({
    discoveryDb,
    identityDb,
    appData
  })

  app
    .listen('notification', async (self, msg: { notification_id: number }) => {
      const row = await getNotificationById(self.getDnDb(), msg.notification_id)
      if (row !== null) {
        const data = self.viewAppData()
        data.listenerPending.appNotifications.push(row)
      }
    })
    .listen('notification_seen', async (self, msg: { user_id: number }) => {
      await updateBadgeCount(self.getIdDb(), msg.user_id)
    })
    .tick({ milliseconds: config.pollInterval }, async (self) => {
      const listenerAdapter: ListenerAdapter = {
        takePending: () => {
          let result: PendingUpdates | undefined
          self.updateAppData((d) => {
            if (d.listenerPending.isEmpty()) {
              result = undefined
              return d
            }
            result = d.listenerPending
            return { ...d, listenerPending: new PendingUpdates() }
          })
          return result
        }
      }

      const data = self.viewAppData()
      logger.debug('Processing app notifications (new)')
      await sendAppNotifications(
        listenerAdapter,
        data.appNotificationsProcessor
      )
      logger.debug('Processing app notifications (needs reprocessing)')
      await data.appNotificationsProcessor.reprocess()

      logger.debug('Processing DM notifications')
      await sendDMNotifications(
        self.getDnDb(),
        self.getIdDb(),
        getIsBrowserPushEnabled(data.remoteConfig)
      )

      if (
        getIsScheduledEmailEnabled(data.remoteConfig) &&
        (!data.lastDailyEmailSent ||
          data.lastDailyEmailSent < moment.utc().subtract(1, 'days'))
      ) {
        logger.info('Processing daily emails...')
        processEmailNotifications(
          self.getDnDb(),
          self.getIdDb(),
          'daily',
          data.remoteConfig
        )
        self.updateAppData((d) => ({ ...d, lastDailyEmailSent: moment.utc() }))
      }

      if (
        getIsScheduledEmailEnabled(data.remoteConfig) &&
        (!data.lastWeeklyEmailSent ||
          data.lastWeeklyEmailSent < moment.utc().subtract(7, 'days'))
      ) {
        logger.info('Processing weekly emails')
        processEmailNotifications(
          self.getDnDb(),
          self.getIdDb(),
          'weekly',
          data.remoteConfig
        )
        self.updateAppData((d) => ({
          ...d,
          lastWeeklyEmailSent: moment.utc()
        }))
      }
    })
    .task(async () => {
      await server.init(identityDb)
    })

  logger.info('processing events')
  await app.run()
}

if (require.main === module) {
  main().catch((e) => {
    logger.fatal(e, 'save me pm2')
    log(e)
    process.exit(1)
  })
}

process
  .on('unhandledRejection', (reason, promise) => {
    logger.error({ reason, promise }, 'unhandledRejection')
  })
  .on('uncaughtException', (err) => {
    logger.fatal(err, 'uncaughtException')
    process.exit(1)
  })
