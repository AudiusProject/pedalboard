import { NextFunction, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'

import { logger } from '../logger'

// Establishes a request-scoped child logger (used by route handlers and the
// error handler). Does not emit an access log of its own — request/response
// access logging is handled by the ingress in front of solana-relay.
export const incomingRequestLogger = (
  request: Request,
  response: Response,
  next: NextFunction
) => {
  const startTime = new Date().getTime()
  response.locals.requestStartTime = startTime
  const requestId = uuidv4()
  const { path, method } = request
  response.locals.requestId = requestId
  response.locals.logger = logger.child({
    requestId,
    path,
    method
  })
  next()
}
