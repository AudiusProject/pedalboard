import {
  initializeDiscoveryDb,
  initializeIdentityDb
} from '@pedalboard/basekit'
import { Err, Ok, Result } from 'ts-results'

export const identityDb = initializeIdentityDb(process.env.IDENTITY_DB_URL)
export const discoveryDb = initializeDiscoveryDb(process.env.AUDIUS_DB_URL)

/// catches possibles errors and converts them to an appropriate result type
/// this is useful when using a library that may throw and you want to catch it safely
export const intoResult = async <T>(
  func: () => Promise<T>
): Promise<Result<T, string>> => {
  try {
    return new Ok(await func())
  } catch (e: any) {
    return new Err(`${e}`)
  }
}

export const isValidDate = (dateString: string): boolean => {
  const dateFormat = /^\d{4}-\d{2}-\d{2}$/
  if (!dateFormat.test(dateString)) {
    return false
  }

  const date = new Date(dateString)
  const [year, month, day] = dateString.split('-').map(Number)

  return (
    date.getFullYear() === year &&
    date.getMonth() + 1 === month &&
    date.getDate() === day
  )
}
