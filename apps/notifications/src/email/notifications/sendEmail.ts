import { renderEmail } from './renderEmail'

import { EmailNotification } from '../../types/notifications'
import { logger } from '../../logger'
import { getSendgrid } from '../../sendgrid'
import { MailDataRequired } from '@sendgrid/mail'
import { Knex } from 'knex'
import { EmailFrequency } from '../../processNotifications/mappers/userNotificationSettings'

// id of unsubscribe group at https://mc.sendgrid.com/unsubscribe-groups
const NOTIFICATION_EMAIL_UNSUBSCRIBE_GROUP_ID = 19141
const TRANSACTIONAL_EMAIL_UNSUBSCRIBE_GROUP_ID = 23583

// Sendgrid object

type SendNotificationEmailProps = {
  userId: number
  email: string
  frequency: EmailFrequency
  notifications: EmailNotification[]
  dnDb: Knex
  identityDb: Knex
  sendAt?: number // unix timestamp in seconds
  timezone?: string
  /**
   * Optional SendGrid custom args, echoed on every webhook event. Used for
   * per-campaign attribution (e.g. announcements) in the notifications
   * dashboard. Values must be strings per SendGrid.
   */
  customArgs?: Record<string, string>
}

// Set of notifications that we do NOT send out emails for
// NOTE: This is to match parity with what identity does
const notificationsWithoutEmail = new Set([
  'supporter_dethroned',
  'tier_change',
  'tip_send'
])

// Master function to render and send email for a given userId
export const sendNotificationEmail = async ({
  userId,
  email,
  frequency,
  notifications,
  dnDb,
  identityDb,
  sendAt,
  timezone,
  customArgs
}: SendNotificationEmailProps) => {
  if (email === undefined) {
    return
  }
  try {
    logger.debug(`SendNotificationEmail | ${userId}, ${email}, ${frequency}`)
    const validNotifications = notifications.filter(
      (n) => !notificationsWithoutEmail.has(n.type)
    )
    const notificationCount = validNotifications.length
    let emailSubject = `${notificationCount} unread notification${
      notificationCount > 1 ? 's' : ''
    } on Audius`
    // A single announcement (e.g. a re-engagement campaign) gets its heading as
    // the subject instead of the generic unread-notification count. Falls back
    // to the generic subject when there's no heading or multiple notifications.
    if (notificationCount === 1) {
      const only = validNotifications[0]
      const announcementTitle =
        'type' in only &&
        only.type === 'announcement' &&
        'data' in only &&
        typeof only.data?.title === 'string'
          ? only.data.title.trim()
          : ''
      if (announcementTitle.length > 0) {
        emailSubject = announcementTitle
      }
    }
    if (notificationCount === 0) {
      logger.debug(
        `renderAndSendNotificationEmail | 0 notifications detected for user ${userId}, bypassing email`
      )
      return false
    }

    const notifHtml = await renderEmail({
      userId,
      email,
      frequency,
      notifications: validNotifications,
      dnDb,
      identityDb,
      timezone
    })

    const emailParams: MailDataRequired = {
      from: 'Audius <notify@audius.co>',
      to: `${email}`,
      bcc: 'audius-email-test@audius.co',
      html: notifHtml,
      subject: emailSubject,
      asm: {
        groupId: NOTIFICATION_EMAIL_UNSUBSCRIBE_GROUP_ID
      },
      // Explicitly enable click tracking so SendGrid rewrites links and emits
      // `click` events (consumed by the notifications-dashboard webhook for
      // email engagement analytics) rather than relying on the account-global
      // toggle. Open tracking is disabled: Apple Mail Privacy Protection
      // pre-fetches the open pixel for ~half of traffic, making opens noise —
      // clicks are the trustworthy email signal.
      trackingSettings: {
        clickTracking: { enable: true, enableText: true },
        openTracking: { enable: false }
      }
    }

    if (sendAt) {
      emailParams.sendAt = sendAt
    }

    if (customArgs && Object.keys(customArgs).length > 0) {
      // Echoed back on every SendGrid Event Webhook call for attribution.
      emailParams.customArgs = customArgs
    }

    // Send email
    await sendEmail(emailParams)

    logger.info(
      {
        job: 'renderAndSendNotificationEmail'
      },
      `renderAndSendNotificationEmail | sent email to ${userId} at ${email}`
    )
    return true
  } catch (e) {
    logger.error(`Error in renderAndSendNotificationEmail ${e.stack}`)
    return false
  }
}

type SendTransactionalEmailArgs = {
  email: string
  html: string
  subject: string
  /**
   * Override the default `Audius <team@audius.co>` sender. Used by the
   * post-signup welcome email to keep its `The Audius Team <…>`
   * envelope.
   */
  from?: string
}

export const sendTransactionalEmail = async ({
  email,
  html,
  subject,
  from = 'Audius <team@audius.co>'
}: SendTransactionalEmailArgs) => {
  try {
    logger.debug(`SendTransactionalEmail | ${email}, ${subject}`)
    const emailParams = {
      from,
      to: `${email}`,
      html,
      subject,
      asm: {
        groupId: TRANSACTIONAL_EMAIL_UNSUBSCRIBE_GROUP_ID
      }
    }
    await sendEmail(emailParams)
    return true
  } catch (e) {
    logger.error(`Error in sendTransactionalEmail ${e.stack}`)
    return false
  }
}

export const sendEmail = async (emailParams: MailDataRequired) => {
  const sg = getSendgrid()
  if (sg !== null) {
    await sg.send(emailParams)
  }
}
