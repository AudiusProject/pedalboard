import { describe, it, expect, jest } from '@jest/globals'
import { Knex } from 'knex'
import {
  queryTopTrending,
  queryHandles,
  queryTrackLinks,
  assembleEntries,
  composeTweet,
  composeTrackLinks
} from '../trending'

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

describe('queryHandles', () => {
  it('uses twitter handles from discovery users with audius handle fallback', async () => {
    const q: any = {
      select: jest.fn(() => q),
      whereIn: jest.fn(() => q),
      andWhere: jest.fn(() =>
        Promise.resolve([
          {
            user_id: 1,
            handle: 'first',
            twitter_handle: 'twitter_first',
            instagram_handle: 'insta_first'
          },
          {
            user_id: 2,
            handle: 'second',
            twitter_handle: null,
            instagram_handle: null
          },
          {
            user_id: 3,
            handle: 'third',
            twitter_handle: '@third_prefixed',
            instagram_handle: '@insta_prefixed'
          }
        ])
      )
    }
    const db: any = jest.fn(() => q)

    const handles = await queryHandles(
      db as unknown as Knex,
      [{ user_id: 1 }, { user_id: 2 }, { user_id: 3 }, { user_id: 4 }] as any[]
    )

    expect(q.select).toHaveBeenCalledWith(
      'user_id',
      'handle',
      'twitter_handle',
      'instagram_handle'
    )
    expect(q.whereIn).toHaveBeenCalledWith('user_id', [1, 2, 3, 4])
    expect(handles.get(1)).toEqual({
      twitter: '@twitter_first',
      instagram: '@insta_first'
    })
    expect(handles.get(2)).toEqual({ twitter: '@/second', instagram: undefined })
    expect(handles.get(3)).toEqual({
      twitter: '@third_prefixed',
      instagram: '@insta_prefixed'
    })
    // users missing from discovery fall back to @/user-<id> with no instagram
    expect(handles.get(4)).toEqual({ twitter: '@/user-4' })
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

  it('renders aligned twitter | instagram columns with a dash when missing', () => {
    const out = composeTweet('Top 10 Trending Underground 🎵', '2026-09-04', [
      { handle: '@/zurglinbeatz', instagram: '@zurglin', rank: 1 },
      { handle: '@AspireHigher', instagram: '@AspireHigherPA', rank: 2 },
      { handle: '@noinsta', rank: 3 }
    ])

    expect(out).toBe(
      [
        '```',
        'Top 10 Trending Underground 🎵 (2026-09-04)',
        'twitter        | instagram',
        '@/zurglinbeatz | @zurglin',
        '@AspireHigher  | @AspireHigherPA',
        '@noinsta       | -',
        '```'
      ].join('\n')
    )
  })
})

describe('queryTrackLinks', () => {
  it('builds audius.co permalinks from the current route and owner handle', async () => {
    const q: any = {
      select: jest.fn(() => q),
      leftJoin: jest.fn(() => q),
      whereIn: jest.fn(() => q),
      andWhere: jest.fn(() =>
        Promise.resolve([
          {
            track_id: 10,
            title: 'First Track',
            slug: 'first-track',
            handle: 'artistOne'
          },
          { track_id: 11, title: 'No Route', slug: null, handle: 'artistTwo' }
        ])
      )
    }
    const db: any = jest.fn(() => q)

    const links = await queryTrackLinks(
      db as unknown as Knex,
      [{ id: '10' }, { id: '11' }] as any[]
    )

    expect(q.whereIn).toHaveBeenCalledWith('tracks.track_id', [10, 11])
    expect(links.get(10)).toEqual({
      title: 'First Track',
      url: 'https://audius.co/artistOne/first-track'
    })
    // rows without a current route are skipped
    expect(links.get(11)).toBeUndefined()
  })

  it('skips the query entirely when no track ids are present', async () => {
    const db: any = jest.fn()
    const links = await queryTrackLinks(
      db as unknown as Knex,
      [{ id: null }] as any[]
    )
    expect(links.size).toBe(0)
    expect(db).not.toHaveBeenCalled()
  })
})

describe('assembleEntries', () => {
  it('attaches the winning track title and url by trending_results.id', () => {
    const entries = assembleEntries(
      new Map([[1, { twitter: '@artist', instagram: '@artist_ig' }]]),
      new Map([
        [10, { title: 'Winner', url: 'https://audius.co/artist/winner' }]
      ]),
      [{ user_id: 1, id: '10', rank: 1 }] as any[]
    )

    expect(entries[0]).toEqual({
      handle: '@artist',
      instagram: '@artist_ig',
      rank: 1,
      title: 'Winner',
      url: 'https://audius.co/artist/winner'
    })
  })
})

describe('composeTrackLinks', () => {
  it('renders rank, handle and a slack link ordered by rank', () => {
    const out = composeTrackLinks('Top 10 Trending Tracks 🔥', [
      {
        handle: '@second',
        rank: 2,
        title: 'Track Two',
        url: 'https://audius.co/b/track-two'
      },
      {
        handle: '@first',
        rank: 1,
        title: 'Track One',
        url: 'https://audius.co/a/track-one'
      }
    ])

    expect(out).toContain('*Top 10 Trending Tracks 🔥*')
    expect(out).toContain(
      '1. @first - <https://audius.co/a/track-one|Track One>'
    )
    expect(out.indexOf('Track One')).toBeLessThan(out.indexOf('Track Two'))
  })

  it('escapes slack control characters in track titles', () => {
    const out = composeTrackLinks('Top 10 Trending Tracks 🔥', [
      {
        handle: '@first',
        rank: 1,
        title: 'Up > Down & <Left>',
        url: 'https://audius.co/a/up-down'
      }
    ])
    expect(out).toContain(
      '<https://audius.co/a/up-down|Up &gt; Down &amp; &lt;Left&gt;>'
    )
  })

  it('falls back to a placeholder when the track link is missing', () => {
    const out = composeTrackLinks('Top 10 Trending Underground 🎵', [
      { handle: '@first', rank: 1 }
    ])
    expect(out).toContain('1. @first - _track link unavailable_')
  })
})
