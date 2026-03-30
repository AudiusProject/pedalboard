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
  fetchNotificationsByIds,
  type ListenerAdapter
} from './listener'
import { NotificationSeenListener } from './notificationSeenListener'
import { enqueueNotificationSeenBadgeUpdate } from './utils/notificationSeenBadgeQueue'
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
import { getBuildInfo } from './buildInfo'
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

    logger.info(getBuildInfo(), 'notifications starting')

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
    await this.server.init(this.identityDB, this.discoveryDB)
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
        void processEmailNotifications(
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
        void processEmailNotifications(
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
  /** IDs from pg NOTIFY; hydrated into listenerPending on each tick (one batch query). */
  listenerPendingNotificationIds: number[]
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
  if (discoveryDbUrl === undefined || discoveryDbUrl === '') {
    throw new Error('DN_DB_URL must be set')
  }
  const identityDbUrl =
    process.env.IDENTITY_DB_URL ??
    process.env.identity_db_url ??
    'postgresql://postgres:postgres@db:5432/audius_identity_service'

  // LISTEN holds one discovery pool connection indefinitely; default Knex max
  // is 10, which is too small for NOTIFY bursts + tick work.
  const discoveryDb = initializeDiscoveryDb(discoveryDbUrl, {
    pool: {
      min: 2,
      max: Number(process.env.DISCOVERY_DB_POOL_MAX) || 25,
      acquireTimeoutMillis: 30000
    }
  })
  const identityDb: Knex = knex({
    client: 'pg',
    connection: identityDbUrl,
    pool: {
      min: 2,
      max: Number(process.env.IDENTITY_DB_POOL_MAX) || 50,
      acquireTimeoutMillis: 30000
    }
  })

  const remoteConfig = new RemoteConfig()
  await remoteConfig.init()

  logger.info(getBuildInfo(), 'notifications starting')

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
    listenerPendingNotificationIds: [],
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
      // Do not call Knex here: each NOTIFY would acquire a pool connection; bursts
      // exhaust the pool while reposts/DMs run. IDs are batch-loaded at tick start.
      self.updateAppData((d) => {
        d.listenerPendingNotificationIds.push(msg.notification_id)
        return d
      })
    })
    .listen('notification_seen', async (self, msg: { user_id: number }) => {
      enqueueNotificationSeenBadgeUpdate(self.getIdDb(), msg.user_id)
    })
    .tick({ milliseconds: config.pollInterval }, async (self) => {
      let pendingIds: number[] = []
      self.updateAppData((d) => {
        pendingIds = d.listenerPendingNotificationIds
        d.listenerPendingNotificationIds = []
        return d
      })
      if (pendingIds.length > 0) {
        logger.info(
          { pendingIds, count: pendingIds.length },
          'tick: draining pending notification IDs'
        )
        try {
          const rows = await fetchNotificationsByIds(self.getDnDb(), pendingIds)
          logger.info(
            {
              requestedIds: pendingIds.length,
              fetchedRows: rows.length,
              types: rows.map((r) => r.type),
              fetchedIds: rows.map((r) => r.id)
            },
            'tick: fetched notification rows'
          )
          const byId = new Map<number, (typeof rows)[0]>()
          for (const row of rows) {
            const id = row.id
            if (id !== undefined && !byId.has(id)) {
              byId.set(id, row)
            }
          }
          // Preserve order of first-seen ids from NOTIFYs (stable for same tick).
          const orderedIds: number[] = []
          const seenId = new Set<number>()
          for (const id of pendingIds) {
            if (seenId.has(id)) continue
            seenId.add(id)
            orderedIds.push(id)
          }
          const missingIds = orderedIds.filter((id) => !byId.has(id))
          if (missingIds.length > 0) {
            logger.warn(
              { missingIds },
              'tick: some notification IDs were not found in DB'
            )
          }
          self.updateAppData((d) => {
            for (const id of orderedIds) {
              const row = byId.get(id)
              if (row !== undefined) {
                d.listenerPending.appNotifications.push(row)
              }
            }
            return d
          })
        } catch (e) {
          logger.error(
            { err: e, pendingIds },
            'tick: failed to fetch notification rows — IDs lost'
          )
        }
      }

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
      try {
        await sendAppNotifications(
          listenerAdapter,
          data.appNotificationsProcessor
        )
      } catch (e) {
        logger.error(
          { err: e },
          'tick: sendAppNotifications threw unexpectedly'
        )
      }
      logger.debug('Processing app notifications (needs reprocessing)')
      try {
        await data.appNotificationsProcessor.reprocess()
      } catch (e) {
        logger.error({ err: e }, 'tick: reprocess threw unexpectedly')
      }

      logger.debug('Processing DM notifications')
      try {
        await sendDMNotifications(
          self.getDnDb(),
          self.getIdDb(),
          getIsBrowserPushEnabled(data.remoteConfig)
        )
      } catch (e) {
        logger.error({ err: e }, 'tick: sendDMNotifications threw unexpectedly')
      }

      if (
        getIsScheduledEmailEnabled(data.remoteConfig) &&
        (!data.lastDailyEmailSent ||
          data.lastDailyEmailSent < moment.utc().subtract(1, 'days'))
      ) {
        logger.info('Processing daily emails...')
        void processEmailNotifications(
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
        void processEmailNotifications(
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
      await server.init(identityDb, discoveryDb)
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
