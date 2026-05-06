import { renderEmail } from './renderEmail'

import { EmailNotification } from '../../types/notifications'
import { config } from '../../config'
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
    const emailSubject = `${notificationCount} unread notification${
      notificationCount > 1 ? 's' : ''
    } on Audius`
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
  /**
   * Skip the global transactional-email sample rate
   * (`config.notificationEmailSampleDenominator`) and always send.
   * Reserved for must-deliver flows where dropping the email would be
   * a real bug — USDC purchase / transfer / withdrawal confirmations
   * and account-management request emails. Defaults to `false`, so
   * volume-heavy transactional sends (welcome, claimable reward,
   * reward in cooldown) are sampled to cap SendGrid usage.
   */
  bypassSampling?: boolean
}

export const sendTransactionalEmail = async ({
  email,
  html,
  subject,
  from = 'Audius <team@audius.co>',
  bypassSampling = false
}: SendTransactionalEmailArgs) => {
  // Sample 1-in-N of all non-bypassed transactional sends. Mirrors the
  // existing digest-email sampling in processEmailNotifications (uses
  // the same `notificationEmailSampleDenominator` knob) so volume can
  // be tuned with one env var. The guard `sampleDenom > 1` makes
  // `NOTIFICATION_EMAIL_SAMPLE_DENOMINATOR=1` a clean disable, and the
  // `Number.isFinite` check avoids accidental "always skip" if someone
  // sets the env to `Infinity` / a negative value.
  if (!bypassSampling) {
    const sampleDenom = Math.floor(config.notificationEmailSampleDenominator)
    if (
      Number.isFinite(sampleDenom) &&
      sampleDenom > 1 &&
      Math.random() > 1 / sampleDenom
    ) {
      logger.debug(
        `sendTransactionalEmail | sampled out (1/${sampleDenom}) — to=${email}, subject=${subject}`
      )
      return false
    }
  }
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
