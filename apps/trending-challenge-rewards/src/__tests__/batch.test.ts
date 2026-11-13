import { describe, it, expect } from '@jest/globals'
import { buildTrendingBatch, TrendingAward } from '../batch'

const week = '2026-11-13'
const awards: TrendingAward[] = ['tt', 'tut'].flatMap((challenge_id) =>
  Array.from({ length: 10 }, (_, i) => ({
    challenge_id,
    user_id: i + 1,
    specifier: `${week}:${i + 1}`,
    amount: i < 5 ? '1000' : '100',
    handle: `winner${i}`,
    wallet: '0x' + 'ab'.repeat(20),
    paid_amount: null
  }))
)

describe('weekly trending payout batch', () => {
  it('bounds a full batch to 20 awards and 11000 AUDIO', () => {
    const batch = buildTrendingBatch(week, awards)
    expect(batch.totalAudio).toBe(11000)
    expect(batch.remainingAudio).toBe(11000)
    expect(batch.unpaid).toHaveLength(20)
  })
  it('resumes a partial payout without a second weekly budget', () => {
    const batch = buildTrendingBatch(
      week,
      awards.map((a, i) =>
        i === 0 ? { ...a, paid_amount: '100000000000' } : a
      )
    )
    expect(batch.totalAudio).toBe(11000)
    expect(batch.remainingAudio).toBe(10000)
    expect(batch.unpaid).toHaveLength(19)
  })
  it.each([
    { challenge_id: 'e' },
    { specifier: '2026-11-06:1' },
    { specifier: `${week}:01` },
    { amount: '23250000' },
    { amount: 100 },
    { paid_amount: '1' },
    { wallet: '0x12' }
  ])('rejects unexpected payout data: %j', (change) => {
    expect(() =>
      buildTrendingBatch(week, [{ ...awards[0], ...change }])
    ).toThrow()
  })
  it('rejects duplicates and empty batches', () => {
    expect(() => buildTrendingBatch(week, [awards[0], awards[0]])).toThrow()
    expect(() => buildTrendingBatch(week, [])).toThrow()
    expect(() => buildTrendingBatch('2026-02-30', awards)).toThrow()
  })
})
