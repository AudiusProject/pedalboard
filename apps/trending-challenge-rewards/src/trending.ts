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

type TrendingEntry = {
  handle: string // twitter or discovery
  rank: number
}

export const announceTopTrending = async (
  app: App<SharedData>,
  maybeWeek?: string
) => {
  const week = maybeWeek || moment().format('YYYY-MM-DD')

  console.log('getting top trending for week ', week)

  const [tracks, undergroundTracks] = await queryTopTrending(
    discoveryDb,
    week
  )

  const trackHandles = await queryHandles(discoveryDb, tracks)
  const undergroundHandles = await queryHandles(discoveryDb, undergroundTracks)

  const trackEntries = assembleEntries(trackHandles, tracks)
  const undergroundEntries = assembleEntries(
    undergroundHandles,
    undergroundTracks
  )

  console.log('track entries', JSON.stringify(trackEntries))
  console.log('underground entries', JSON.stringify(undergroundEntries))

  const trendingTracksTweet = composeTweet(
    'Top 10 Trending Tracks 🔥',
    week,
    trackEntries
  )
  const trendingUndergroundTweet = composeTweet(
    'Top 10 Trending Underground 🎵',
    week,
    undergroundEntries
  )

  const { slackBotToken, slackChannel } = app.viewAppData()
  const webClient = new WebClient(slackBotToken)
  await sendTweet(
    webClient,
    [trendingTracksTweet, trendingUndergroundTweet],
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

export const queryHandles = async (
  discoveryDb: Knex,
  trendingResults: TrendingResults[]
): Promise<Map<number, string>> => {
  const blockchainUserIds = trendingResults.map((res) => res.user_id)
  if (blockchainUserIds.length === 0) return new Map()

  const users = await discoveryDb<Users>(Table.Users)
    .select('user_id', 'handle', 'twitter_handle')
    .whereIn('user_id', blockchainUserIds)
    .andWhere('is_current', true)
  const usersById = new Map(users.map((user) => [user.user_id, user]))
  const handleMap = new Map<number, string>()
  for (const userId of blockchainUserIds) {
    const user = usersById.get(userId)
    if (user === undefined) {
      console.warn(`no current discovery user found for user_id ${userId}`)
      handleMap.set(userId, `@/user-${userId}`)
      continue
    }
    const twitterHandle = user.twitter_handle?.trim().replace(/^@/, '')
    handleMap.set(
      userId,
      twitterHandle ? `@${twitterHandle}` : `@/${user.handle}`
    )
  }
  return handleMap
}

export const assembleEntries = (
  userIdToHandle: Map<number, string>,
  trendingResults: TrendingResults[]
): TrendingEntry[] => {
  const trendingEntries = []
  for (const result of trendingResults) {
    const { rank, user_id } = result
    const handle = userIdToHandle.get(user_id)!
    trendingEntries.push({
      handle,
      rank
    })
  }
  return trendingEntries
}

export const composeTweet = (
  title: string,
  week: string,
  entries: TrendingEntry[]
): string => {
  // order by rank in case db queries reordered in some way
  const orderedEntries = entries.sort((a, b) => {
    if (a.rank < b.rank) return -1 // a has a lower number, thus a higher rank
    if (a.rank > b.rank) return 1 // a has a higher number, thus a lower rank
    return 0 // ranks are equal, no sort to be done
  })
  const newLine = '\n'
  const handles = orderedEntries
    .map((entry) => `${entry.handle}${newLine}`)
    .join('')
  return '```\n' + `${title} (${week})` + newLine + handles + '```'
}

const sendTweet = async (
  slack: WebClient,
  tweets: string[],
  channel?: string
) => {
  if (channel === undefined) throw Error('SLACK_CHANNEL not defined')
  for (const tweet of tweets) {
    await slack.chat.postMessage({
      channel,
      text: tweet
    })
  }
}
