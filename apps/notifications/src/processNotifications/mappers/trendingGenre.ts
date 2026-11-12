import { Knex } from 'knex'
import { NotificationRow, TrackRow, UserRow } from '../../types/dn'
import { TrendingGenreNotification } from '../../types/notifications'
import { BaseNotification } from './base'
import { sendPushNotification } from '../../sns'
import {
  buildUserNotificationSettings,
  Device
} from './userNotificationSettings'
import { sendBrowserNotification } from '../../web'
import { disableDeviceArns } from '../../utils/disableArnEndpoint'
import { formatImageUrl } from '../../utils/format'

type TrendingGenreNotificationRow = Omit<NotificationRow, 'data'> & {
  data: TrendingGenreNotification
}

export const trendingGenreMessages = {
  title: (genre: string) => `📈 Charting in ${genre}`,
  body: (title: string, rank: number, genre: string) =>
    `${title} is #${rank} in ${genre} this week! Share it`
}

/**
 * Push for a track in the top 10 of its genre's weekly trending chart. Rows
 * are written once per track per week on Friday by the api's
 * TrendingGenreNotificationsJob (group_id `trending_genre:<friday>:<track>`).
 * Tapping opens the track with the share card.
 */
export class TrendingGenre extends BaseNotification<TrendingGenreNotificationRow> {
  receiverUserId: number
  trackId: number
  rank: number
  genre: string

  constructor(
    dnDB: Knex,
    identityDB: Knex,
    notification: TrendingGenreNotificationRow
  ) {
    super(dnDB, identityDB, notification)
    const userIds: number[] = this.notification.user_ids ?? []
    this.receiverUserId = userIds[0]
    this.trackId = this.notification.data.track_id
    this.rank = this.notification.data.rank
    this.genre = this.notification.data.genre
  }

  async processNotification({
    isBrowserPushEnabled
  }: {
    isBrowserPushEnabled: boolean
  }) {
    const user = await this.dnDB
      .select('is_deactivated')
      .from<UserRow>('users')
      .where('is_current', true)
      .where('user_id', this.receiverUserId)
      .first()
    if (!user || user.is_deactivated) return

    const track:
      | { title: string; cover_art_sizes?: string | null }
      | undefined = await this.dnDB
      .select('title', 'cover_art_sizes')
      .from<TrackRow>('tracks')
      .where('is_current', true)
      .where('track_id', this.trackId)
      .first()
    if (!track) return

    const title = trendingGenreMessages.title(this.genre)
    const body = trendingGenreMessages.body(track.title, this.rank, this.genre)
    const imageUrl = track.cover_art_sizes
      ? formatImageUrl(track.cover_art_sizes, 1000)
      : undefined

    const userNotificationSettings = await buildUserNotificationSettings(
      this.identityDB,
      [this.receiverUserId]
    )

    await sendBrowserNotification(
      isBrowserPushEnabled,
      userNotificationSettings,
      this.receiverUserId,
      title,
      body
    )

    if (
      !userNotificationSettings.shouldSendPushNotification({
        receiverUserId: this.receiverUserId
      })
    ) {
      return
    }

    const devices: Device[] = userNotificationSettings.getDevices(
      this.receiverUserId
    )
    const pushes = await Promise.all(
      devices.map((device) =>
        sendPushNotification(
          {
            type: device.type,
            badgeCount:
              userNotificationSettings.getBadgeCount(this.receiverUserId) + 1,
            targetARN: device.awsARN
          },
          {
            title,
            body,
            data: {
              type: 'TrendingGenre',
              id: `timestamp:${this.getNotificationTimestamp()}:group_id:${
                this.notification.group_id
              }`,
              entityId: this.trackId,
              rank: this.rank,
              genre: this.genre,
              shareCard: true
            },
            imageUrl
          }
        )
      )
    )
    await disableDeviceArns(this.identityDB, pushes)
    await this.incrementBadgeCount(this.receiverUserId)
  }
}
