import { WorkerServices } from '../services'

export const createUtils = (services: WorkerServices) => {
  const { archiver, config, fetch, fs, fsSync, path, logger } = services
  const fileExists = async (path: string) => {
    return await fs.access(path).then(
      () => true,
      () => false
    )
  }

  const downloadFile = async ({
    url,
    filePath,
    jobId,
    signal
  }: {
    url: string
    filePath: string
    jobId: string
    signal?: AbortSignal
  }): Promise<string> => {
    logger.info({ jobId, url, filePath }, 'Downloading stem file')

    const res = await fetch(url, {
      signal
    })
    const { ok, body, statusText, status } = res

    if (!ok) {
      // Parallel downloads log "Downloading stem file" in arbitrary order; this line
      // is the definitive record of which URL failed.
      logger.error(
        { jobId, url, filePath, status, statusText },
        'Stem download failed (HTTP error)'
      )
      throw new Error(
        `Failed to download stem: ${statusText} (${status}) — ${filePath}`
      )
    }

    if (!body) {
      logger.error(
        { jobId, url, filePath, status },
        'Stem download failed (empty body)'
      )
      throw new Error(`Response body is null — ${filePath}`)
    }

    const fileStream = fsSync.createWriteStream(filePath)
    await new Promise((resolve, reject) => {
      body.pipe(fileStream)
      body.on('error', reject)
      fileStream.on('error', reject)
      fileStream.on('finish', resolve)
    })

    return filePath
  }

  const removeTempFiles = async (jobId: string) => {
    const jobTempDir = path.join(config.archiverTmpDir, jobId)
    if (await fileExists(jobTempDir)) {
      await fs.rm(jobTempDir, { recursive: true, force: true })
    }
  }

  const createArchive = async ({
    files,
    jobId,
    archiveName,
    signal
  }: {
    files: string[]
    jobId: string
    archiveName: string
    signal?: AbortSignal
  }): Promise<string> => {
    const jobTempDir = path.join(config.archiverTmpDir, jobId)
    const outputPath = path.join(jobTempDir, archiveName)

    const output = fsSync.createWriteStream(outputPath)
    const archive = archiver('zip', {
      zlib: { level: 6 }
    })

    try {
      if (signal) {
        signal.addEventListener('abort', () => {
          archive.abort()
        })
      }

      archive.on('error', (error: Error) => {
        throw error
      })

      archive.pipe(output)

      for (const file of files) {
        const filename = path.basename(file)
        archive.file(file, { name: filename })
      }

      const finishPromise = new Promise((resolve, reject) => {
        output.on('close', resolve)
        output.on('error', reject)
      })

      await archive.finalize()
      await finishPromise

      return outputPath
    } finally {
      output.destroy()
      archive.destroy()
    }
  }

  return {
    createArchive,
    downloadFile,
    fileExists,
    removeTempFiles
  }
}
