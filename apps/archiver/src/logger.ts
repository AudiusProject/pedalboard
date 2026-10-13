import { createLogger, type Logger } from '@pedalboard/logger'
import pinoHttp from 'pino-http'
import { readConfig } from './config'
import { redactRequest } from './redact'

export type { Logger }
export const logger = createLogger('archiver', readConfig().logLevel)
export const httpLogger = pinoHttp({
  // pino-http expects a slightly different pino Logger shape; cast to satisfy its types
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logger: logger as any,
  // Never log credentials from request headers or query params
  serializers: { req: redactRequest }
})
