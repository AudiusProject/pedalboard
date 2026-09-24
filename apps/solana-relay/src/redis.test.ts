import { afterEach, describe, expect, it, vi } from 'vitest'

describe('claimable token account recreation rate limit', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.doUnmock('redis')
    vi.doUnmock('./logger')
    vi.resetModules()
  })

  it('allows 10 recreations per UTC day and rejects the 11th', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-24T23:30:00.000Z'))

    let count = 0
    const keys: string[] = []
    const redisClient = {
      on: vi.fn((_event: string, callback: () => void) => callback()),
      connect: vi.fn(),
      multi: vi.fn(() => {
        const results: unknown[] = []
        type MockRedisTransaction = {
          incr: (key: string) => MockRedisTransaction
          expire: () => MockRedisTransaction
          exec: () => Promise<unknown[]>
        }
        const transaction: MockRedisTransaction = {
          incr: vi.fn((key: string) => {
            keys.push(key)
            count += 1
            results.push(count)
            return transaction
          }),
          expire: vi.fn(() => {
            results.push(true)
            return transaction
          }),
          exec: vi.fn(async () => results)
        }
        return transaction
      })
    }

    vi.doMock('redis', () => ({
      createClient: vi.fn(() => redisClient)
    }))
    vi.doMock('./logger', () => ({
      logger: { error: vi.fn(), info: vi.fn() }
    }))

    const {
      CLAIMABLE_TOKEN_ACCOUNT_RECREATION_SYSTEM_LIMIT,
      rateLimitClaimableTokenAccountRecreation
    } = await import('./redis')

    for (
      let i = 0;
      i < CLAIMABLE_TOKEN_ACCOUNT_RECREATION_SYSTEM_LIMIT;
      i += 1
    ) {
      await expect(
        rateLimitClaimableTokenAccountRecreation(`account-${i}`)
      ).resolves.toBeUndefined()
    }

    await expect(
      rateLimitClaimableTokenAccountRecreation('account-over-limit')
    ).rejects.toThrow(
      'System has recreated too many claimable token accounts today'
    )
    expect(keys).toHaveLength(11)
    expect(new Set(keys)).toEqual(
      new Set(['claimable-token-account-recreation-count:global:2026-09-24'])
    )
  })
})
