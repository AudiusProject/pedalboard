import { Knex } from 'knex'
import { NotificationRow } from '../../types/dn'
import { RemixContestUpdateNotification } from '../../types/notifications'
import { BaseNotification } from './base'
import { sendPushNotification } from '../../sns'
import {
  buildUserNotificationSettings,
  Device
} from './userNotificationSettings'
import { sendBrowserNotification } from '../../web'
import { disableDeviceArns } from '../../utils/disableArnEndpoint'
import { formatImageUrl } from '../../utils/format'

export type RemixContestUpdateRow = Omit<NotificationRow, 'data'> & {
  data: RemixContestUpdateNotification
}

export class RemixContestUpdate extends BaseNotification<RemixContestUpdateRow> {
  constructor(
    dnDB: Knex,
    identityDB: Knex,
    notification: RemixContestUpdateRow
  ) {
    super(dnDB, identityDB, notification)
  }

  async processNotification({
    isBrowserPushEnabled
  }: {
    isBrowserPushEnabled: boolean
  }) {
    const userIds = this.notification.user_ids ?? []
    if (!userIds.length) {
      return
    }

    const contestTrackId =
      this.notification.data.entity_id ??
      (
        await this.dnDB
          .select('entity_id')
          .from('events')
          .where('event_id', this.notification.data.event_id)
          .first()
      )?.entity_id

    const hostRes: Array<{ user_id: number; name: string; profile_picture_sizes: string | null }> =
      await this.dnDB
        .select('user_id', 'name', 'profile_picture_sizes')
        .from('users')
        .where('is_current', true)
        .whereIn('user_id', [this.notification.data.entity_user_id])
    const hostName = hostRes[0]?.name ?? ''

    const trackRes: Array<{
      track_id: number
      title: string
      cover_art_sizes?: string | null
    }> = contestTrackId
      ? await this.dnDB
          .select('track_id', 'title', 'cover_art_sizes')
          .from('tracks')
          .where('is_current', true)
          .whereIn('track_id', [contestTrackId])
      : []
    const track = trackRes[0]
    const trackName = track?.title ?? 'the contest'

    let imageUrl: string | undefined
    if (track?.cover_art_sizes) {
      imageUrl = formatImageUrl(track.cover_art_sizes, 150)
    } else if (hostRes[0]?.profile_picture_sizes) {
      imageUrl = formatImageUrl(hostRes[0].profile_picture_sizes, 150)
    }

    const userNotificationSettings = await buildUserNotificationSettings(
      this.identityDB,
      userIds
    )
    const title = 'Contest update'
    const body = `${hostName} posted an update in ${trackName}`

    for (const userId of userIds) {
      await sendBrowserNotification(
        isBrowserPushEnabled,
        userNotificationSettings,
        userId,
        title,
        body
      )

      if (
        userNotificationSettings.shouldSendPushNotification({
          receiverUserId: userId
        })
      ) {
        const devices: Device[] = userNotificationSettings.getDevices(userId)
        const pushes = await Promise.all(
          devices.map((device) => {
            return sendPushNotification(
              {
                type: device.type,
                badgeCount: userNotificationSettings.getBadgeCount(userId) + 1,
                targetARN: device.awsARN
              },
              {
                title,
                body,
                data: {
                  id: `timestamp:${this.getNotificationTimestamp()}:group_id:${
                    this.notification.group_id
                  }`,
                  type: 'RemixContestUpdate',
                  eventId: this.notification.data.event_id,
                  commentId: this.notification.data.comment_id,
                  entityId: contestTrackId ?? 0,
                  entityUserId: this.notification.data.entity_user_id
                },
                imageUrl
              }
            )
          })
        )
        await disableDeviceArns(this.identityDB, pushes)
        await this.incrementBadgeCount(userId)
      }
    }
  }
}
