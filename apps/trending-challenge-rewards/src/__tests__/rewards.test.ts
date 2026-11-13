/** @jest-environment node */
import { beforeEach, test, expect, jest } from '@jest/globals'
import { mocked } from 'ts-jest/utils'
import { App } from '@pedalboard/basekit'
import { SharedData } from '../config'

jest.doMock('@audius/sdk', () => ({ Id: { parse: jest.fn(() => 'encoded-user-42') } }))
jest.doMock('../utils', () => ({ discoveryDb: {} }))
jest.doMock('../queries', () => ({
  getTrendingAwardsForWeek: jest.fn(),
  getChallengesDisbursementsUserbanksFriendly: jest.fn(),
  getChallengesDisbursementsUserbanksFriendlyEnsureSlots: jest.fn()
}))
jest.doMock('../slack', () => ({ formatDisbursementTable: () => 'report' }))
jest.doMock('@slack/web-api', () => ({
  WebClient: jest.fn(() => ({ chat: { postMessage: jest.fn() } }))
}))

const { onDisburse } = jest.requireActual('../rewards') as typeof import('../rewards')
const {
  getTrendingAwardsForWeek,
  getChallengesDisbursementsUserbanksFriendly,
  getChallengesDisbursementsUserbanksFriendlyEnsureSlots
} = jest.requireMock('../queries') as typeof import('../queries')

const week = '2026-11-13'
const award = {
  challenge_id: 'tt',
  user_id: 42,
  specifier: `${week}:1`,
  amount: 1000,
  handle: 'winner',
  wallet: '0x' + '11'.repeat(20),
  paid_amount: null
}
const claimRewards = jest.fn<Promise<unknown>, [unknown]>()
const app = {
  viewAppData: () => ({
    sdk: { rewards: { claimRewards } },
    slackBotToken: 'test-token',
    slackChannel: 'test-channel'
  })
} as unknown as App<SharedData>

beforeEach(() => {
  jest.clearAllMocks()
  mocked(getTrendingAwardsForWeek).mockResolvedValue([award])
  mocked(getChallengesDisbursementsUserbanksFriendly).mockResolvedValue([])
  mocked(getChallengesDisbursementsUserbanksFriendlyEnsureSlots).mockResolvedValue([])
  claimRewards.mockResolvedValue({ data: [{
    challengeId: 'tt', specifier: award.specifier, amount: 1000, signatures: ['signature']
  }] })
})

test('dry run reads only the requested week and never submits claims or waits for payments', async () => {
  expect((await onDisburse(app, true, week)).ok).toBe(true)
  expect(getTrendingAwardsForWeek).toHaveBeenCalledWith({}, week)
  expect(claimRewards).not.toHaveBeenCalled()
  expect(getChallengesDisbursementsUserbanksFriendlyEnsureSlots).not.toHaveBeenCalled()
})

test('validates the whole batch before submitting the first payment', async () => {
  mocked(getTrendingAwardsForWeek).mockResolvedValue([award, { ...award, challenge_id: 'e' }])
  await expect(onDisburse(app, false, week)).rejects.toThrow('Unsupported reward')
  expect(claimRewards).not.toHaveBeenCalled()
})

test('submits an exact user, category and specifier instead of a claim-all request', async () => {
  expect((await onDisburse(app, false, week)).ok).toBe(true)
  expect(claimRewards).toHaveBeenCalledTimes(1)
  expect((jest.requireMock('@audius/sdk') as typeof import('@audius/sdk')).Id.parse).toHaveBeenCalledWith(42)
  expect(claimRewards).toHaveBeenCalledWith({ reward: {
    userId: 'encoded-user-42', challengeId: 'tt', specifier: award.specifier
  } })
})

test.each([
  { data: [] },
  { data: [{ challengeId: 'tt', specifier: award.specifier, amount: 1000, error: 'rejected' }] },
  { data: [{ challengeId: 'tt', specifier: award.specifier, amount: 100, signatures: ['signature'] }] },
  { data: [{ challengeId: 'tut', specifier: award.specifier, amount: 1000, signatures: ['signature'] }] }
])('halts on missing, failed or mismatched claim results', async (result) => {
  mocked(getTrendingAwardsForWeek).mockResolvedValue([award, { ...award, challenge_id: 'tut' }])
  claimRewards.mockResolvedValue(result)
  expect((await onDisburse(app, false, week)).err).toBe(true)
  expect(claimRewards).toHaveBeenCalledTimes(1)
})
