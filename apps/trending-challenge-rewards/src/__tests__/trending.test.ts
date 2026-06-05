import { describe, it, expect, jest } from '@jest/globals'
import { Knex } from 'knex'
import { queryTopTrending, composeTweet } from '../trending'

// Builds a chainable knex mock. Each `db(table)` call returns a fresh builder
// that records its `whereIn` args and resolves `.first()` / `.limit()`.
const makeMockDb = (latestWeek: string, rows: any[]) => {
  const builders: any[] = []
  const db: any = jest.fn(() => {
    const q: any = {
      whereIn: jest.fn(() => q),
      where: jest.fn(() => q),
      orderBy: jest.fn(() => q),
      first: jest.fn(() => Promise.resolve({ week: latestWeek })),
      limit: jest.fn(() => Promise.resolve(rows))
    }
    builders.push(q)
    return q
  })
  return { db: db as unknown as Knex, builders }
}

describe('queryTopTrending', () => {
  it('matches both the new bare and legacy prefixed trending types', async () => {
    const { db, builders } = makeMockDb('2026-06-05', [
      { user_id: 1, id: '1', rank: 1, type: 'TRACKS' }
    ])

    await queryTopTrending(db, '2026-06-05')

    // First two builders are the tracks query (latest-week + rows),
    // next two are the underground query.
    expect(builders[0].whereIn).toHaveBeenCalledWith('type', [
      'TRACKS',
      'TrendingType.TRACKS'
    ])
    expect(builders[2].whereIn).toHaveBeenCalledWith('type', [
      'UNDERGROUND_TRACKS',
      'TrendingType.UNDERGROUND_TRACKS'
    ])
  })

  it('selects the most recent week on or before the requested date', async () => {
    const { db, builders } = makeMockDb('2026-05-29', [
      { user_id: 1, id: '1', rank: 1, type: 'TRACKS' }
    ])

    const [tracks] = await queryTopTrending(db, '2026-06-05')

    // latest-week builder filters week <= requested and orders desc
    expect(builders[0].where).toHaveBeenCalledWith('week', '<=', '2026-06-05')
    expect(builders[0].orderBy).toHaveBeenCalledWith('week', 'desc')
    // rows builder pins to the resolved latest week
    expect(builders[1].where).toHaveBeenCalledWith('week', '=', '2026-05-29')
    expect(tracks).toHaveLength(1)
  })

  it('returns an empty list when no week is available', async () => {
    const db: any = jest.fn(() => {
      const q: any = {
        whereIn: jest.fn(() => q),
        where: jest.fn(() => q),
        orderBy: jest.fn(() => q),
        first: jest.fn(() => Promise.resolve(undefined)),
        limit: jest.fn(() => Promise.resolve([]))
      }
      return q
    })

    const [tracks, underground] = await queryTopTrending(
      db as unknown as Knex,
      '2026-06-05'
    )

    expect(tracks).toEqual([])
    expect(underground).toEqual([])
  })
})

describe('composeTweet', () => {
  it('renders handles ordered by rank under the title/week header', () => {
    const out = composeTweet('Top 10 Trending Tracks 🔥', '2026-06-05', [
      { handle: '@second', rank: 2 },
      { handle: '@first', rank: 1 }
    ])

    expect(out).toContain('Top 10 Trending Tracks 🔥 (2026-06-05)')
    expect(out.indexOf('@first')).toBeLessThan(out.indexOf('@second'))
  })
})
