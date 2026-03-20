import { Router, Request, Response } from 'express'
import { Knex } from 'knex'
import { logger } from '../../logger'

const containsHtml = (value: string): boolean => /<[^>]*>/.test(value)
const normalizeRoute = (value: string): string | null => {
  const input = value.trim()
  if (!input) return null
  if (input.startsWith('/')) return input
  try {
    const url = new URL(input)
    const isAudiusDomain =
      url.hostname === 'audius.co' || url.hostname.endsWith('.audius.co')
    if (!isAudiusDomain) return null
    return `${url.pathname}${url.search}${url.hash}` || '/'
  } catch {
    return null
  }
}

export function createSendAnnouncementRouter(discoveryDb: Knex): Router {
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
    const { title, body, image_url, route, userIds, notification_campaign_id } =
      req.body
    if (!title || !body || !Array.isArray(userIds) || userIds.length === 0) {
      res.status(400).json({
        error: 'Missing required fields: title, body, userIds (non-empty array)'
      })
      return
    }

    try {
      const titleText = String(title).trim()
      const bodyText = String(body).trim()
      if (containsHtml(titleText) || containsHtml(bodyText)) {
        res.status(400).json({
          error:
            'HTML is not allowed in announcement title/body. Send plain text only.'
        })
        return
      }
      const normalizedRoute =
        route != null ? normalizeRoute(String(route)) : undefined
      if (route != null && !normalizedRoute) {
        res.status(400).json({
          error:
            'Invalid route. Use an app path like /feed or an audius.co URL.'
        })
        return
      }
      const sanitizedUserIds = Array.from(
        new Set(
          userIds
            .map((id: unknown) =>
              Number.isFinite(Number(id)) ? Number(id) : NaN
            )
            .filter((id: number) => Number.isInteger(id) && id > 0)
        )
      )

      if (sanitizedUserIds.length === 0) {
        res.status(400).json({
          error: 'userIds must contain at least one positive integer'
        })
        return
      }

      const imageUrlText =
        image_url != null && String(image_url).trim().length > 0
          ? String(image_url).trim()
          : undefined

      const campaignIdRaw =
        notification_campaign_id != null &&
        String(notification_campaign_id).trim().length > 0
          ? String(notification_campaign_id).trim()
          : undefined

      await discoveryDb('notification').insert({
        specifier: '',
        group_id: `announcement:manual:${Date.now()}`,
        type: 'announcement',
        timestamp: new Date(),
        user_ids: sanitizedUserIds,
        data: {
          title: titleText,
          short_description: bodyText,
          push_body: bodyText,
          ...(normalizedRoute ? { route: normalizedRoute } : {}),
          ...(imageUrlText ? { image_url: imageUrlText } : {}),
          ...(campaignIdRaw
            ? { notification_campaign_id: campaignIdRaw }
            : {})
        }
      })
      logger.info(
        { totalRequested: sanitizedUserIds.length },
        'send-announcement queued'
      )
      // Return "sent" for compatibility with existing dashboard batching logic.
      res.json({
        sent: sanitizedUserIds.length,
        total: sanitizedUserIds.length
      })
    } catch (e) {
      logger.error(e, 'send-announcement failed')
      res.status(500).json({
        error: e instanceof Error ? e.message : 'Send announcement failed'
      })
    }
  })
  return router
}
