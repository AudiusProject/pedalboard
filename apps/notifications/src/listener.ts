import { Client } from 'pg'
import { Knex } from 'knex'
import { logger } from './logger'
import { NotificationRow } from './types/dn'

export class PendingUpdates {
  appNotifications: Array<NotificationRow> = []

  isEmpty(): boolean {
    return this.appNotifications.length === 0
  }
}

/** Fetch a notification row by id (for use in basekit listen callback). */
export async function getNotificationById(
  db: Knex,
  notificationId: number
): Promise<NotificationRow | null> {
  try {
    const row = await db<NotificationRow>('notification')
      .where('id', notificationId)
      .first()
    return row ?? null
  } catch (e) {
    logger.error(`could not get notification ${notificationId} ${e}`)
    return null
  }
}

const NOTIFICATION_ID_IN_CHUNK = 500

/** Load many notification rows in few queries (avoids one Knex checkout per NOTIFY). */
export async function fetchNotificationsByIds(
  db: Knex,
  ids: number[]
): Promise<NotificationRow[]> {
  if (ids.length === 0) return []
  const unique = [...new Set(ids)]
  const rows: NotificationRow[] = []
  for (let i = 0; i < unique.length; i += NOTIFICATION_ID_IN_CHUNK) {
    const slice = unique.slice(i, i + NOTIFICATION_ID_IN_CHUNK)
    const batch = await db<NotificationRow>('notification').whereIn('id', slice)
    rows.push(...batch)
  }
  return rows
}

/** Adapter type for sendAppNotifications: something that can take pending notifications. */
export interface ListenerAdapter {
  takePending(): PendingUpdates | undefined
}

/** Legacy Listener class for test harness (pg LISTEN + takePending). */
export class Listener {
  pending: PendingUpdates = new PendingUpdates()
  connectionString: string
  client: Client | null = null

  takePending = (): PendingUpdates | undefined => {
    if (this.pending.isEmpty()) return undefined
    const p = this.pending
    this.pending = new PendingUpdates()
    return p
  }

  handler = (notification: NotificationRow) => {
    this.pending.appNotifications.push(notification)
  }

  start = async (connectionString: string) => {
    this.connectionString = connectionString
    const { Client: PgClient } = await import('pg')
    this.client = new PgClient({
      connectionString,
      application_name: 'notifications'
    })
    logger.info('made client')
    await this.client.connect()
    logger.info('did connect')

    this.client.on(
      'notification',
      async (msg: { channel: string; payload?: string }) => {
        if (msg.channel !== 'notification') return
        const { notification_id }: { notification_id: number } = JSON.parse(
          msg.payload ?? '{}'
        )
        const notification = await getNotificationWithClient(
          this.client!,
          notification_id
        )
        if (notification !== null) {
          this.handler(notification)
        }
      }
    )

    await this.client.query('LISTEN notification;')
    logger.info('LISTENER Started')
  }

  close = async () => {
    if (this.client) {
      await this.client.end()
      this.client = null
    }
  }
}

async function getNotificationWithClient(
  client: Client,
  notificationId: number
): Promise<NotificationRow | null> {
  try {
    const res = await client.query<NotificationRow>(
      'SELECT * FROM notification WHERE id = $1 limit 1;',
      [notificationId]
    )
    return res.rows[0] ?? null
  } catch (e) {
    logger.error(`could not get notification ${notificationId} ${e}`)
    return null
  }
}
