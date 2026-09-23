import { Knex } from 'knex'
import { NotificationRow } from '../../types/dn'
import { WeeklyRotationNotification } from '../../types/notifications'
import { BaseNotification } from './base'
import { sendPushNotification } from '../../sns'
import { sendBrowserNotification } from '../../web'
import {
  buildUserNotificationSettings,
  Device
} from './userNotificationSettings'
import { disableDeviceArns } from '../../utils/disableArnEndpoint'

type WeeklyRotationNotificationRow = Omit<NotificationRow, 'data'> & {
  data: WeeklyRotationNotification
}

export const weeklyRotationMessages = {
  title: '🎧 Your Weekly Rotation Is Ready',
  body: 'A fresh mix of tracks picked just for you. Give it a spin before it rotates next Wednesday.'
}

/**
 * Push for the Wednesday Weekly Rotation rollover. Rows are written once per
 * listener per period by the api's WeeklyRotationNotificationsJob
 * (group_id `weekly_rotation:<YYYY-WW>:<user>`).
 *
 * No rich image: the og collage is rendered from the mix, so attaching it
 * would compute a mix per recipient.
 */
export class WeeklyRotation extends BaseNotification<WeeklyRotationNotificationRow> {
  receiverUserId: number

  constructor(
    dnDB: Knex,
    identityDB: Knex,
    notification: WeeklyRotationNotificationRow
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
    const userNotificationSettings = await buildUserNotificationSettings(
      this.identityDB,
      [this.receiverUserId]
    )

    const { title, body } = weeklyRotationMessages

    await sendBrowserNotification(
      isBrowserPushEnabled,
      userNotificationSettings,
      this.receiverUserId,
      title,
      body
    )

    if (
      !userNotificationSettings.shouldSendPushNotification({
        initiatorUserId: this.receiverUserId,
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
              id: `timestamp:${this.getNotificationTimestamp()}:group_id:${
                this.notification.group_id
              }`,
              userIds: [this.receiverUserId],
              type: 'WeeklyRotation',
              entityType: 'User',
              entityId: this.receiverUserId
            }
          }
        )
      )
    )
    await disableDeviceArns(this.identityDB, pushes)
    await this.incrementBadgeCount(this.receiverUserId)
  }
}
