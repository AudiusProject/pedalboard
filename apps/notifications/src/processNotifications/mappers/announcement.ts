import { Knex } from 'knex'
import { NotificationRow } from '../../types/dn'
import {
  AnnouncementNotification,
  AppEmailNotification
} from '../../types/notifications'
import { BaseNotification } from './base'
import { sendPushNotification } from '../../sns'
import { ResourceIds, Resources } from '../../email/notifications/renderEmail'
import { sendNotificationEmail } from '../../email/notifications/sendEmail'
import {
  buildUserNotificationSettings,
  Device
} from './userNotificationSettings'
import { UserNotificationSettings } from './userNotificationSettings'
import { logger } from '../../logger'
import { disableDeviceArns } from '../../utils/disableArnEndpoint'
import { sendBrowserNotification } from '../../web'

const containsHtml = (value: string): boolean => /<[^>]*>/.test(value)

type AnnouncementNotificationRow = Omit<NotificationRow, 'data'> & {
  data: AnnouncementNotification
}
export class Announcement extends BaseNotification<AnnouncementNotificationRow> {
  constructor(
    dnDB: Knex,
    identityDB: Knex,
    notification: AnnouncementNotificationRow
  ) {
    super(dnDB, identityDB, notification)
  }

  async processNotification({
    isLiveEmailEnabled,
    isBrowserPushEnabled
  }: {
    isLiveEmailEnabled: boolean
    isBrowserPushEnabled: boolean
  }) {
    const explicitUserIds = Array.isArray(this.notification.user_ids)
      ? this.notification.user_ids.filter(
          (id): id is number => Number.isInteger(id) && id > 0
        )
      : null

    if (!explicitUserIds || explicitUserIds.length === 0) {
      logger.warn(
        {
          groupId: this.notification.group_id,
          notificationId: this.notification.id
        },
        'Skipping announcement with no explicit user_ids'
      )
      return
    }

    await this.broadcastAnnouncement(
      explicitUserIds,
      isLiveEmailEnabled,
      isBrowserPushEnabled
    )
    logger.info(
      { userCount: explicitUserIds.length },
      'announcement complete for explicit user_ids'
    )
  }

  getResourcesForEmail(): ResourceIds {
    return {}
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  formatEmailProps(resources: Resources) {
    return {
      type: this.notification.type,
      title: this.notification.data.title,
      text: this.notification.data.short_description
    }
  }

  async broadcastAnnouncement(
    userIds: number[],
    isLiveEmailEnabled: boolean,
    isBrowserPushEnabled: boolean
  ) {
    const userNotificationSettings = await buildUserNotificationSettings(
      this.identityDB,
      userIds
    )
    for (const userId of userIds) {
      await this.broadcastPushNotificationAnnouncements(
        userId,
        userNotificationSettings,
        isBrowserPushEnabled
      )
      await this.broadcastEmailAnnouncements(
        isLiveEmailEnabled,
        userId,
        userNotificationSettings
      )
    }
  }

  async broadcastPushNotificationAnnouncements(
    userId: number,
    userNotificationSettings: UserNotificationSettings,
    isBrowserPushEnabled: boolean
  ) {
    const shouldSend = userNotificationSettings.shouldSendPushNotification({
      receiverUserId: userId
    })
    if (!shouldSend) {
      logger.info(
        { userId, notificationId: this.notification.id },
        'announcement: skipping push — shouldSendPushNotification returned false'
      )
    }
    if (shouldSend) {
      const title = this.notification.data.title ?? ''
      const body = this.notification.data.short_description ?? ''
      const pushBody = this.notification.data.push_body || body
      const route = this.notification.data.route
      if (containsHtml(title) || containsHtml(body) || containsHtml(pushBody)) {
        logger.warn(
          {
            userId,
            groupId: this.notification.group_id,
            notificationId: this.notification.id
          },
          'Skipping announcement push with HTML content'
        )
        return
      }
      // purposefully leaving this without await,
      // so we don't have to wait for each user's to be sent
      // before the next's.
      sendBrowserNotification(
        isBrowserPushEnabled,
        userNotificationSettings,
        userId,
        title,
        body
      )
      const devices: Device[] = userNotificationSettings.getDevices(userId)
      logger.info(
        {
          userId,
          deviceCount: devices.length,
          deviceTypes: devices.map((d) => d.type),
          notificationId: this.notification.id
        },
        'announcement: sending push to devices'
      )
      if (devices.length === 0) {
        logger.info({ userId }, 'announcement: user has no registered devices')
        return
      }
      const rawImage = this.notification.data.image_url
      const imageUrlForPush =
        typeof rawImage === 'string' && rawImage.trim().length > 0
          ? rawImage.trim()
          : undefined
      const pushes = await Promise.all(
        devices.map((device) => {
          // this may get rate limited by AWS
          return sendPushNotification(
            {
              type: device.type,
              badgeCount: userNotificationSettings.getBadgeCount(userId) + 1,
              targetARN: device.awsARN
            },
            {
              title,
              body: pushBody,
              ...(imageUrlForPush ? { imageUrl: imageUrlForPush } : {}),
              data: {
                id: `timestamp:${this.getNotificationTimestamp()}:group_id:${
                  this.notification.group_id
                }`,
                type: 'Announcement',
                ...this.notification.data,
                title,
                short_description: body,
                push_body: pushBody,
                ...(route ? { route } : {})
              }
            }
          )
        })
      )
      logger.info(
        {
          userId,
          pushResults: pushes.map((p) => ({
            endpointDisabled: p?.endpointDisabled ?? false
          }))
        },
        'announcement: push results'
      )
      await disableDeviceArns(this.identityDB, pushes)
      await this.incrementBadgeCount(userId)
    }
  }

  async broadcastEmailAnnouncements(
    isLiveEmailEnabled: boolean,
    userId: number,
    userNotificationSettings: UserNotificationSettings
  ) {
    if (
      isLiveEmailEnabled &&
      userNotificationSettings.shouldSendEmailAtFrequency({
        receiverUserId: userId,
        frequency: 'live'
      })
    ) {
      const notification: AppEmailNotification = {
        receiver_user_id: userId,
        ...this.notification
      }
      sendNotificationEmail({
        userId: userId,
        email: userNotificationSettings.getUserEmail(userId),
        frequency: 'live',
        notifications: [notification],
        dnDb: this.dnDB,
        identityDb: this.identityDB
      })
    }
  }
}
