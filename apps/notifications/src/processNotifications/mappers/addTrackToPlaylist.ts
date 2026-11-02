import { Knex } from 'knex'
import { NotificationRow, PlaylistRow, TrackRow, UserRow } from '../../types/dn'
import { AddTrackToPlaylistNotification } from '../../types/notifications'
import { BaseNotification } from './base'
import { sendPushNotification } from '../../sns'
import { ResourceIds, Resources } from '../../email/notifications/renderEmail'
import {
  buildUserNotificationSettings,
  Device
} from './userNotificationSettings'
import { sendBrowserNotification } from '../../web'
import { disableDeviceArns } from '../../utils/disableArnEndpoint'
import { formatImageUrl } from '../../utils/format'

// Editorial playlists whose push opens the stat card, by production playlist
// id. Keep in sync with packages/common/src/store/ui/share-modal/milestones.ts
// in apps.
export const FEATURED_PLAYLIST_NAMES: Record<number, string> = {
  4281: 'Hot & New',
  1795117483: 'All Things Bass'
}

type AddTrackToPlaylistNotificationRow = Omit<NotificationRow, 'data'> & {
  data: AddTrackToPlaylistNotification
}
export class AddTrackToPlaylist extends BaseNotification<AddTrackToPlaylistNotificationRow> {
  trackId: number
  playlistId: number
  receiverUserId: number

  constructor(
    dnDB: Knex,
    identityDB: Knex,
    notification: AddTrackToPlaylistNotificationRow
  ) {
    super(dnDB, identityDB, notification)
    const userIds: number[] = this.notification.user_ids!
    this.receiverUserId = userIds![0]
    this.trackId = notification.data.track_id
    this.playlistId = notification.data.playlist_id
  }

  async processNotification({
    isBrowserPushEnabled
  }: {
    isBrowserPushEnabled: boolean
  }) {
    const trackRes: Array<{
      track_id: number
      title: string
      owner_id: number
    }> = await this.dnDB
      .select('track_id', 'title', 'owner_id')
      .from<TrackRow>('tracks')
      .where('is_current', true)
      .whereIn('track_id', [this.trackId])
    const track = trackRes[0]
    const playlistRes: Array<{
      playlist_id: number
      playlist_name: string
      playlist_owner_id: number
      playlist_image_sizes_multihash?: string | null
    }> = await this.dnDB
      .select(
        'playlist_id',
        'playlist_name',
        'playlist_owner_id',
        'playlist_image_sizes_multihash'
      )
      .from<PlaylistRow>('playlists')
      .where('is_current', true)
      .whereIn('playlist_id', [this.playlistId])
    const playlist = playlistRes[0]

    const res: Array<{
      user_id: number
      name: string
      is_deactivated: boolean
    }> = await this.dnDB
      .select('user_id', 'name', 'is_deactivated')
      .from<UserRow>('users')
      .where('is_current', true)
      .whereIn('user_id', [track.owner_id, playlist.playlist_owner_id])
    const users = res.reduce((acc, user) => {
      acc[user.user_id] = {
        name: user.name,
        isDeactivated: user.is_deactivated
      }
      return acc
    }, {} as Record<number, { name: string; isDeactivated: boolean }>)

    if (users?.[track.owner_id]?.isDeactivated) {
      return
    }

    // Get the user's notification setting from identity service
    const userNotificationSettings = await buildUserNotificationSettings(
      this.identityDB,
      [track.owner_id]
    )

    const playlistOwnerName = users[playlist.playlist_owner_id]?.name
    const trackTitle = track.title
    const playlistName = playlist.playlist_name

    const featuredName = FEATURED_PLAYLIST_NAMES[this.playlistId]
    const title = featuredName
      ? `You made ${featuredName}! 🔥`
      : 'Your track got on a playlist! 💿'
    const body = featuredName
      ? `${trackTitle} is on ${featuredName}. Share it`
      : `${playlistOwnerName} added ${trackTitle} to their playlist ${playlistName}`

    // Get playlist's image URL for rich notification (1000x1000 size)
    let imageUrl: string | undefined
    if (playlist?.playlist_image_sizes_multihash) {
      imageUrl = formatImageUrl(playlist.playlist_image_sizes_multihash, 1000)
    }

    await sendBrowserNotification(
      isBrowserPushEnabled,
      userNotificationSettings,
      track.owner_id,
      title,
      body
    )

    // If the user has devices to the notification to, proceed
    if (
      userNotificationSettings.shouldSendPushNotification({
        receiverUserId: track.owner_id
      })
    ) {
      const devices: Device[] = userNotificationSettings.getDevices(
        track.owner_id
      )
      const pushes = await Promise.all(
        devices.map((device) => {
          return sendPushNotification(
            {
              type: device.type,
              badgeCount:
                userNotificationSettings.getBadgeCount(track.owner_id) + 1,
              targetARN: device.awsARN
            },
            {
              title,
              body,
              data: {
                type: 'AddTrackToPlaylist',
                id: `timestamp:${this.getNotificationTimestamp()}:group_id:${
                  this.notification.group_id
                }`,
                playlistId: this.playlistId,
                ...(featuredName
                  ? { trackId: this.trackId, shareCard: true }
                  : {})
              },
              imageUrl
            }
          )
        })
      )
      await disableDeviceArns(this.identityDB, pushes)
      await this.incrementBadgeCount(track.owner_id)
    }
  }

  getResourcesForEmail(): ResourceIds {
    return {
      users: new Set([this.receiverUserId]),
      tracks: new Set([this.trackId]),
      playlists: new Set([this.playlistId])
    }
  }

  formatEmailProps(resources: Resources) {
    const receiverUserId = resources.users[this.receiverUserId]
    const playlist = resources.playlists[this.playlistId]
    const track = resources.tracks[this.trackId]
    return {
      type: this.notification.type,
      receiverUserId: { name: receiverUserId.name },
      playlistOwner: { name: playlist.ownerName },
      playlist: { playlist_name: playlist.playlist_name },
      track: { title: track.title }
    }
  }
}
