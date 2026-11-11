import { Knex } from 'knex'
import { NotificationRow } from '../../types/dn'
import { WeeklyArtistRecapNotification } from '../../types/notifications'
import { BaseNotification } from './base'
import { sendPushNotification } from '../../sns'
import { sendBrowserNotification } from '../../web'
import {
  buildUserNotificationSettings,
  Device
} from './userNotificationSettings'
import { disableDeviceArns } from '../../utils/disableArnEndpoint'
import { logger } from '../../logger'

type WeeklyArtistRecapNotificationRow = Omit<NotificationRow, 'data'> & {
  data: WeeklyArtistRecapNotification
}

const plural = (count: number, noun: string) =>
  `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`

export const weeklyArtistRecapMessages = {
  title: 'Your Week on Audius',
  // e.g. "1,240 plays, 18 new followers, top city Atlanta, 42 saves".
  // Zero followers or saves and a missing city are left out.
  body: ({
    playCount,
    followerCount,
    saveCount,
    topCity
  }: {
    playCount: number
    followerCount: number
    saveCount: number
    topCity?: string
  }) =>
    [
      plural(playCount, 'play'),
      followerCount > 0 ? plural(followerCount, 'new follower') : null,
      topCity ? `top city ${topCity}` : null,
      saveCount > 0 ? plural(saveCount, 'save') : null
    ]
      .filter(Boolean)
      .join(', ')
}

/**
 * Weekly recap push for an artist: plays, new followers, top city and saves
 * for the period that just closed. Rows are written once per artist per
 * period on the Wednesday rollover by the api's
 * WeeklyArtistRecapNotificationsJob
 * (group_id `weekly_artist_recap:<YYYY-WW>:<artist>`). Tapping opens the
 * notifications screen, where the recap is shown in full.
 */
export class WeeklyArtistRecap extends BaseNotification<WeeklyArtistRecapNotificationRow> {
  receiverUserId: number

  constructor(
    dnDB: Knex,
    identityDB: Knex,
    notification: WeeklyArtistRecapNotificationRow
  ) {
    super(dnDB, identityDB, notification)
    const userIds: number[] = this.notification.user_ids ?? []
    this.receiverUserId = userIds[0]
  }

  async processNotification({
    isBrowserPushEnabled
  }: {
    isBrowserPushEnabled: boolean
  }) {
    const data = this.notification.data
    const title = weeklyArtistRecapMessages.title
    const body = weeklyArtistRecapMessages.body({
      playCount: data.play_count,
      followerCount: data.follower_count,
      saveCount: data.save_count,
      topCity: data.top_city
    })

    const userNotificationSettings = await buildUserNotificationSettings(
      this.identityDB,
      [this.receiverUserId]
    )

    const browserSent =
      (await sendBrowserNotification(
        isBrowserPushEnabled,
        userNotificationSettings,
        this.receiverUserId,
        title,
        body
      )) ?? 0

    const devices: Device[] = userNotificationSettings.getDevices(
      this.receiverUserId
    )

    const logSummary = (fields: {
      mobileSent: number
      mobileDisabled: number
      skippedReason?: 'no_mobile_devices' | 'abusive'
    }) =>
      logger.info(
        {
          notificationType: 'weekly_artist_recap',
          groupId: this.notification.group_id,
          userId: this.receiverUserId,
          browserPushEnabled: isBrowserPushEnabled,
          browserSent,
          mobileDevices: devices.length,
          ...fields
        },
        'weekly artist recap push processed'
      )

    if (
      !userNotificationSettings.shouldSendPushNotification({
        receiverUserId: this.receiverUserId
      })
    ) {
      logSummary({
        mobileSent: 0,
        mobileDisabled: 0,
        skippedReason: devices.length === 0 ? 'no_mobile_devices' : 'abusive'
      })
      return
    }

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
              id: `timestamp:${this.getNotificationTimestamp()}:group_id:${
                this.notification.group_id
              }`,
              userIds: [this.receiverUserId],
              type: 'WeeklyArtistRecap'
            }
          }
        )
      )
    )
    await disableDeviceArns(this.identityDB, pushes)
    await this.incrementBadgeCount(this.receiverUserId)

    const mobileDisabled = pushes.filter((p) => p.endpointDisabled).length
    logSummary({ mobileSent: pushes.length - mobileDisabled, mobileDisabled })
  }
}
