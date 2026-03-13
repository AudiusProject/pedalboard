import { Client } from 'pg'
import { Knex } from 'knex'
import { logger } from './logger'
import { PushNotificationBadgeCountRow } from './types/identity'

/** Update badge count to 0 for a user (used from basekit listen callback). */
export async function updateBadgeCount(
  identityDb: Knex,
  userId: number
): Promise<void> {
  try {
    const now = new Date()
    await identityDb<PushNotificationBadgeCountRow>(
      'PushNotificationBadgeCounts'
    )
      .insert({
        userId,
        iosBadgeCount: 0,
        createdAt: now,
        updatedAt: now
      })
      .onConflict('userId')
      .merge({
        iosBadgeCount: 0,
        updatedAt: now
      })
    logger.info(`Updated badge count to 0 for user ${userId}`)
  } catch (e) {
    logger.error(`Failed to update badge count for user ${userId}: ${e}`)
  }
}

/** Legacy NotificationSeenListener class for test harness. */
export class NotificationSeenListener {
  connectionString: string
  client: Client | null = null
  identityDB: Knex

  constructor(identityDB: Knex) {
    this.identityDB = identityDB
  }

  start = async (connectionString: string) => {
    this.connectionString = connectionString
    const { Client: PgClient } = await import('pg')
    this.client = new PgClient({
      connectionString,
      application_name: 'notification_seen'
    })
    logger.info('made client')
    await this.client.connect()
    logger.info('did connect')

    this.client.on('notification', async (msg: { channel: string }) => {
      if (msg.channel !== 'notification_seen') return
      const { user_id }: { user_id: number } = JSON.parse(
        (msg as { payload?: string }).payload ?? '{}'
      )
      await this.updateBadgeCount(user_id)
    })

    await this.client.query('LISTEN notification_seen;')
    logger.info('LISTENER Started')
  }

  updateBadgeCount = async (userId: number) => {
    await updateBadgeCount(this.identityDB, userId)
  }

  close = async () => {
    if (this.client) {
      await this.client.end()
      this.client = null
    }
  }
}
