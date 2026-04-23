import { Knex } from 'knex'
import { NotificationRow } from '../../types/dn'
import { FanRemixContestSubmissionNotification } from '../../types/notifications'
import { BaseNotification } from './base'
import { sendPushNotification } from '../../sns'
import {
  buildUserNotificationSettings,
  Device
} from './userNotificationSettings'
import { sendBrowserNotification } from '../../web'
import { disableDeviceArns } from '../../utils/disableArnEndpoint'
import { formatImageUrl } from '../../utils/format'

export type FanRemixContestSubmissionRow = Omit<NotificationRow, 'data'> & {
  data: FanRemixContestSubmissionNotification
}

export class FanRemixContestSubmission extends BaseNotification<FanRemixContestSubmissionRow> {
  constructor(
    dnDB: Knex,
    identityDB: Knex,
    notification: FanRemixContestSubmissionRow
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

    const submitterRes: Array<{ user_id: number; name: string }> = await this.dnDB
      .select('user_id', 'name')
      .from('users')
      .where('is_current', true)
      .whereIn('user_id', [this.notification.data.submitter_user_id])
    const submitterName = submitterRes[0]?.name ?? 'Someone'

    const trackRes: Array<{
      track_id: number
      title: string
      cover_art_sizes?: string | null
    }> = await this.dnDB
      .select('track_id', 'title', 'cover_art_sizes')
      .from('tracks')
      .where('is_current', true)
      .whereIn('track_id', [this.notification.data.entity_id])
    const track = trackRes[0]
    const trackName = track?.title ?? 'a contest'
    const submissionTrackRes: Array<{ cover_art_sizes?: string | null }> =
      await this.dnDB
        .select('cover_art_sizes')
        .from('tracks')
        .where('is_current', true)
        .whereIn('track_id', [this.notification.data.submission_track_id])
    const submission = submissionTrackRes[0]

    let imageUrl: string | undefined
    if (submission?.cover_art_sizes) {
      imageUrl = formatImageUrl(submission.cover_art_sizes, 150)
    } else if (track?.cover_art_sizes) {
      imageUrl = formatImageUrl(track.cover_art_sizes, 150)
    }

    const userNotificationSettings = await buildUserNotificationSettings(
      this.identityDB,
      userIds
    )
    const title = 'New contest submission'
    const body = `${submitterName} submitted to ${trackName}`

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
                  type: 'FanRemixContestSubmission',
                  eventId: this.notification.data.event_id,
                  entityId: this.notification.data.entity_id,
                  entityUserId: this.notification.data.entity_user_id,
                  submissionTrackId: this.notification.data.submission_track_id
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
