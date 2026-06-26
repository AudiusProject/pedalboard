import { describe, it, expect, jest } from '@jest/globals'
import { Knex } from 'knex'
import { getTrendingChallenges } from '../queries'

describe('getTrendingChallenges', () => {
  it('selects the latest trending challenge by specifier date, not completed block', async () => {
    const rows = [
      {
        challenge_id: 'tt',
        specifier: '2026-06-26:1',
        completed_blocknumber: 120145840
      }
    ]
    const q: any = {
      from: jest.fn(() => q),
      where: jest.fn(() => q),
      whereNotNull: jest.fn(() => q),
      whereRaw: jest.fn(() => q),
      orderByRaw: jest.fn(() => q),
      orderBy: jest.fn(() => q),
      limit: jest.fn(() => Promise.resolve(rows))
    }
    const db: any = {
      select: jest.fn(() => q)
    }

    const result = await getTrendingChallenges(
      db as unknown as Knex,
      '2026-06-26'
    )

    expect(q.where).toHaveBeenCalledWith('challenge_id', '=', 'tt')
    expect(q.whereRaw).toHaveBeenCalledWith(
      "split_part(specifier, ':', 1) <= ?",
      ['2026-06-26']
    )
    expect(q.orderByRaw).toHaveBeenCalledWith(
      "split_part(specifier, ':', 1) DESC"
    )
    expect(q.orderBy).toHaveBeenCalledWith('specifier', 'asc')
    expect(result).toBe(rows)
  })
})
