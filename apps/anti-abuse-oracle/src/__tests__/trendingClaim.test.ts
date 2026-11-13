import { describe, it, expect } from 'vitest'
import { parseTrendingClaim } from '../trendingClaim'

describe('trending claim authorization input', () => {
  const base = {
    challengeId: 'tt',
    challengeSpecifier: '2026-11-13:1',
    amount: '1000'
  }
  it.each([1, 5, 6, 10])('accepts the exact award for rank %s', (rank) => {
    const amount = rank <= 5 ? 1000 : 100
    for (const challengeId of ['tt', 'tut']) {
      for (const value of [amount, String(amount)]) {
        expect(
          parseTrendingClaim({
            ...base,
            challengeId,
            challengeSpecifier: `2026-11-13:${rank}`,
            amount: value
          })?.amount
        ).toBe(amount)
      }
    }
  })
  it.each([
    null,
    {},
    { ...base, challengeId: 'unknown' },
    ...[
      '2026-02-30:1',
      '2026-11-13:0',
      '2026-11-13:11',
      '2026-11-13:01',
      '2026-11-13:1_AAAAAAAAAAAAAAAAAAAA'
    ].map((challengeSpecifier) => ({ ...base, challengeSpecifier })),
    ...[-1, 0, 1, 100, 1000.5, '1e3', '1000.0', 23250000, {}, null].map(
      (amount) => ({ ...base, amount })
    )
  ])(
    'rejects malformed, ambiguous or incorrectly priced claims: %j',
    (input) => {
      expect(parseTrendingClaim(input)).toBeNull()
    }
  )
})
