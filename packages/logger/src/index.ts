import pino, { stdTimeFunctions } from 'pino'

export const log = (str: unknown): void => {
  console.error(str)
}

const formatters = {
  level (label: string) {
    return { level: label.toUpperCase() }
  }
}

export type Logger = pino.Logger

export function createLogger (name: string, level: string = 'info'): Logger {
  return pino({
    name,
    base: undefined,
    timestamp: stdTimeFunctions.isoTime,
    // LOG_LEVEL allows turning verbose (debug) logging back on in prod without a
    // code change; defaults to the level passed in (info), which filters debug.
    level:
      process.env.NODE_ENV === 'test'
        ? 'error'
        : process.env.LOG_LEVEL || level,
    formatters
  })
}
