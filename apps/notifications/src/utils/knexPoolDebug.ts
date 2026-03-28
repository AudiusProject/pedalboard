import type { Knex } from 'knex'

import { logger } from '../logger'

type TarnLikePool = {
  numUsed?: () => number
  numFree?: () => number
  numPendingAcquires?: () => number
  max?: number
  min?: number
}

/** Best-effort Tarn pool stats (Knex uses Tarn under the hood). */
export function logKnexPoolState(label: string, knex: Knex, level: 'warn' | 'info' = 'warn'): void {
  try {
    const pool = (knex as unknown as { client?: { pool?: TarnLikePool } })
      .client?.pool
    if (pool === undefined) {
      logger[level]({ label }, 'knex pool: could not read pool object')
      return
    }
    const payload = {
      label,
      used: typeof pool.numUsed === 'function' ? pool.numUsed() : undefined,
      free: typeof pool.numFree === 'function' ? pool.numFree() : undefined,
      pendingAcquires:
        typeof pool.numPendingAcquires === 'function'
          ? pool.numPendingAcquires()
          : undefined,
      max: pool.max,
      min: pool.min
    }
    if (level === 'info') {
      logger.info(payload, 'Knex pool snapshot')
    } else {
      logger.warn(payload, 'Knex pool snapshot')
    }
  } catch (err) {
    logger.debug({ err, label }, 'knex pool snapshot failed')
  }
}

export function isKnexAcquireTimeout(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('Timeout acquiring a connection')
}
