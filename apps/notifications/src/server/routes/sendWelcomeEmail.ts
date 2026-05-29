import { Router, Request, Response } from 'express'
import { Knex } from 'knex'

import { logger } from '../../logger'
import { sendWelcomeEmail } from '../../email/notifications/welcomeEmail'

/**
 * `/internal/send-welcome-email` — Bearer-secret-protected endpoint that
 * the signup flow (or identity-service) calls right after a user is
 * created so the post-signup email goes out from this service. Replaces
 * the old `/email/welcome` route in identity-service.
 *
 * Trigger semantics: the caller is expected to invoke this on the
 * `user create / signup` event — pedalboard doesn't currently have a
 * notification-table or pg-notify hook for user creation (only
 * `notification` rows), so this stays a deliberate HTTP call mirroring
 * the existing internal-route pattern (see `sendNotification.ts`).
 *
 * Auth: `Authorization: Bearer ${WELCOME_EMAIL_SEND_SECRET}`. If the
 * env var isn't set the route disables itself — same pattern as
 * `sendNotification.ts`.
 *
 * Body: `{ userId: number, name: string, isNativeMobile?: boolean }`
 */
export function createSendWelcomeEmailRouter(identityDb: Knex): Router {
  const router = Router()

  router.post('/', async (req: Request, res: Response) => {
    const secret = process.env.WELCOME_EMAIL_SEND_SECRET
    if (!secret) {
      res.status(503).json({
        error:
          'Send-welcome-email is disabled: set WELCOME_EMAIL_SEND_SECRET in env to enable.'
      })
      return
    }
    const auth = req.headers.authorization
    if (auth !== `Bearer ${secret}`) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const { userId, name, isNativeMobile } = req.body ?? {}
    const parsedUserId =
      Number.isFinite(Number(userId)) && Number(userId) > 0
        ? Number(userId)
        : null
    const trimmedName =
      typeof name === 'string' && name.trim().length > 0 ? name.trim() : null

    if (parsedUserId === null) {
      res
        .status(400)
        .json({ error: 'userId is required and must be a positive integer' })
      return
    }
    if (trimmedName === null) {
      res.status(400).json({ error: 'name is required' })
      return
    }

    try {
      const result = await sendWelcomeEmail({
        identityDb,
        userId: parsedUserId,
        name: trimmedName,
        isNativeMobile: !!isNativeMobile
      })
      res.json(result)
    } catch (e) {
      logger.error(e, 'send-welcome-email failed')
      res.status(500).json({
        error: e instanceof Error ? e.message : 'Send welcome email failed'
      })
    }
  })

  return router
}
