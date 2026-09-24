import { logger } from '../../logger'

type MediorumUpload = {
  id: string
  status: string
  orig_file_cid?: string
  error?: string
}

const UPLOAD_TIMEOUT_MS = 30_000

// Image uploads complete synchronously; the response already has
// orig_file_cid, so no polling is needed.
const uploadToNode = async (
  host: string,
  image: Buffer,
  filename: string
): Promise<string> => {
  const form = new FormData()
  form.append('template', 'img_square')
  form.append('files', new Blob([image], { type: 'image/png' }), filename)

  const response = await fetch(`${host}/uploads`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
  })

  if (!response.ok) {
    throw new Error(
      `Upload failed with ${response.status}: ${await response.text()}`
    )
  }

  const uploads = (await response.json()) as MediorumUpload[]
  const upload = uploads?.[0]
  if (!upload) {
    throw new Error('Upload response contained no uploads')
  }
  if (upload.error) {
    throw new Error(`Upload rejected: ${upload.error}`)
  }

  if (!upload.orig_file_cid) {
    throw new Error('Upload response contained no CID')
  }

  return upload.orig_file_cid
}

/**
 * Uploads a coin image to Audius content storage and returns its URL on
 * `gatewayUrl`. Tries each configured node in order so a single unhealthy node
 * doesn't fail a coin launch.
 */
export const uploadCoinImage = async ({
  image,
  filename,
  hosts,
  gatewayUrl
}: {
  image: Buffer
  filename: string
  hosts: string[]
  gatewayUrl: string
}): Promise<string> => {
  const errors: string[] = []
  for (const host of hosts) {
    try {
      const cid = await uploadToNode(host, image, filename)
      const url = `${gatewayUrl}/content/${cid}`
      logger.info({ message: 'Uploaded coin image', host, url })
      return url
    } catch (e) {
      logger.warn({ message: 'Failed to upload coin image', host, e })
      errors.push(`${host}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  throw new Error(`Failed to upload coin image to any node. ${errors.join('; ')}`)
}
