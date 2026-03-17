import { Mutex } from 'async-mutex'
import { Logger } from '../logger'

type SpaceManagerOptions = {
  maxSpaceBytes: number
  logger: Logger
}

type SpaceState = {
  usedSpace: number
  allocations: Map<string, number>
  queue: string[]
}

export enum SpaceManagerErrorCode {
  ALREADY_ALLOCATED = 'ALREADY_ALLOCATED',
  EXCEEDS_MAXIMUM = 'EXCEEDS_MAXIMUM',
  TIMEOUT = 'TIMEOUT',
  INVALID_RELEASE = 'INVALID_RELEASE',
  CANCELLED = 'CANCELLED'
}

export class SpaceManagerError extends Error {
  code: SpaceManagerErrorCode

  constructor(message: string, code: SpaceManagerErrorCode) {
    super(message)
    this.name = 'SpaceError'
    this.code = code
  }
}

export function createSpaceManager(options: SpaceManagerOptions) {
  const { logger } = options
  const mutex = new Mutex()
  const state: SpaceState = {
    usedSpace: 0,
    allocations: new Map(),
    queue: []
  }

  const claimSpace = async ({
    token,
    bytes
  }: {
    token: string
    bytes: number
  }): Promise<boolean> => {
    const release = await mutex.acquire()
    try {
      if (state.allocations.has(token)) {
        throw new SpaceManagerError(
          `Space already allocated for ${token}`,
          SpaceManagerErrorCode.ALREADY_ALLOCATED
        )
      }

      if (bytes > options.maxSpaceBytes) {
        throw new SpaceManagerError(
          `Requested ${bytes} bytes exceeds maximum space of ${options.maxSpaceBytes}`,
          SpaceManagerErrorCode.EXCEEDS_MAXIMUM
        )
      }

      const availableSpace = options.maxSpaceBytes - state.usedSpace

      const canClaim =
        bytes <= availableSpace &&
        (state.queue.length === 0 || state.queue[0] === token)

      if (canClaim) {
        state.usedSpace += bytes
        state.allocations.set(token, bytes)
        state.queue = state.queue.filter((t) => t !== token)
        return true
      }

      if (!state.queue.includes(token)) {
        state.queue.push(token)
      }

      return false
    } finally {
      release()
    }
  }

  const waitForSpace = ({
    token,
    bytes,
    timeoutSeconds,
    signal
  }: {
    token: string
    bytes: number
    timeoutSeconds: number
    signal?: AbortSignal
  }): Promise<void> => {
    const shouldContinue = true

    const claimSpacePromise = (async () => {
      try {
        while (shouldContinue) {
          if (signal?.aborted) {
            throw new SpaceManagerError(
              'Space claim cancelled',
              SpaceManagerErrorCode.CANCELLED
            )
          }

          const claimed = await claimSpace({ token, bytes })
          if (claimed) {
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      } catch (error) {
        await removeFromQueue(token)
        throw error
      }
    })()

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(
          new SpaceManagerError(
            `Timeout waiting for space after ${timeoutSeconds} seconds`,
            SpaceManagerErrorCode.TIMEOUT
          )
        )
      }, timeoutSeconds * 1000)
    })

    return (async () => {
      try {
        await Promise.race([claimSpacePromise, timeoutPromise])
      } catch (error) {
        await removeFromQueue(token)
        throw error
      }
    })()
  }

  const releaseSpace = async (token: string): Promise<number> => {
    const release = await mutex.acquire()
    try {
      const bytes = state.allocations.get(token) ?? 0
      if (bytes > 0) {
        state.usedSpace -= bytes
        state.allocations.delete(token)
      } else {
        logger.warn({ token }, 'releaseSpace: No space allocated')
      }
      return bytes
    } finally {
      release()
    }
  }

  const removeFromQueue = async (token: string): Promise<void> => {
    const release = await mutex.acquire()
    try {
      state.queue = state.queue.filter((t) => t !== token)
    } finally {
      release()
    }
  }

  const getStats = async () => {
    const release = await mutex.acquire()
    try {
      return {
        usedSpace: state.usedSpace,
        availableSpace: options.maxSpaceBytes - state.usedSpace,
        totalSpace: options.maxSpaceBytes,
        allocations: Array.from(state.allocations.entries()),
        queue: [...state.queue]
      }
    } finally {
      release()
    }
  }

  return {
    claimSpace,
    waitForSpace,
    releaseSpace,
    removeFromQueue,
    getStats
  }
}

export type SpaceManager = ReturnType<typeof createSpaceManager>
