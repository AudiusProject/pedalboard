/**
 * Automated re-engagement notifications for inactive users.
 *
 * Reads active trigger configs from the notifications dashboard Supabase DB,
 * finds users who just crossed each inactivity threshold (via the plays table),
 * inserts a notification row into the discovery DB (picked up by the existing
 * push send pipeline), and logs each send to trigger_sends in Supabase so the
 * dashboard can compute audience_reached_30d and open_rate_30d.
 *
 * The trigger UUID is used as the notification_campaign_id so Discovery can
 * attribute push opens back to the trigger for open-rate tracking.
 */

import { Knex } from 'knex'
import { logger } from '../logger'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AutomatedTrigger = {
  id: string
  name: string
  heading: string
  body: string
  trigger_hours: number
  cta_link: string | null
  image_url: string | null
}

// ---------------------------------------------------------------------------
// Core inactive-user query (shared with /internal/inactive-users route)
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_HOURS = 1

/**
 * Returns user IDs whose most recent play aged into the
 * [hours, hours + windowHours) band with no subsequent activity.
 * Callers should run this on a cadence equal to windowHours so each
 * user is returned exactly once per inactivity episode.
 */
export async function findInactiveUsers(
  discoveryDb: Knex,
  hours: number,
  windowHours: number,
  limit: number
): Promise<number[]> {
  const rows = await discoveryDb
    .select<{ user_id: number }[]>('p.user_id')
    .from({ p: 'plays' })
    .whereNotNull('p.user_id')
    .andWhereRaw("p.created_at >= now() - (? * interval '1 hour')", [
      hours + windowHours
    ])
    .andWhereRaw("p.created_at < now() - (? * interval '1 hour')", [hours])
    .whereNotExists(function () {
      this.select(discoveryDb.raw('1'))
        .from({ p2: 'plays' })
        .whereRaw('p2.user_id = p.user_id')
        .andWhereRaw("p2.created_at >= now() - (? * interval '1 hour')", [
          hours
        ])
    })
    .groupBy('p.user_id')
    .limit(limit)
  return rows.map((r) => r.user_id)
}

// ---------------------------------------------------------------------------
// Supabase helpers (raw pg via knex — no REST layer needed)
// ---------------------------------------------------------------------------

function getDashboardDb(): Knex | null {
  const url = process.env.DASHBOARD_DB_URL
  if (!url?.trim()) return null
  // Lazy require so the rest of the app doesn't pay the cost when unconfigured.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { knex } = require('knex') as typeof import('knex')
  return knex({ client: 'pg', connection: url, pool: { min: 1, max: 3 } })
}

let _dashboardDb: Knex | null | undefined
function dashboardDb(): Knex | null {
  if (_dashboardDb === undefined) _dashboardDb = getDashboardDb()
  return _dashboardDb
}

async function fetchActiveTriggers(db: Knex): Promise<AutomatedTrigger[]> {
  return db('automated_triggers')
    .select('id', 'name', 'heading', 'body', 'trigger_hours', 'cta_link', 'image_url')
    .where('is_active', true)
}

async function logTriggerSends(
  db: Knex,
  triggerId: string,
  userIds: number[],
  sentAt: Date
): Promise<void> {
  if (userIds.length === 0) return
  const rows = userIds.map((userId) => ({
    trigger_id: triggerId,
    user_id: userId,
    sent_at: sentAt.toISOString()
  }))
  await db('trigger_sends').insert(rows)
}

// ---------------------------------------------------------------------------
// Main task
// ---------------------------------------------------------------------------

const MAX_USERS_PER_TRIGGER = 100_000

/**
 * For each active trigger, find newly-inactive users and send them a push
 * notification via the discovery DB notification pipeline.
 */
export async function sendInactiveUserNotifications(
  discoveryDb: Knex
): Promise<void> {
  const db = dashboardDb()
  if (!db) {
    logger.debug(
      'inactive-user notifications: DASHBOARD_DB_URL not set, skipping'
    )
    return
  }

  let triggers: AutomatedTrigger[]
  try {
    triggers = await fetchActiveTriggers(db)
  } catch (e) {
    logger.error({ err: e }, 'inactive-user notifications: failed to fetch triggers')
    return
  }

  if (triggers.length === 0) {
    logger.debug('inactive-user notifications: no active triggers')
    return
  }

  const sentAt = new Date()

  for (const trigger of triggers) {
    try {
      const userIds = await findInactiveUsers(
        discoveryDb,
        trigger.trigger_hours,
        DEFAULT_WINDOW_HOURS,
        MAX_USERS_PER_TRIGGER
      )

      if (userIds.length === 0) {
        logger.info(
          { trigger: trigger.name, hours: trigger.trigger_hours },
          'inactive-user notifications: no users in window'
        )
        continue
      }

      logger.info(
        { trigger: trigger.name, hours: trigger.trigger_hours, count: userIds.length },
        'inactive-user notifications: sending'
      )

      // Insert a single notification row; the existing push pipeline fans it
      // out to each user's devices. notification_campaign_id = trigger UUID
      // so Discovery can count opens for open-rate tracking.
      await discoveryDb('notification').insert({
        specifier: '',
        group_id: `inactivity-trigger:${trigger.id}:${sentAt.getTime()}`,
        type: 'announcement',
        timestamp: sentAt,
        user_ids: userIds,
        data: {
          title: trigger.heading,
          short_description: trigger.body,
          push_body: trigger.body,
          notification_campaign_id: trigger.id,
          ...(trigger.cta_link ? { route: trigger.cta_link } : {}),
          ...(trigger.image_url ? { image_url: trigger.image_url } : {})
        }
      })

      // Log sends to Supabase for audience_reached_30d computation.
      await logTriggerSends(db, trigger.id, userIds, sentAt)
    } catch (e) {
      logger.error(
        { err: e, trigger: trigger.name },
        'inactive-user notifications: error processing trigger'
      )
    }
  }
}
