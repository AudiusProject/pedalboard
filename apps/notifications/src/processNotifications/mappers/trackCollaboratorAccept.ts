import { Knex } from 'knex'
import { EntityType } from '../../email/notifications/types'
import { ResourceIds, Resources } from '../../email/notifications/renderEmail'
import { sendPushNotification } from '../../sns'
import { NotificationRow } from '../../types/dn'
import { TrackCollaboratorAcceptNotification } from '../../types/notifications'
import { disableDeviceArns } from '../../utils/disableArnEndpoint'
import { sendBrowserNotification } from '../../web'
import { BaseNotification } from './base'
import {
  Device,
  buildUserNotificationSettings
} from './userNotificationSettings'

type TrackCollaboratorAcceptRow = Omit<NotificationRow, 'data'> & {
  data: TrackCollaboratorAcceptNotification
}

const body = (collaboratorName: string, trackTitle: string): string =>
  `${collaboratorName} accepted your invitation to collaborate on ${trackTitle}.`

export class TrackCollaboratorAccept extends BaseNotification<TrackCollaboratorAcceptRow> {
  trackId: number
  collaboratorUserId: number
  inviterUserId: number

  constructor(
    dnDB: Knex,
    identityDB: Knex,
    notification: TrackCollaboratorAcceptRow
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
    const collaboratorName = users[this.collaboratorUserId].name

    // Notify the inviter (track owner)
    const userNotificationSettings = await buildUserNotificationSettings(
      this.identityDB,
      [this.inviterUserId]
    )

    const title = 'Collaboration Accepted'
    const notificationBody = body(collaboratorName, trackTitle)

    await sendBrowserNotification(
      isBrowserPushEnabled,
      userNotificationSettings,
      this.inviterUserId,
      title,
      notificationBody
    )

    if (
      userNotificationSettings.shouldSendPushNotification({
        receiverUserId: this.inviterUserId,
        initiatorUserId: this.collaboratorUserId
      })
    ) {
      const devices: Device[] = userNotificationSettings.getDevices(
        this.inviterUserId
      )
      const pushes = await Promise.all(
        devices.map((device) => {
          return sendPushNotification(
            {
              type: device.type,
              badgeCount:
                userNotificationSettings.getBadgeCount(this.inviterUserId) + 1,
              targetARN: device.awsARN
            },
            {
              title,
              body: notificationBody,
              data: {
                id: `timestamp:${this.getNotificationTimestamp()}:group_id:${
                  this.notification.group_id
                }`,
                type: 'TrackCollaboratorAccept',
                entityId: this.trackId
              }
            }
          )
        })
      )
      await disableDeviceArns(this.identityDB, pushes)
      await this.incrementBadgeCount(this.inviterUserId)
    }
  }

  getResourcesForEmail(): ResourceIds {
    return {
      users: new Set([this.collaboratorUserId])
    }
  }

  formatEmailProps(resources: Resources) {
    const user = resources.users[this.collaboratorUserId]
    return {
      type: this.notification.type,
      users: [user]
    }
  }
}
