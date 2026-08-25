import { describe, it, expect, vi, afterEach } from 'vitest'

import { uploadCoinImage } from './upload_image'

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

const image = Buffer.from('fake-png')

const okResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 })

describe('uploadCoinImage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the content URL for the uploaded CID', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        okResponse([{ id: 'u1', status: 'done', orig_file_cid: 'baeCID' }])
      )

    const url = await uploadCoinImage({
      image,
      filename: 'BEAR.png',
      hosts: ['https://creatornode.audius.co']
    })

    expect(url).toBe('https://creatornode.audius.co/content/baeCID')

    const [calledUrl, init] = fetchMock.mock.calls[0]
    expect(calledUrl).toBe('https://creatornode.audius.co/uploads')
    expect(init?.method).toBe('POST')
    // mediorum rejects any template it doesn't recognize
    expect((init?.body as FormData).get('template')).toBe('img_square')
  })

  it('falls back to the results map when orig_file_cid is absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okResponse([
        { id: 'u1', status: 'done', results: { 'original.jpg': 'resultCID' } }
      ])
    )

    const url = await uploadCoinImage({
      image,
      filename: 'BEAR.png',
      hosts: ['https://creatornode.audius.co']
    })

    expect(url).toBe('https://creatornode.audius.co/content/resultCID')
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
      hosts: ['https://node-one.audius.co', 'https://node-two.audius.co']
    })

    expect(url).toBe('https://node-two.audius.co/content/baeCID')
  })

  it('throws when an upload carries an error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okResponse([{ id: 'u1', status: 'error', error: 'ffprobe failed' }])
    )

    await expect(
      uploadCoinImage({
        image,
        filename: 'BEAR.png',
        hosts: ['https://creatornode.audius.co']
      })
    ).rejects.toThrow(/ffprobe failed/)
  })

  it('throws when every host fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(
      uploadCoinImage({
        image,
        filename: 'BEAR.png',
        hosts: ['https://node-one.audius.co', 'https://node-two.audius.co']
      })
    ).rejects.toThrow(/node-one.*node-two/s)
  })
})
