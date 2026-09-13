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
 * Announces the Wednesday Weekly Rotation rollover.
 *
 * Rows are written once per listener per period by the api repo's
 * WeeklyRotationNotificationsJob (group_id `weekly_rotation:<YYYY-WW>:<user>`).
 * There is no entity to link: the push and the in-app tile both open the
 * listener's own mix, which the client fetches on demand.
 *
 * Deliberately no rich image. The og collage for a mix is rendered from the
 * mix itself, so attaching it would make every device that receives the push
 * compute its owner's rotation at once.
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

    if (
      !userNotificationSettings.shouldSendPushNotification({
        initiatorUserId: this.receiverUserId,
        receiverUserId: this.receiverUserId
      })
    ) {
      return
    }

    await sendBrowserNotification(
      isBrowserPushEnabled,
      userNotificationSettings,
      this.receiverUserId,
      title,
      body
    )

    const devices: Device[] = userNotificationSettings.getDevices(
      this.receiverUserId
    )
    if (devices.length === 0) return

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
