import moment from 'moment-timezone'
import { getRedisConnection } from '../../utils/redisConnection'

export type ScheduledEmailFrequency = 'daily' | 'weekly'

const LAST_SENT_REDIS_KEYS: Record<ScheduledEmailFrequency, string> = {
  daily: 'notifications:scheduled_email:last_daily_sent',
  weekly: 'notifications:scheduled_email:last_weekly_sent'
}

const INTERVAL_DAYS: Record<ScheduledEmailFrequency, number> = {
  daily: 1,
  weekly: 7
}

// Avoids a Redis round trip on every tick until the next run is due.
const nextCheckAt: Partial<Record<ScheduledEmailFrequency, moment.Moment>> = {}

/**
 * Returns true when a scheduled digest is due, and records the run in Redis.
 *
 * The last run time is kept in Redis so restarts and deploys don't trigger an
 * extra digest. With no recorded run (first deploy, or Redis was cleared) it
 * records now and waits a full interval instead of sending.
 */
export async function claimScheduledEmailRun(
  frequency: ScheduledEmailFrequency,
  now: moment.Moment = moment.utc()
): Promise<boolean> {
  const cached = nextCheckAt[frequency]
  if (cached && now.isBefore(cached)) return false

  const redis = await getRedisConnection()
  const key = LAST_SENT_REDIS_KEYS[frequency]
  const interval = INTERVAL_DAYS[frequency]
  const raw = await redis.get(key)
  const lastSent = raw ? moment.utc(raw) : null

  if (lastSent?.isValid()) {
    const nextRun = lastSent.clone().add(interval, 'days')
    if (now.isBefore(nextRun)) {
      nextCheckAt[frequency] = nextRun
      return false
    }
  }

  await redis.set(key, now.toISOString())
  nextCheckAt[frequency] = now.clone().add(interval, 'days')
  return Boolean(lastSent?.isValid())
}

export function resetScheduledEmailCache() {
  delete nextCheckAt.daily
  delete nextCheckAt.weekly
}
