import type { Knex } from 'knex'
import type { Logger } from '@pedalboard/logger'

const BATCH_SIZE = 100

type TrackRow = {
  track_id: number
  is_current: boolean
  txhash: string
  owner_id: number
  blocknumber: number | null
  updated_at: Date
}

type PlaylistRow = {
  playlist_id: number
  is_current: boolean
  txhash: string
}

type EventRow = {
  user_id: number
}

async function createRemixContestNotifications(
  trx: Knex.Transaction,
  track: TrackRow,
  log: Logger
): Promise<void> {
  const event = await trx('events')
    .select<EventRow>('user_id')
    .where('event_type', 'remix_contest')
    .where('entity_id', track.track_id)
    .where('is_deleted', false)
    .first()

  if (event === undefined) {
    return
  }

  const followerRows: { follower_user_id: number }[] = await trx('follows')
    .select('follower_user_id')
    .where({
      followee_user_id: event.user_id,
      is_current: true,
      is_delete: false
    })

  const saveRows: { user_id: number }[] = await trx('saves')
    .select('user_id')
    .where({
      save_item_id: track.track_id,
      save_type: 'track',
      is_current: true,
      is_delete: false
    })

  const userIds = [
    ...new Set([
      ...followerRows.map((r) => r.follower_user_id),
      ...saveRows.map((r) => r.user_id)
    ])
  ]

  if (userIds.length === 0) {
    return
  }

  const blocknumber = track.blocknumber
  const timestamp = track.updated_at
  const groupId = `fan_remix_contest_started:${track.track_id}:user:${event.user_id}`

  log.info(
    {
      trackId: track.track_id,
      eventUserId: event.user_id,
      groupId
    },
    'Creating fan remix contest started notifications for scheduled release'
  )

  for (const userId of userIds) {
    await trx('notification')
      .insert({
        blocknumber,
        user_ids: [userId],
        timestamp,
        type: 'fan_remix_contest_started',
        specifier: String(userId),
        group_id: groupId,
        data: {
          entity_user_id: track.owner_id,
          entity_id: track.track_id
        }
      })
      .onConflict(['group_id', 'specifier'])
      .ignore()
  }
}

export async function publishScheduledReleases(
  db: Knex,
  log: Logger
): Promise<void> {
  await db.transaction(async (trx) => {
    const tracks = await trx<TrackRow>('tracks')
      .select(
        'track_id',
        'is_current',
        'txhash',
        'owner_id',
        'blocknumber',
        'updated_at'
      )
      .where('is_unlisted', true)
      .where('is_scheduled_release', true)
      .whereNotNull('release_date')
      .whereRaw('release_date < CURRENT_TIMESTAMP')
      .orderBy('created_at', 'asc')
      .limit(BATCH_SIZE)

    if (tracks.length > 0) {
      log.info({ count: tracks.length }, 'Found tracks ready for release')
    }

    for (const track of tracks) {
      await trx('tracks')
        .where({
          track_id: track.track_id,
          is_current: track.is_current,
          txhash: track.txhash
        })
        .update({ is_unlisted: false })

      await createRemixContestNotifications(trx, track, log)
    }

    const playlists = await trx<PlaylistRow>('playlists')
      .select('playlist_id', 'is_current', 'txhash')
      .where('is_private', true)
      .where('is_album', true)
      .where('is_scheduled_release', true)
      .whereNotNull('release_date')
      .whereRaw('release_date < CURRENT_TIMESTAMP')
      .orderBy('created_at', 'asc')
      .limit(BATCH_SIZE)

    if (playlists.length > 0) {
      log.info({ count: playlists.length }, 'Found albums ready for release')
    }

    for (const playlist of playlists) {
      await trx('playlists')
        .where({
          playlist_id: playlist.playlist_id,
          is_current: playlist.is_current,
          txhash: playlist.txhash
        })
        .update({ is_private: false })
    }
  })
}
