import type { Knex } from 'knex'

import { updateBadgeCount } from '../notificationSeenListener'

/**
 * pg NOTIFY handlers in basekit are fire-and-forget; awaiting updateBadgeCount
 * per notification_seen does not limit concurrency. Bursts can exhaust the
 * identity Knex pool and starve push processing (save/follow/etc.).
 *
 * Coalesce user IDs and drain sequentially so at most one badge update runs at
 * a time (duplicate user_ids in a batch collapse to one write).
 */
const pendingUserIds = new Set<number>()
let pumpRunning = false

async function pump(identityDb: Knex): Promise<void> {
  if (pumpRunning) return
  pumpRunning = true
  try {
    while (pendingUserIds.size > 0) {
      const batch = Array.from(pendingUserIds)
      pendingUserIds.clear()
      for (const userId of batch) {
        await updateBadgeCount(identityDb, userId)
      }
    }
  } finally {
    pumpRunning = false
    if (pendingUserIds.size > 0) {
      void pump(identityDb)
    }
  }
}

export function enqueueNotificationSeenBadgeUpdate(
  identityDb: Knex,
  userId: number
): void {
  pendingUserIds.add(userId)
  void pump(identityDb)
}
