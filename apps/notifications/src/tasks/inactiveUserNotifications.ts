/**
 * Inactive-user notification helpers.
 *
 * findInactiveUsers: queries the discovery DB plays table for users who just
 * crossed an inactivity window.
 *
 * insertTriggerNotification: inserts a single announcement notification row
 * into the discovery DB for the given user IDs (picked up by the existing push
 * send pipeline).
 */

import { Knex } from 'knex'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriggerPayload = {
  id: string
  heading: string
  body: string
  cta_link: string | null
  image_url: string | null
}

// ---------------------------------------------------------------------------
// Core inactive-user query (shared with /internal/inactive-users route)
// ---------------------------------------------------------------------------

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
// Discovery DB notification insert
// ---------------------------------------------------------------------------

/**
 * Inserts a single announcement notification row into the discovery DB for the
 * given user IDs. The existing push pipeline fans the notification out to each
 * user's devices. notification_campaign_id = trigger UUID so Discovery can
 * count opens for open-rate tracking.
 */
export async function insertTriggerNotification(
  discoveryDb: Knex,
  trigger: TriggerPayload,
  userIds: number[],
  sentAt: Date
): Promise<void> {
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
}
