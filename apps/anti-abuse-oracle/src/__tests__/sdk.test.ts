import { describe, it, expect, beforeEach, vi } from 'vitest'

const sdkMock = vi.fn(() => ({ isFakeSdk: true }))

vi.mock('@audius/sdk', () => ({
  sdk: sdkMock
}))

const readConfigMock = vi.fn()

vi.mock('../config', () => ({
  readConfig: readConfigMock
}))

describe('sdk', () => {
  beforeEach(() => {
    sdkMock.mockClear()
    readConfigMock.mockReset()
    vi.resetModules()
  })

  it('initializes the SDK with the dev environment when config.environment is "dev"', async () => {
    readConfigMock.mockReturnValue({ environment: 'dev' })
    const { getAudiusSdk } = await import('../sdk')
    const instance = getAudiusSdk()
    expect(sdkMock).toHaveBeenCalledTimes(1)
    expect(sdkMock).toHaveBeenCalledWith({
      appName: 'anti-abuse-oracle',
      environment: 'development'
    })
    expect(instance).toEqual({ isFakeSdk: true })
  })

  it('initializes the SDK with the production environment when config.environment is "prod"', async () => {
    readConfigMock.mockReturnValue({ environment: 'prod' })
    const { getAudiusSdk } = await import('../sdk')
    getAudiusSdk()
    expect(sdkMock).toHaveBeenCalledWith({
      appName: 'anti-abuse-oracle',
      environment: 'production'
    })
  })

  it('caches the SDK instance across calls', async () => {
    readConfigMock.mockReturnValue({ environment: 'dev' })
    const { getAudiusSdk } = await import('../sdk')
    const first = getAudiusSdk()
    const second = getAudiusSdk()
    expect(first).toBe(second)
    expect(sdkMock).toHaveBeenCalledTimes(1)
  })
})
