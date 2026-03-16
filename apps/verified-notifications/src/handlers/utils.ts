import type { Knex } from 'knex'

// takes in a table, entity id, and blocknumber. traverses the block for the previous
// state of this entity should it be in there
export const getPreviousState = async ({
  table,
  id,
  blocknumber,
  db
}: {
  table: string
  id: number
  blocknumber: number
  db: Knex
}): Promise<{ is_verified?: boolean } | undefined> => {
  const block = await db('revert_blocks')
    .where('blocknumber', '=', blocknumber)
    .first()

  if (block === undefined) return undefined

  const { prev_records } = block as { prev_records: Record<string, { is_verified?: boolean; user_id?: number; track_id?: number }[]> }
  const previousStates = prev_records[table]
  if (previousStates === undefined) return undefined

  // bot only handles tracks and users rn
  const pkeyKey = table === 'users' ? 'user_id' : 'track_id'
  return previousStates.find((update) => update[pkeyKey] === id)
}
