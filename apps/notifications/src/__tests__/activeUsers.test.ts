import { describe, expect, jest, test } from '@jest/globals'
import type { Knex } from 'knex'
import {
  EMAIL_ACTIVE_WITHIN_DAYS,
  getRecentlyActiveUserIds
} from '../email/notifications/activeUsers'

// Minimal knex double: records the chain and resolves to `rows`.
const mockDb = (rows: { user_id: number }[]) => {
  const calls: { method: string; args: any[] }[] = []
  const builder: any = {}
  for (const method of ['select', 'from', 'whereIn', 'andWhere']) {
    builder[method] = (...args: any[]) => {
      calls.push({ method, args })
      return builder
    }
  }
  builder.then = (resolve: (v: any) => any) =>
    Promise.resolve(rows).then(resolve)
  const db = { select: builder.select } as unknown as Knex
  return { db, calls }
}

describe('getRecentlyActiveUserIds', () => {
  test('returns the active subset', async () => {
    const { db } = mockDb([{ user_id: 1 }, { user_id: 3 }])
    const result = await getRecentlyActiveUserIds(db, [1, 2, 3])
    expect([...result].sort()).toEqual([1, 3])
  })

  test('filters on last_active_at within the cutoff', async () => {
    const now = new Date('2026-10-07T00:00:00Z').getTime()
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now)
    const { db, calls } = mockDb([])
    await getRecentlyActiveUserIds(db, [1, 2])
    spy.mockRestore()

    expect(calls.find((c) => c.method === 'from')?.args).toEqual(['users'])
    expect(calls.find((c) => c.method === 'whereIn')?.args).toEqual([
      'user_id',
      [1, 2]
    ])
    const [column, op, cutoff] = calls.find((c) => c.method === 'andWhere')!
      .args as [string, string, Date]
    expect(column).toBe('last_active_at')
    expect(op).toBe('>=')
    expect(cutoff.getTime()).toBe(
      now - EMAIL_ACTIVE_WITHIN_DAYS * 24 * 60 * 60 * 1000
    )
  })

  test('skips the query for an empty list', async () => {
    const { db, calls } = mockDb([])
    const result = await getRecentlyActiveUserIds(db, [])
    expect(result.size).toBe(0)
    expect(calls).toHaveLength(0)
  })
})
