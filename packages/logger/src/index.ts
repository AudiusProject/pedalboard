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
    level: process.env.NODE_ENV === 'test' ? 'error' : level,
    formatters
  })
}
