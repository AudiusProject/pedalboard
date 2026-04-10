import { Knex } from 'knex'
import { NotificationRow, UserRow } from '../../types/dn'
import { FanClubTextPostNotification } from '../../types/notifications'
import { BaseNotification } from './base'
import { sendPushNotification } from '../../sns'
import {
  buildUserNotificationSettings,
  Device
} from './userNotificationSettings'
import { sendBrowserNotification } from '../../web'
import { disableDeviceArns } from '../../utils/disableArnEndpoint'
import { formatImageUrl } from '../../utils/format'

export type FanClubTextPostRow = Omit<NotificationRow, 'data'> & {
  data: FanClubTextPostNotification
}

export class FanClubTextPost extends BaseNotification<FanClubTextPostRow> {
  constructor(dnDB: Knex, identityDB: Knex, notification: FanClubTextPostRow) {
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

    const receiverUserId = userIds[0]
    const entityUserId = this.notification.data.entity_user_id

    // Fetch artist info
    const users: Array<{
      user_id: number
      name: string
      is_deactivated: boolean
      profile_picture_sizes?: string | null
    }> = await this.dnDB
      .select('user_id', 'name', 'is_deactivated', 'profile_picture_sizes')
      .from<UserRow>('users')
      .where('is_current', true)
      .whereIn('user_id', [receiverUserId, entityUserId])

    const userMap = users.reduce((acc, user) => {
      acc[user.user_id] = user
      return acc
    }, {} as Record<number, (typeof users)[0]>)

    if (userMap[receiverUserId]?.is_deactivated) {
      return
    }

    const artistName = userMap[entityUserId]?.name ?? ''

    // Fetch artist coin ticker for deep linking
    const artistCoin = await this.dnDB
      .select('ticker')
      .from('artist_coins')
      .where('user_id', entityUserId)
      .first()
    const ticker = artistCoin?.ticker

    // Determine if the post includes a video by looking up the comment
    const commentId = this.notification.data.comment_id
    const comment = await this.dnDB
      .select('video_url')
      .from('comments')
      .where('comment_id', commentId)
      .first()
    const hasVideo = !!comment?.video_url

    // Get artist profile picture for rich notification
    let imageUrl: string | undefined
    if (userMap[entityUserId]?.profile_picture_sizes) {
      imageUrl = formatImageUrl(
        userMap[entityUserId].profile_picture_sizes!,
        150
      )
    }

    const userNotificationSettings = await buildUserNotificationSettings(
      this.identityDB,
      [receiverUserId]
    )

    const title = 'New Fan Club Post'
    const body = hasVideo
      ? `${artistName} shared a video with their fan club`
      : `${artistName} posted in their fan club`

    // Send browser push
    await sendBrowserNotification(
      isBrowserPushEnabled,
      userNotificationSettings,
      receiverUserId,
      title,
      body
    )

    // Send mobile push if enabled
    if (
      userNotificationSettings.shouldSendPushNotification({
        receiverUserId
      })
    ) {
      const devices: Device[] =
        userNotificationSettings.getDevices(receiverUserId)
      const pushes = await Promise.all(
        devices.map((device) => {
          return sendPushNotification(
            {
              type: device.type,
              badgeCount:
                userNotificationSettings.getBadgeCount(receiverUserId) + 1,
              targetARN: device.awsARN
            },
            {
              title,
              body,
              data: {
                id: `timestamp:${this.getNotificationTimestamp()}:group_id:${
                  this.notification.group_id
                }`,
                type: 'FanClubTextPost',
                entityUserId,
                commentId,
                ticker
              },
              imageUrl
            }
          )
        })
      )
      await disableDeviceArns(this.identityDB, pushes)
      await this.incrementBadgeCount(receiverUserId)
    }
  }
}
