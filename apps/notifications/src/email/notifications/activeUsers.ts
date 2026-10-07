import { Knex } from 'knex'

// Digest and announcement emails only go to users who opened the app within
// this many days. Transactional emails are not affected.
export const EMAIL_ACTIVE_WITHIN_DAYS = 90

/**
 * Returns the subset of userIds whose users.last_active_at (set on app open by
 * POST /v1/users/me/ping) is within EMAIL_ACTIVE_WITHIN_DAYS. Users with no
 * last_active_at count as inactive.
 */
export async function getRecentlyActiveUserIds(
  discoveryDb: Knex,
  userIds: number[]
): Promise<Set<number>> {
  if (userIds.length === 0) return new Set()
  const cutoff = new Date(
    Date.now() - EMAIL_ACTIVE_WITHIN_DAYS * 24 * 60 * 60 * 1000
  )
  const rows = await discoveryDb
    .select<{ user_id: number }[]>('user_id')
    .from('users')
    .whereIn('user_id', userIds)
    .andWhere('last_active_at', '>=', cutoff)
  return new Set(rows.map((r) => r.user_id))
}
