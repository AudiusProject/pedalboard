import { Knex } from 'knex'
import { EntityType } from '../../email/notifications/types'
import { ResourceIds, Resources } from '../../email/notifications/renderEmail'
import { sendPushNotification } from '../../sns'
import { NotificationRow } from '../../types/dn'
import { TrackCollaboratorInviteNotification } from '../../types/notifications'
import { disableDeviceArns } from '../../utils/disableArnEndpoint'
import { sendBrowserNotification } from '../../web'
import { BaseNotification } from './base'
import {
  Device,
  buildUserNotificationSettings
} from './userNotificationSettings'

type TrackCollaboratorInviteRow = Omit<NotificationRow, 'data'> & {
  data: TrackCollaboratorInviteNotification
}

const body = (inviterName: string, trackTitle: string): string =>
  `${inviterName} invited you to collaborate on ${trackTitle}.`

export class TrackCollaboratorInvite extends BaseNotification<TrackCollaboratorInviteRow> {
  trackId: number
  collaboratorUserId: number
  inviterUserId: number

  constructor(
    dnDB: Knex,
    identityDB: Knex,
    notification: TrackCollaboratorInviteRow
  ) {
    super(dnDB, identityDB, notification)
    this.trackId = this.notification.data.track_id
    this.collaboratorUserId = this.notification.data.collaborator_user_id
    this.inviterUserId = this.notification.data.inviter_user_id
  }

  async processNotification({
    isBrowserPushEnabled
  }: {
    isBrowserPushEnabled: boolean
  }) {
    const users = await this.getUsersBasicInfo([
      this.collaboratorUserId,
      this.inviterUserId
    ])
    if (
      users?.[this.collaboratorUserId]?.is_deactivated ||
      users?.[this.inviterUserId]?.is_deactivated
    ) {
      return
    }

    const tracks = await this.fetchEntities([this.trackId], EntityType.Track)
    const trackTitle = tracks?.[this.trackId]?.title ?? 'a track'
    const inviterName = users[this.inviterUserId].name

    // Notify the invited collaborator
    const userNotificationSettings = await buildUserNotificationSettings(
      this.identityDB,
      [this.collaboratorUserId]
    )

    const title = 'Track Collaboration Invite'
    const notificationBody = body(inviterName, trackTitle)

    await sendBrowserNotification(
      isBrowserPushEnabled,
      userNotificationSettings,
      this.collaboratorUserId,
      title,
      notificationBody
    )

    if (
      userNotificationSettings.shouldSendPushNotification({
        receiverUserId: this.collaboratorUserId,
        initiatorUserId: this.inviterUserId
      })
    ) {
      const devices: Device[] = userNotificationSettings.getDevices(
        this.collaboratorUserId
      )
      const pushes = await Promise.all(
        devices.map((device) => {
          return sendPushNotification(
            {
              type: device.type,
              badgeCount:
                userNotificationSettings.getBadgeCount(
                  this.collaboratorUserId
                ) + 1,
              targetARN: device.awsARN
            },
            {
              title,
              body: notificationBody,
              data: {
                id: `timestamp:${this.getNotificationTimestamp()}:group_id:${
                  this.notification.group_id
                }`,
                type: 'TrackCollaboratorInvite',
                entityId: this.trackId
              }
            }
          )
        })
      )
      await disableDeviceArns(this.identityDB, pushes)
      await this.incrementBadgeCount(this.collaboratorUserId)
    }
  }

  getResourcesForEmail(): ResourceIds {
    return {
      users: new Set([this.inviterUserId])
    }
  }

  formatEmailProps(resources: Resources) {
    const user = resources.users[this.inviterUserId]
    return {
      type: this.notification.type,
      users: [user]
    }
  }
}
