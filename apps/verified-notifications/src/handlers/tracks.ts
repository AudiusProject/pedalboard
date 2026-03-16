import type { App } from '@pedalboard/basekit'
import { slack } from '../slack'
import { createLogger } from '@pedalboard/logger'

const logger = createLogger('verified-notifications')

type AppData = { port: number }

export const isOldUpload = (uploadDate: string | Date): boolean => {
  const uploadedDate = new Date(uploadDate).getTime()
  const oneWeekAgo = new Date()
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7)
  return oneWeekAgo.getTime() > uploadedDate
}

export default async (
  app: App<AppData>,
  msg: { track_id: number; updated_at: string; created_at: string }
): Promise<void> => {
  const { track_id, updated_at, created_at } = msg
  const isUpload =
    updated_at === created_at &&
    updated_at !== undefined &&
    created_at !== undefined
  if (!isUpload) return

  if (isOldUpload(created_at)) {
    logger.info({ created_at, track_id }, 'old upload')
    return
  }

  const trackId = track_id
  const db = app.getDnDb()
  const results = await db('tracks')
    .innerJoin('users', 'tracks.owner_id', '=', 'users.user_id')
    .innerJoin('track_routes', 'tracks.track_id', '=', 'track_routes.track_id')
    .select(
      'tracks.title',
      'tracks.mood',
      'tracks.genre',
      'tracks.release_date',
      'tracks.is_stream_gated',
      'tracks.is_download_gated',
      'tracks.owner_id',
      'users.user_id',
      'users.handle',
      'users.name',
      'tracks.track_id',
      'users.is_verified',
      'track_routes.slug',
      'tracks.is_unlisted'
    )
    .where('tracks.track_id', '=', trackId)
    .where('users.is_verified', '=', true)
    .whereNull('tracks.stem_of')
    .where('tracks.is_unlisted', '=', false)
    .first()
    .catch((err) => {
      logger.error({ err }, 'tracks query')
      return undefined
    })

  if (results === undefined) return

  const {
    title,
    genre,
    mood,
    is_stream_gated,
    is_download_gated,
    handle,
    slug,
    release_date,
    name
  } = results as {
    title: string
    genre: string
    mood: string
    is_stream_gated: boolean
    is_download_gated: boolean
    handle: string
    slug: string
    release_date: string | null
    name: string
  }

  const TRACKS_SLACK_CHANNEL = process.env.TRACKS_SLACK_CHANNEL!
  const header = `:audius-spin: New upload from *${name}* 🔥`
  const data = {
    Title: title,
    Genre: genre,
    Mood: mood,
    'Stream Gated': is_stream_gated,
    'Download Gated': is_download_gated,
    Handle: handle,
    Link: `https://audius.co/${handle}/${slug}`,
    Release: release_date ?? created_at
  }
  logger.info({ to_slack: data }, 'track upload')
  await slack.sendMsg(TRACKS_SLACK_CHANNEL, header, data as Record<string, unknown>).catch((err) =>
    logger.error({ err }, 'slack send')
  )
}
