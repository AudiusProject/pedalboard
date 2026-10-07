import { describe, it, expect, vi, afterEach } from 'vitest'

import { uploadCoinImage } from './upload_image'

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

const image = Buffer.from('fake-png')
const GATEWAY = 'https://creatornode.audius.co'

const okResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 })

describe('uploadCoinImage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the gateway content URL for the uploaded CID', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        okResponse([{ id: 'u1', status: 'done', orig_file_cid: 'baeCID' }])
      )

    const url = await uploadCoinImage({
      image,
      filename: 'BEAR.png',
      hosts: ['https://node-one.audius.co'],
      gatewayUrl: GATEWAY
    })

    expect(url).toBe('https://creatornode.audius.co/content/baeCID')

    const [calledUrl, init] = fetchMock.mock.calls[0]
    expect(calledUrl).toBe('https://node-one.audius.co/uploads')
    expect(init?.method).toBe('POST')
    // mediorum rejects any template it doesn't recognize
    expect((init?.body as FormData).get('template')).toBe('img_square')
  })

  it('throws when orig_file_cid is absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okResponse([
        { id: 'u1', status: 'done', results: { 'original.jpg': 'resultCID' } }
      ])
    )

    await expect(
      uploadCoinImage({
        image,
        filename: 'BEAR.png',
        hosts: ['https://node-one.audius.co'],
        gatewayUrl: GATEWAY
      })
    ).rejects.toThrow(/no CID/)
  })

  it('tries the next host when one fails', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('disk full', { status: 503 }))
      .mockResolvedValueOnce(
        okResponse([{ id: 'u1', status: 'done', orig_file_cid: 'baeCID' }])
      )

    const url = await uploadCoinImage({
      image,
      filename: 'BEAR.png',
      hosts: ['https://node-one.audius.co', 'https://node-two.audius.co'],
      gatewayUrl: GATEWAY
    })

    expect(url).toBe('https://creatornode.audius.co/content/baeCID')
  })

  it('throws when an upload carries an error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okResponse([{ id: 'u1', status: 'error', error: 'ffprobe failed' }])
    )

    await expect(
      uploadCoinImage({
        image,
        filename: 'BEAR.png',
        hosts: ['https://node-one.audius.co'],
        gatewayUrl: GATEWAY
      })
    ).rejects.toThrow(/ffprobe failed/)
  })

  it('throws when every host fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(
      uploadCoinImage({
        image,
        filename: 'BEAR.png',
        hosts: ['https://node-one.audius.co', 'https://node-two.audius.co'],
        gatewayUrl: GATEWAY
      })
    ).rejects.toThrow(/node-one.*node-two/s)
  })
})
