import { Router, Request, Response } from 'express'
import { Knex } from 'knex'
import { logger } from '../../logger'
import { findInactiveUsers } from '../../tasks/inactiveUserNotifications'

const parsePositiveInt = (value: unknown): number | null => {
  if (value == null || value === '') return null
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) return null
  return n
}

export function createInactiveUsersRouter(discoveryDb: Knex): Router {
  const router = Router()
  router.get('/', async (req: Request, res: Response) => {
    const secret = process.env.ANNOUNCEMENT_SEND_SECRET
    if (!secret) {
      res.status(503).json({
        error:
          'Inactive-users is disabled: set ANNOUNCEMENT_SEND_SECRET in env to enable.'
      })
      return
    }
    const auth = req.headers.authorization
    if (auth !== `Bearer ${secret}`) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const hours = parsePositiveInt(req.query.hours)
    const windowHours = parsePositiveInt(req.query.windowHours)
    const limit = parsePositiveInt(req.query.limit)
    if (hours === null || windowHours === null || limit === null) {
      res.status(400).json({
        error:
          'hours, windowHours and limit are required positive integers'
      })
      return
    }

    try {
      const userIds = await findInactiveUsers(
        discoveryDb,
        hours,
        windowHours,
        limit
      )
      res.json({ userIds })
    } catch (e) {
      logger.error(e, 'inactive-users query failed')
      res.status(500).json({
        error: e instanceof Error ? e.message : 'Inactive-users query failed'
      })
    }
  })
  return router
}
