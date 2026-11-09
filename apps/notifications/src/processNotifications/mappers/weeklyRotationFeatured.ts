import { Knex } from 'knex'
import { NotificationRow, TrackRow } from '../../types/dn'
import { WeeklyRotationFeaturedNotification } from '../../types/notifications'
import { BaseNotification } from './base'
import { sendPushNotification } from '../../sns'
import { sendBrowserNotification } from '../../web'
import {
  buildUserNotificationSettings,
  Device
} from './userNotificationSettings'
import { disableDeviceArns } from '../../utils/disableArnEndpoint'
import { formatImageUrl } from '../../utils/format'
import { logger } from '../../logger'

type WeeklyRotationFeaturedNotificationRow = Omit<NotificationRow, 'data'> & {
  data: WeeklyRotationFeaturedNotification
}

const pluralizeRotations = (count: number) =>
  `${count} Weekly Rotation${count === 1 ? '' : 's'}`

export const weeklyRotationFeaturedMessages = {
  title: '🎧 Featured in Weekly Rotation',
  body: ({
    trackTitle,
    trackCount,
    rotationCount
  }: {
    trackTitle?: string
    trackCount: number
    rotationCount: number
  }) =>
    trackCount > 1 || !trackTitle
      ? `Your tracks were featured in ${pluralizeRotations(
          rotationCount
        )} last week`
      : `Your ${trackTitle} was featured in ${pluralizeRotations(
          rotationCount
        )} last week`
}

/**
 * Push telling an artist how many listeners' Weekly Rotations included their
 * tracks. Rows are written once per artist per period, on the Wednesday
 * rollover for the period that just closed, by the api's
 * WeeklyRotationFeaturedNotificationsJob
 * (group_id `weekly_rotation_featured:<YYYY-WW>:<artist>`).
 *
 * Tapping opens the track when one track was featured, otherwise the artist's
 * own profile.
 */
export class WeeklyRotationFeatured extends BaseNotification<WeeklyRotationFeaturedNotificationRow> {
  receiverUserId: number
  trackId: number
  trackCount: number
  rotationCount: number

  constructor(
    dnDB: Knex,
    identityDB: Knex,
    notification: WeeklyRotationFeaturedNotificationRow
  ) {
    super(dnDB, identityDB, notification)
    const userIds: number[] = this.notification.user_ids ?? []
    this.receiverUserId = userIds[0]
    this.trackId = this.notification.data.track_id
    this.trackCount = this.notification.data.track_count
    this.rotationCount = this.notification.data.rotation_count
  }

  async processNotification({
    isBrowserPushEnabled
  }: {
    isBrowserPushEnabled: boolean
  }) {
    const track:
      | { title: string; cover_art_sizes?: string | null }
      | undefined = await this.dnDB
      .select('title', 'cover_art_sizes')
      .from<TrackRow>('tracks')
      .where('is_current', true)
      .where('track_id', this.trackId)
      .first()

    const isSingleTrack = this.trackCount === 1 && !!track
    const title = weeklyRotationFeaturedMessages.title
    const body = weeklyRotationFeaturedMessages.body({
      trackTitle: track?.title,
      trackCount: this.trackCount,
      rotationCount: this.rotationCount
    })
    const imageUrl =
      isSingleTrack && track?.cover_art_sizes
        ? formatImageUrl(track.cover_art_sizes, 1000)
        : undefined

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
          notificationType: 'weekly_rotation_featured',
          groupId: this.notification.group_id,
          userId: this.receiverUserId,
          browserPushEnabled: isBrowserPushEnabled,
          browserSent,
          mobileDevices: devices.length,
          ...fields
        },
        'weekly rotation featured push processed'
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
              type: 'WeeklyRotationFeatured',
              ...(isSingleTrack
                ? { entityType: 'Track', entityId: this.trackId }
                : { entityType: 'User', entityId: this.receiverUserId })
            },
            imageUrl
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
