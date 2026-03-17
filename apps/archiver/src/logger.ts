import { createLogger, type Logger } from '@pedalboard/logger'
import pinoHttp from 'pino-http'
import { readConfig } from './config'

export type { Logger }
export const logger = createLogger('archiver', readConfig().logLevel)
// pino-http expects a slightly different pino Logger shape; cast to satisfy its types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const httpLogger = pinoHttp({ logger: logger as any })
