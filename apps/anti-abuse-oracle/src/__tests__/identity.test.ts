import { describe, it, expect, beforeEach, vi } from 'vitest'

type SqlCall = {
  strings: readonly string[]
  values: unknown[]
}

const sqlCalls: SqlCall[] = []
let nextResult: unknown[] = []

const mockSqlFn = vi.fn(
  (strings: readonly string[], ...values: unknown[]): Promise<unknown[]> => {
    sqlCalls.push({ strings, values })
    return Promise.resolve(nextResult)
  }
)

type SqlTag = ((
  strings: readonly string[],
  ...values: unknown[]
) => Promise<unknown[]>) & { unsafe: (raw: string) => string }

const mockSql = mockSqlFn as unknown as SqlTag
mockSql.unsafe = (raw: string) => raw

vi.mock('postgres', () => ({
  default: vi.fn(() => mockSql)
}))

describe('identity', () => {
  beforeEach(() => {
    sqlCalls.length = 0
    nextResult = []
    mockSqlFn.mockClear()
  })

  it('userFingerprints sorts userIds ascending and returns rows', async () => {
    nextResult = [
      { fingerprint: 'fp1', userCount: 3, userIds: [9, 1, 5] },
      { fingerprint: 'fp2', userCount: 2, userIds: [7, 2] }
    ]
    const { userFingerprints } = await import('../identity')
    const rows = await userFingerprints(42)
    expect(rows).toEqual([
      { fingerprint: 'fp1', userCount: 3, userIds: [1, 5, 9] },
      { fingerprint: 'fp2', userCount: 2, userIds: [2, 7] }
    ])

    expect(sqlCalls).toHaveLength(1)
    const call = sqlCalls[0]
    expect(call.values).toEqual([42])
    expect(call.strings.join('?')).toContain('"Fingerprints"')
  })

  it('useFingerprintDeviceCount returns maxUserCount from the first row', async () => {
    nextResult = [{ maxUserCount: 7 }]
    const { useFingerprintDeviceCount } = await import('../identity')
    const count = await useFingerprintDeviceCount(99)
    expect(count).toBe(7)
    expect(sqlCalls[0].values).toEqual([99])
  })

  it('useFingerprintDeviceCount falls back to 0 when maxUserCount is null', async () => {
    nextResult = [{ maxUserCount: null }]
    const { useFingerprintDeviceCount } = await import('../identity')
    expect(await useFingerprintDeviceCount(99)).toBe(0)
  })

  it('useEmailDeliverable looks up by wallet and returns isEmailDeliverable', async () => {
    nextResult = [{ isEmailDeliverable: true }]
    const { useEmailDeliverable } = await import('../identity')
    expect(await useEmailDeliverable('0xWALLET')).toBe(true)
    expect(sqlCalls[0].values).toEqual(['0xWALLET'])
    expect(sqlCalls[0].strings.join('?')).toContain('"Users"')
  })

  it('useEmail looks up by blockchainUserId', async () => {
    nextResult = [{ email: 'me@example.com' }]
    const { useEmail } = await import('../identity')
    expect(await useEmail(123)).toBe('me@example.com')
    expect(sqlCalls[0].values).toEqual([123])
    expect(sqlCalls[0].strings.join('?')).toContain('"blockchainUserId"')
  })
})
