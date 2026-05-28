import { Router, Request, Response } from 'express'
import { Knex } from 'knex'
import { logger } from '../../logger'

// Hard ceiling on returned ids regardless of requested limit (flood protection).
const MAX_LIMIT = 100000
const DEFAULT_WINDOW_HOURS = 1

function parsePositiveNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Users whose most recent activity aged into the [hours, hours + windowHours)
 * band and who have no activity since `hours` ago — i.e. they just crossed the
 * inactivity threshold. Callers run this on a cadence equal to windowHours so
 * each user is returned exactly once per inactivity episode (the band is the
 * dedup; no per-user state needed).
 *
 * NOTE: "activity" is currently a discovery `plays` row. If we move to an
 * app-open signal (identity service), only this query changes.
 */
async function findInactiveUsers(
  discoveryDb: Knex,
  hours: number,
  windowHours: number,
  limit: number
): Promise<number[]> {
  const rows = await discoveryDb
    .select<{ user_id: number }[]>('p.user_id')
    .from({ p: 'plays' })
    .whereNotNull('p.user_id')
    .andWhereRaw("p.created_at >= now() - (? * interval '1 hour')", [
      hours + windowHours
    ])
    .andWhereRaw("p.created_at < now() - (? * interval '1 hour')", [hours])
    .whereNotExists(function () {
      this.select(discoveryDb.raw('1'))
        .from({ p2: 'plays' })
        .whereRaw('p2.user_id = p.user_id')
        .andWhereRaw("p2.created_at >= now() - (? * interval '1 hour')", [
          hours
        ])
    })
    .groupBy('p.user_id')
    .limit(limit)
  return rows.map((r) => r.user_id)
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
  return router
}
