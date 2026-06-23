import { NextFunction, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { logger } from '../logger'

// Establishes a request-scoped child logger (used by downstream middleware and
// error handlers). Does not emit an access log of its own — request/response
// access logging is handled by the ingress in front of relay.
export const incomingRequestLogger = (
  request: Request,
  response: Response,
  next: NextFunction
) => {
  const startTime = new Date(new Date().getTime())
  const requestId =
    typeof request.headers['X-Request-Id'] === 'string'
      ? (request.headers['X-Request-ID'] as string)
      : uuidv4()
  const oldCtx = response.locals.ctx
  const requestLogger = logger.child({ startTime, requestId })
  response.locals.ctx = {
    ...oldCtx,
    startTime,
    requestId,
    logger: requestLogger
  }
  next()
}
