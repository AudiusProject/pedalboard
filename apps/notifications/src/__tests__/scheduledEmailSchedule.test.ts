import moment from 'moment-timezone'

const store = new Map<string, string>()
jest.mock('../utils/redisConnection', () => ({
  getRedisConnection: async () => ({
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value)
    }
  })
}))

import {
  claimScheduledEmailRun,
  resetScheduledEmailCache
} from '../email/notifications/schedule'

const t0 = moment.utc('2026-10-06T00:35:00Z')

describe('claimScheduledEmailRun', () => {
  beforeEach(() => {
    store.clear()
    resetScheduledEmailCache()
  })

  it('records the first run without sending', async () => {
    expect(await claimScheduledEmailRun('daily', t0)).toBe(false)
    expect(store.get('notifications:scheduled_email:last_daily_sent')).toBe(
      t0.toISOString()
    )
  })

  it('does not resend after a restart within the interval', async () => {
    await claimScheduledEmailRun('daily', t0)
    resetScheduledEmailCache() // simulates a new process
    expect(
      await claimScheduledEmailRun('daily', t0.clone().add(3, 'hours'))
    ).toBe(false)
  })

  it('sends once the interval has passed, then waits again', async () => {
    await claimScheduledEmailRun('daily', t0)
    const due = t0.clone().add(1, 'day')
    expect(await claimScheduledEmailRun('daily', due)).toBe(true)
    expect(
      await claimScheduledEmailRun('daily', due.clone().add(1, 'minute'))
    ).toBe(false)
  })

  it('tracks daily and weekly separately', async () => {
    await claimScheduledEmailRun('daily', t0)
    await claimScheduledEmailRun('weekly', t0)
    const nextDay = t0.clone().add(1, 'day')
    expect(await claimScheduledEmailRun('daily', nextDay)).toBe(true)
    expect(await claimScheduledEmailRun('weekly', nextDay)).toBe(false)
    expect(
      await claimScheduledEmailRun('weekly', t0.clone().add(7, 'days'))
    ).toBe(true)
  })
})
