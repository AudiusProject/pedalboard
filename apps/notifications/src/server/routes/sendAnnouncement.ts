import { Router, Request, Response } from 'express'
import { Knex } from 'knex'
import { buildUserNotificationSettings } from '../../processNotifications/mappers/userNotificationSettings'
import { sendPushNotification } from '../../sns'
import { disableDeviceArns } from '../../utils/disableArnEndpoint'
import { logger } from '../../logger'

async function incrementBadgeCount(identityDb: Knex, userId: number) {
  await identityDb('PushNotificationBadgeCounts')
    .insert({
      userId,
      iosBadgeCount: 1,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    .onConflict('userId')
    .merge({
      iosBadgeCount: identityDb.raw('?? + ?', [
        'PushNotificationBadgeCounts.iosBadgeCount',
        1
      ]),
      updatedAt: new Date()
    })
}

export function createSendAnnouncementRouter(identityDb: Knex): Router {
  const router = Router()
  router.post('/', async (req: Request, res: Response) => {
    const secret = process.env.ANNOUNCEMENT_SEND_SECRET
    if (!secret) {
      res.status(503).json({
        error:
          'Send-announcement is disabled: set ANNOUNCEMENT_SEND_SECRET in env to enable.'
      })
      return
    }
    const auth = req.headers.authorization
    if (auth !== `Bearer ${secret}`) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const { title, body, imageUrl, ctaLink, userIds } = req.body
    if (!title || !body || !Array.isArray(userIds) || userIds.length === 0) {
      res.status(400).json({
        error: 'Missing required fields: title, body, userIds (non-empty array)'
      })
      return
    }

    try {
      const userNotificationSettings = await buildUserNotificationSettings(
        identityDb,
        userIds
      )
      let sent = 0
      for (const userId of userIds) {
        if (
          !userNotificationSettings.shouldSendPushNotification({
            receiverUserId: userId
          })
        ) {
          continue
        }
        const devices = userNotificationSettings.getDevices(userId) ?? []
        if (devices.length === 0) continue
        const badgeCount = userNotificationSettings.getBadgeCount(userId) + 1
        const pushes = await Promise.all(
          devices.map((device) =>
            sendPushNotification(
              {
                type: device.type,
                badgeCount,
                targetARN: device.awsARN
              },
              {
                title,
                body,
                data: {
                  type: 'Announcement',
                  ...(ctaLink ? { ctaLink } : {}),
                  ...(imageUrl ? { imageUrl: imageUrl } : {})
                },
                imageUrl: imageUrl
              }
            )
          )
        )
        await disableDeviceArns(identityDb, pushes)
        await incrementBadgeCount(identityDb, userId)
        sent += 1
      }
      logger.info(
        { totalRequested: userIds.length, sent },
        'send-announcement completed'
      )
      res.json({ sent, total: userIds.length })
    } catch (e) {
      logger.error(e, 'send-announcement failed')
      res.status(500).json({
        error: e instanceof Error ? e.message : 'Send announcement failed'
      })
    }
  })
  return router
}
