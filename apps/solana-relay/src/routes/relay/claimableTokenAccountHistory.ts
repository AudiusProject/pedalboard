import { SolClaimableAccounts, Table } from '@pedalboard/storage'

import { db } from '../../db'

/**
 * The index retains claimable account creation rows after an account is
 * closed, so an existing row identifies a create as a recreation.
 */
export const wasClaimableTokenAccountPreviouslyCreated = async (
  account: string
) => {
  const existingAccount = await db<SolClaimableAccounts>(
    Table.SolClaimableAccounts
  )
    .select('account')
    .where('account', '=', account)
    .first()

  return existingAccount !== undefined
}
