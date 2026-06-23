import pino, { stdTimeFunctions } from 'pino'

const formatters = {
  level(label: string) {
    // Set level to string format
    return { level: label.toUpperCase() }
  }
}

// set config for logger here
export const logger = pino({
  name: `solana-relay`,
  base: undefined,
  timestamp: stdTimeFunctions.isoTime,
  // Defaults to 'info' (filters debug). Set LOG_LEVEL=debug to re-enable
  // verbose per-request/per-transaction logging without a code change.
  level: process.env.LOG_LEVEL || 'info',
  formatters
})
