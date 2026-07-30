import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('eth-sig-util', () => ({
  recoverPersonalSignature: vi.fn()
}))

vi.mock('../sdk', () => ({
  getAudiusSdk: vi.fn()
}))

vi.mock('../logger', () => ({
  logger: { child: () => ({ warn: vi.fn(), error: vi.fn() }) }
}))

import { recoverPersonalSignature } from 'eth-sig-util'
import { getAudiusSdk } from '../sdk'
import { verifyRequestSignature } from './verifySignature'

const WALLET = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const OTHER_WALLET = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

const mockRecover = recoverPersonalSignature as ReturnType<typeof vi.fn>
const mockGetSdk = getAudiusSdk as ReturnType<typeof vi.fn>

const makeSdk = (wallet: string | null) => ({
  users: {
    getUser: vi.fn().mockResolvedValue({
      data: wallet != null ? { wallet } : null
    })
  }
})

const args = {
  userId: 12345,
  messageHeader: 'eyJ1c2VySWQiOjEyMzQ1LCJ0cyI6MTc1MzgwMDAwMH0=',
  signatureHeader: '0xdeadbeef'
}

describe('verifyRequestSignature', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns true when the recovered wallet matches the user wallet', async () => {
    mockRecover.mockReturnValue(WALLET)
    mockGetSdk.mockReturnValue(makeSdk(WALLET))

    expect(await verifyRequestSignature(args)).toBe(true)
  })

  it('returns true when wallets match case-insensitively', async () => {
    mockRecover.mockReturnValue(WALLET.toUpperCase())
    mockGetSdk.mockReturnValue(makeSdk(WALLET.toLowerCase()))

    expect(await verifyRequestSignature(args)).toBe(true)
  })

  it('returns false when the recovered wallet does not match the user wallet', async () => {
    mockRecover.mockReturnValue(OTHER_WALLET)
    mockGetSdk.mockReturnValue(makeSdk(WALLET))

    expect(await verifyRequestSignature(args)).toBe(false)
  })

  it('returns false when the user is not found in the API', async () => {
    mockRecover.mockReturnValue(WALLET)
    mockGetSdk.mockReturnValue(makeSdk(null))

    expect(await verifyRequestSignature(args)).toBe(false)
  })

  it('returns false when recoverPersonalSignature throws (malformed signature)', async () => {
    mockRecover.mockImplementation(() => {
      throw new Error('invalid signature bytes')
    })
    mockGetSdk.mockReturnValue(makeSdk(WALLET))

    expect(await verifyRequestSignature(args)).toBe(false)
  })

  it('returns false when the SDK call throws (API unavailable)', async () => {
    mockRecover.mockReturnValue(WALLET)
    mockGetSdk.mockReturnValue({
      users: { getUser: vi.fn().mockRejectedValue(new Error('network error')) }
    })

    expect(await verifyRequestSignature(args)).toBe(false)
  })

  it('passes the raw header values directly to recoverPersonalSignature', async () => {
    mockRecover.mockReturnValue(WALLET)
    mockGetSdk.mockReturnValue(makeSdk(WALLET))

    await verifyRequestSignature(args)

    expect(mockRecover).toHaveBeenCalledWith({
      data: args.messageHeader,
      sig: args.signatureHeader
    })
  })
})
