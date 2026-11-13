export type TrendingAward = {
  challenge_id: string
  user_id: number
  specifier: string
  amount: number | string
  handle: string
  wallet: string
  paid_amount: string | null
}

export const buildTrendingBatch = (week: string, awards: TrendingAward[]) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new Error('Invalid payout week')
  const date = new Date(`${week}T00:00:00.000Z`)
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== week
  )
    throw new Error('Invalid payout week')
  if (!awards.length) throw new Error(`No trending awards for ${week}`)
  const seen = new Set<string>()
  let totalAudio = 0
  let remainingAudio = 0
  const unpaid: TrendingAward[] = []
  for (const award of awards) {
    if (!['tt', 'tut'].includes(award.challenge_id))
      throw new Error('Unsupported reward')
    const match = /^(\d{4}-\d{2}-\d{2}):([1-9]|10)$/.exec(award.specifier)
    if (!match || match[1] !== week)
      throw new Error('Award outside payout week')
    const amount = Number(match[2]) <= 5 ? 1000 : 100
    if (award.amount !== amount && award.amount !== String(amount))
      throw new Error('Incorrect award amount')
    if (
      !Number.isSafeInteger(award.user_id) ||
      award.user_id <= 0 ||
      !/^0x[0-9a-fA-F]{40}$/.test(award.wallet)
    )
      throw new Error('Invalid award recipient')
    const key = `${award.challenge_id}:${award.specifier}`
    if (seen.has(key)) throw new Error('Duplicate award')
    seen.add(key)
    totalAudio += amount
    if (award.paid_amount === null) {
      remainingAudio += amount
      unpaid.push(award)
    } else if (
      award.paid_amount !== String(BigInt(amount) * BigInt(100000000))
    ) {
      throw new Error(
        'Unexpected recorded payout amount; reconcile before retrying'
      )
    }
  }
  if (totalAudio > 11000) throw new Error('Weekly trending budget exceeded')
  return { week, totalAudio, remainingAudio, unpaid }
}
