/** Only the existing weekly track and underground awards may be signed. */
export const parseTrendingClaim = (body: unknown) => {
  if (!body || typeof body !== 'object') return null
  const { challengeId, challengeSpecifier, amount } = body as Record<
    string,
    unknown
  >
  if (challengeId !== 'tt' && challengeId !== 'tut') return null
  if (typeof challengeSpecifier !== 'string') return null
  const match = /^(\d{4}-\d{2}-\d{2}):([1-9]|10)$/.exec(challengeSpecifier)
  if (!match) return null
  const [, week, rankString] = match
  const date = new Date(`${week}T00:00:00.000Z`)
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== week
  )
    return null
  const rank = Number(rankString)
  const expectedAmount = rank <= 5 ? 1000 : 100
  // The Go claim API sends a decimal string. Also accept the equivalent number.
  if (amount !== expectedAmount && amount !== String(expectedAmount))
    return null
  return { challengeId, challengeSpecifier, amount: expectedAmount, week, rank }
}
