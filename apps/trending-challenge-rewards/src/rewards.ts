import { App } from '@pedalboard/basekit'
import { Knex } from 'knex'
import { Ok, Err, Result } from 'ts-results'
import { SharedData } from './config'
import {
  getChallengesDisbursementsUserbanksFriendlyEnsureSlots,
  getChallengesDisbursementsUserbanksFriendly,
  getTrendingChallenges,
  getTrendingAwardsForWeek
} from './queries'
import { WebClient } from '@slack/web-api'
import { formatDisbursementTable } from './slack'
import { discoveryDb } from './utils'
import { ChallengeId, Id } from '@audius/sdk'
import moment from 'moment'
import { buildTrendingBatch } from './batch'

// TODO: move something like this into App so results are commonplace for handlers
export const disburseTrendingRewards = async (
  app: App<SharedData>
): Promise<void> => {
  const { dryRun } = app.viewAppData()
  const disburse = await onDisburse(app, dryRun)
  disburse.mapErr(console.error)
}

// dryRun separated out so it can be run manually via another trigger
export const onDisburse = async (
  app: App<SharedData>,
  dryRun: boolean,
  targetSpecifier?: string
): Promise<Result<undefined, string>> => {
  const db = discoveryDb
  const { slackBotToken, slackChannel } = app.viewAppData()
  if (slackBotToken === undefined) throw new Err('slackBotToken undefined')
  const client = new WebClient(slackBotToken)

  console.log(`doing ${dryRun ? 'a dry run' : 'a live run'}`)

  const { sdk } = app.viewAppData()
  // Scheduled runs only pay today's Friday batch. Historical retries require
  // the existing explicit /disburse YYYY-MM-DD command.
  const week = targetSpecifier ?? moment().format('YYYY-MM-DD')
  const batch = buildTrendingBatch(
    week,
    await getTrendingAwardsForWeek(db, week)
  )
  console.log('Trending payout budget', {
    week,
    totalAudio: batch.totalAudio,
    remainingAudio: batch.remainingAudio,
    unpaidAwards: batch.unpaid.length
  })

  for (const challenge of batch.unpaid) {
    if (dryRun) {
      console.log('Dry run, would claim', challenge)
      continue
    }
    const response = await sdk.rewards.claimRewards({
      reward: {
        challengeId: challenge.challenge_id as ChallengeId,
        userId: Id.parse(challenge.user_id),
        specifier: challenge.specifier
      }
    })
    const results = response?.data
    const result = results?.[0]
    if (
      results?.length !== 1 ||
      !result ||
      result.error ||
      result.challengeId !== challenge.challenge_id ||
      result.specifier !== challenge.specifier ||
      Number(result.amount) !== Number(challenge.amount) ||
      !result.signatures?.length
    ) {
      return new Err(
        `Claim failed or returned an unexpected result for ${challenge.challenge_id}:${challenge.specifier}; reconcile before retrying`
      )
    }
  }

  // Look at database to see if all challenges have been disbursed
  const trimmedSpecifier = week
  console.log('trimmedSpecifier = ', trimmedSpecifier)
  const friendly = await (dryRun
    ? getChallengesDisbursementsUserbanksFriendly
    : getChallengesDisbursementsUserbanksFriendlyEnsureSlots)(db, trimmedSpecifier)

  // Format the results for Slack
  const formattedResults = formatDisbursementTable(friendly, trimmedSpecifier)
  console.log(formattedResults)

  if (slackChannel === undefined) return new Err('SLACK_CHANNEL not defined')
  await client.chat.postMessage({
    channel: slackChannel,
    text: '```' + formattedResults + '```'
  })

  if (!dryRun && friendly.some((row) => row.slot === null)) {
    return new Err(
      `Some awards for ${week} are still unconfirmed; reconcile before retrying`
    )
  }
  return new Ok(undefined)
}

export const findStartingBlock = async (
  db: Knex
): Promise<Result<[number, string], string>> => {
  const challenges = await getTrendingChallenges(
    db,
    moment().format('YYYY-MM-DD')
  )
  const firstChallenge = challenges[0]
  if (firstChallenge === undefined)
    return new Err(`no challenges found ${challenges}`)
  const completedBlocknumber = firstChallenge.completed_blocknumber
  if (completedBlocknumber === null)
    return new Err(`completed block number is null ${firstChallenge}`)
  const specifier = firstChallenge.specifier
  // Start from one before the first challenge
  return new Ok([completedBlocknumber - 1, specifier])
}
