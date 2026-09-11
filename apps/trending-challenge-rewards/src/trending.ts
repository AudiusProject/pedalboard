import { App } from '@pedalboard/basekit'
import { Knex } from 'knex'
import { SharedData } from './config'
import { discoveryDb } from './utils'
import { WebClient } from '@slack/web-api'
import moment from 'moment'
import { Table, TrendingResults, Users } from '@pedalboard/storage'

// trending_results.type values to match. The trending-challenge computation
// was ported from the discovery-provider (Python) to the Go API in api#835
// (merged 2026-05-28), which dropped the "TrendingType." prefix from the type
// column (e.g. "TrendingType.TRACKS" -> "TRACKS"). Match both the new bare
// values and the legacy prefixed ones so the digest works during/after the
// migration regardless of which system wrote the row.
const TRENDING_TYPES_TRACKS = ['TRACKS', 'TrendingType.TRACKS']
const TRENDING_TYPES_UNDERGROUND = [
  'UNDERGROUND_TRACKS',
  'TrendingType.UNDERGROUND_TRACKS'
]

const AUDIUS_URL = 'https://audius.co'

type TrendingEntry = {
  handle: string // twitter or discovery
  instagram?: string // instagram, when the user has one connected
  rank: number
  title?: string
  url?: string
}

// Social handles for a winning user, keyed by user_id.
export type UserHandles = {
  twitter: string // "@twitter" or "@/audiusHandle" fallback
  instagram?: string // "@instagram", undefined when not connected
}

// Placeholder for the instagram column when a user has none connected.
const NO_INSTAGRAM = '-'

// Track title + permalink for a winning track, keyed by trending_results.id.
export type TrackLink = {
  title: string
  url: string
}

type TrackLinkRow = {
  track_id: number
  title: string | null
  slug: string | null
  handle: string | null
}

export const announceTopTrending = async (
  app: App<SharedData>,
  maybeWeek?: string
) => {
  const week = maybeWeek || moment().format('YYYY-MM-DD')

  console.log('getting top trending for week ', week)

  const [tracks, undergroundTracks] = await queryTopTrending(discoveryDb, week)

  const trackHandles = await queryHandles(discoveryDb, tracks)
  const undergroundHandles = await queryHandles(discoveryDb, undergroundTracks)

  const trackLinks = await queryTrackLinks(discoveryDb, tracks)
  const undergroundLinks = await queryTrackLinks(discoveryDb, undergroundTracks)

  const trackEntries = assembleEntries(trackHandles, trackLinks, tracks)
  const undergroundEntries = assembleEntries(
    undergroundHandles,
    undergroundLinks,
    undergroundTracks
  )

  console.log('track entries', JSON.stringify(trackEntries))
  console.log('underground entries', JSON.stringify(undergroundEntries))

  const trendingTracksTitle = 'Top 10 Trending Tracks 🔥'
  const trendingUndergroundTitle = 'Top 10 Trending Underground 🎵'

  const trendingTracksTweet = composeTweet(
    trendingTracksTitle,
    week,
    trackEntries
  )
  const trendingUndergroundTweet = composeTweet(
    trendingUndergroundTitle,
    week,
    undergroundEntries
  )

  const trendingTracksLinks = composeTrackLinks(
    trendingTracksTitle,
    trackEntries
  )
  const trendingUndergroundLinks = composeTrackLinks(
    trendingUndergroundTitle,
    undergroundEntries
  )

  const { slackBotToken, slackChannel } = app.viewAppData()
  const webClient = new WebClient(slackBotToken)
  await sendTweet(
    webClient,
    [
      { tweet: trendingTracksTweet, links: trendingTracksLinks },
      { tweet: trendingUndergroundTweet, links: trendingUndergroundLinks }
    ],
    slackChannel
  )
}

export const queryTopTrending = async (
  discoveryDb: Knex,
  week: string
): Promise<TrendingResults[][]> => {
  // Pick the most recent available week on or before the requested date rather
  // than requiring an exact `week = today` match. This mirrors the discovery
  // API (GET /v1/tracks/trending/winners) and keeps the digest resilient to
  // timezone/timing skew between this cron and the trending job that writes
  // the rows.
  const queryForType = async (types: string[]) => {
    const latest = await discoveryDb<TrendingResults>(Table.TrendingResults)
      .whereIn('type', types)
      .where('week', '<=', week)
      .orderBy('week', 'desc')
      .first()
    if (latest === undefined) return []
    return discoveryDb<TrendingResults>(Table.TrendingResults)
      .whereIn('type', types)
      .where('week', '=', latest.week)
      .orderBy('rank')
      .limit(10)
  }

  const tracks = await queryForType(TRENDING_TYPES_TRACKS)
  const undergroundTracks = await queryForType(TRENDING_TYPES_UNDERGROUND)

  return [tracks, undergroundTracks]
}

// Social handles are stored bare (no "@", no URL) but strip a leading "@"
// defensively so the rendered column is always "@handle".
const formatSocialHandle = (
  raw: string | null | undefined
): string | undefined => {
  const handle = raw?.trim().replace(/^@/, '')
  return handle ? `@${handle}` : undefined
}

export const queryHandles = async (
  discoveryDb: Knex,
  trendingResults: TrendingResults[]
): Promise<Map<number, UserHandles>> => {
  const blockchainUserIds = trendingResults.map((res) => res.user_id)
  if (blockchainUserIds.length === 0) return new Map()

  const users = await discoveryDb<Users>(Table.Users)
    .select('user_id', 'handle', 'twitter_handle', 'instagram_handle')
    .whereIn('user_id', blockchainUserIds)
    .andWhere('is_current', true)
  const usersById = new Map(users.map((user) => [user.user_id, user]))
  const handleMap = new Map<number, UserHandles>()
  for (const userId of blockchainUserIds) {
    const user = usersById.get(userId)
    if (user === undefined) {
      console.warn(`no current discovery user found for user_id ${userId}`)
      handleMap.set(userId, { twitter: `@/user-${userId}` })
      continue
    }
    handleMap.set(userId, {
      twitter: formatSocialHandle(user.twitter_handle) ?? `@/${user.handle}`,
      instagram: formatSocialHandle(user.instagram_handle)
    })
  }
  return handleMap
}

// Resolves the winning track's title and audius.co permalink.
// `trending_results.id` holds the numeric track id as text (see the
// handle_trending trigger in api/ddl/functions/handle_trending.sql).
// Permalinks are `/{handle}/{slug}` from the current track_routes row,
// matching how the API builds Track.permalink.
export const queryTrackLinks = async (
  discoveryDb: Knex,
  trendingResults: TrendingResults[]
): Promise<Map<number, TrackLink>> => {
  const trackIds = trendingResults
    .filter((res) => res.id !== null && res.id !== '')
    .map((res) => Number(res.id))
    .filter((trackId) => Number.isInteger(trackId) && trackId > 0)
  if (trackIds.length === 0) return new Map()

  const rows = await discoveryDb(Table.Tracks)
    .select<TrackLinkRow[]>(
      'tracks.track_id',
      'tracks.title',
      'track_routes.slug',
      'users.handle'
    )
    .leftJoin(Table.Users, function () {
      this.on('users.user_id', '=', 'tracks.owner_id').andOnVal(
        'users.is_current',
        true
      )
    })
    .leftJoin(Table.TrackRoutes, function () {
      this.on('track_routes.track_id', '=', 'tracks.track_id').andOnVal(
        'track_routes.is_current',
        true
      )
    })
    .whereIn('tracks.track_id', trackIds)
    .andWhere('tracks.is_current', true)

  const linkMap = new Map<number, TrackLink>()
  for (const row of rows) {
    if (row.slug === null || row.handle === null) {
      console.warn(`no current route found for track_id ${row.track_id}`)
      continue
    }
    linkMap.set(row.track_id, {
      title: row.title ?? `track ${row.track_id}`,
      url: `${AUDIUS_URL}/${row.handle}/${row.slug}`
    })
  }
  return linkMap
}

export const assembleEntries = (
  userIdToHandles: Map<number, UserHandles>,
  trackIdToLink: Map<number, TrackLink>,
  trendingResults: TrendingResults[]
): TrendingEntry[] => {
  const trendingEntries = []
  for (const result of trendingResults) {
    const { rank, user_id, id } = result
    const { twitter: handle, instagram } = userIdToHandles.get(user_id)!
    const link = trackIdToLink.get(Number(id))
    trendingEntries.push({
      handle,
      instagram,
      rank,
      title: link?.title,
      url: link?.url
    })
  }
  return trendingEntries
}

// order by rank in case db queries reordered in some way
const byRank = (entries: TrendingEntry[]): TrendingEntry[] =>
  [...entries].sort((a, b) => a.rank - b.rank)

// Two aligned columns inside a code block: twitter (or the "@/audius"
// fallback) and instagram, so the team can credit artists on both platforms.
export const composeTweet = (
  title: string,
  week: string,
  entries: TrendingEntry[]
): string => {
  const newLine = '\n'
  const ordered = byRank(entries)
  const twitterColumn = ['twitter', ...ordered.map((entry) => entry.handle)]
  const instagramColumn = [
    'instagram',
    ...ordered.map((entry) => entry.instagram ?? NO_INSTAGRAM)
  ]
  const twitterWidth = Math.max(...twitterColumn.map((cell) => cell.length))
  const rows = twitterColumn
    .map(
      (twitter, i) =>
        `${twitter.padEnd(twitterWidth)} | ${instagramColumn[i]}${newLine}`
    )
    .join('')
  return '```\n' + `${title} (${week})` + newLine + rows + '```'
}

// Companion to the tweet block: the same winners with the track that actually
// won and a clickable link, so artists with several trending tracks can be
// told apart. Kept outside the code fence so Slack renders the links.
export const composeTrackLinks = (
  title: string,
  entries: TrendingEntry[]
): string => {
  const lines = byRank(entries).map((entry) => {
    if (entry.url === undefined || entry.title === undefined) {
      return `${entry.rank}. ${entry.handle} — _track link unavailable_`
    }
    return `${entry.rank}. ${entry.handle} — <${entry.url}|${entry.title}>`
  })
  return [`*${title}*`, ...lines].join('\n')
}

const sendTweet = async (
  slack: WebClient,
  tweets: { tweet: string; links: string }[],
  channel?: string
) => {
  if (channel === undefined) throw Error('SLACK_CHANNEL not defined')
  for (const { tweet, links } of tweets) {
    await slack.chat.postMessage({
      channel,
      text: `${tweet}\n${links}`
    })
  }
}
