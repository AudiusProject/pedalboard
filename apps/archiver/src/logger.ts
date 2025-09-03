import pino from 'pino'
import pinoHttp from 'pino-http'
import { readConfig } from './config'

const formatters = {
  level(label: string) {
    // Set level to string format
    return { level: label.toUpperCase() }
  }
}

export type LogLevel = pino.LevelWithSilent

const { logLevel } = readConfig()

export const httpLogger = pinoHttp({
  level: logLevel,
  name: `archiver`,
  formatters,
  errorKey: 'error'
})

export const logger: typeof httpLogger.logger = httpLogger.logger
export type Logger = typeof logger
