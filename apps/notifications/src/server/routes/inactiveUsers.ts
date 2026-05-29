import { Router, Request, Response } from 'express'
import { Knex } from 'knex'
import { logger } from '../../logger'
import {
  findInactiveUsers,
  insertTriggerNotification
} from '../../tasks/inactiveUserNotifications'

// Hard ceiling on returned ids regardless of requested limit (flood protection).
const MAX_LIMIT = 100000
const DEFAULT_WINDOW_HOURS = 1

function parsePositiveNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function createInactiveUsersRouter(discoveryDb: Knex): Router {
  const router = Router()

  router.get('/', async (req: Request, res: Response) => {
    const secret = process.env.ANNOUNCEMENT_SEND_SECRET
    if (!secret) {
      res.status(503).json({
        error:
          'inactive-users is disabled: set ANNOUNCEMENT_SEND_SECRET in env to enable.'
      })
      return
    }
    if (req.headers.authorization !== `Bearer ${secret}`) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const hours = parsePositiveNumber(req.query.hours)
    if (hours === null) {
      res.status(400).json({ error: 'Missing or invalid `hours` query param' })
      return
    }
    const windowHours =
      parsePositiveNumber(req.query.windowHours) ?? DEFAULT_WINDOW_HOURS
    const requestedLimit = parsePositiveNumber(req.query.limit)
    const limit = Math.min(requestedLimit ?? MAX_LIMIT, MAX_LIMIT)

    try {
      const userIds = await findInactiveUsers(
        discoveryDb,
        hours,
        windowHours,
        limit
      )
      logger.info(
        { hours, windowHours, count: userIds.length },
        'inactive-users computed'
      )
      res.json({ userIds, count: userIds.length, hours, windowHours })
    } catch (e) {
      logger.error(e, 'inactive-users query failed')
      res.status(500).json({
        error: e instanceof Error ? e.message : 'inactive-users query failed'
      })
    }
  })

  router.post('/', async (req: Request, res: Response) => {
    const secret = process.env.ANNOUNCEMENT_SEND_SECRET
    if (!secret) {
      res.status(503).json({
        error:
          'inactive-users is disabled: set ANNOUNCEMENT_SEND_SECRET in env to enable.'
      })
      return
    }
    if (req.headers.authorization !== `Bearer ${secret}`) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const {
      id,
      trigger_hours,
      heading,
      body,
      cta_link = null,
      image_url = null
    } = req.body as {
      id: string
      trigger_hours: number
      heading: string
      body: string
      cta_link?: string | null
      image_url?: string | null
    }

    const hours = parsePositiveNumber(trigger_hours)
    if (!id || !heading || !body || hours === null) {
      res.status(400).json({
        error:
          'Missing or invalid required fields: id, trigger_hours, heading, body'
      })
      return
    }

    try {
      const userIds = await findInactiveUsers(discoveryDb, hours, 1, 100_000)
      if (userIds.length === 0) {
        res.json({ sent: 0 })
        return
      }
      await insertTriggerNotification(
        discoveryDb,
        { id, heading, body, cta_link, image_url },
        userIds,
        new Date()
      )
      res.json({ sent: userIds.length })
    } catch (e) {
      logger.error(e, 'inactive-users trigger send failed')
      res.status(500).json({
        error:
          e instanceof Error ? e.message : 'inactive-users trigger send failed'
      })
    }
  })

  return router
}
