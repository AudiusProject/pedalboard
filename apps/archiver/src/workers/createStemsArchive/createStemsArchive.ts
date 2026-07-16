import { Worker, Job, UnrecoverableError, WorkerListener } from 'bullmq'
import {
  StemsArchiveJobData,
  StemsArchiveJobResult,
  getStemsArchiveQueue
} from '../../jobs/createStemsArchive'
import { OptionalId } from '@audius/sdk'
import {
  MESSAGE_HEADER,
  SIGNATURE_HEADER,
  STEMS_ARCHIVE_QUEUE_NAME
} from '../../constants'
import path from 'path'
import { WorkerServices } from '../services'
import { createUtils } from './utils'

type StemsArchiveWorkerListener = WorkerListener<
  StemsArchiveJobData,
  StemsArchiveJobResult
>

export const createStemsArchiveWorker = (services: WorkerServices) => {
  const { config, spaceManager, fs, sdk } = services
  const workerLogger = services.logger.child({
    worker: 'createStemsArchive'
  })
  const { createArchive, downloadFile, fileExists, removeTempFiles } =
    createUtils(services)

  const abortControllers = new Map<string, AbortController>()

  const processJob = async (
    job: Job<StemsArchiveJobData>
  ): Promise<StemsArchiveJobResult> => {
    const {
      jobId,
      trackId,
      userId,
      messageHeader,
      signatureHeader,
      includeParentTrack
    } = job.data

    const logger = workerLogger.child({
      jobId,
      trackId,
      userId,
      includeParentTrack
    })

    const abortController = new AbortController()
    abortControllers.set(jobId, abortController)

    const sdkRequestInit = {
      signal: abortController.signal,
      headers: {
        [MESSAGE_HEADER]: messageHeader,
        [SIGNATURE_HEADER]: signatureHeader
      }
    }

    try {
      logger.info('Starting stems archive creation job')

      const hashedTrackId = OptionalId.parse(trackId)
      const hashedUserId = OptionalId.parse(userId)

      if (!hashedTrackId) {
        throw new UnrecoverableError(`Failed to encode track Id: ${trackId}`)
      }
      if (!hashedUserId) {
        throw new UnrecoverableError(`No userID provided`)
      }
      if (!signatureHeader) {
        throw new UnrecoverableError(`Missing signature header`)
      }
      if (!messageHeader) {
        throw new UnrecoverableError(`Missing message header`)
      }

      const { data: track } = await sdk.tracks.getTrack(
        {
          trackId: hashedTrackId
        },
        sdkRequestInit
      )

      if (!track) {
        throw new Error('Track details not found')
      }

      logger.debug('Getting track stems')
      const { data: stems = [] } = await sdk.tracks.getTrackStems(
        {
          trackId: hashedTrackId
        },
        sdkRequestInit
      )

      if (stems.length === 0) {
        throw new Error('No stems found for track')
      }

      // The parent track is best-effort. Stem-only uploads can report
      // isDownloadable while having no original file to serve (empty CID, so
      // every mirror 404s) — the stems the user asked for shouldn't be held
      // hostage by that. Any parent-track failure downgrades the job to a
      // stems-only archive instead of failing it.
      let parentTrackFile: { id: string; origFilename?: string } | null =
        includeParentTrack && track.isDownloadable
          ? { ...track, origFilename: track.origFilename ?? track.title }
          : null

      const inspectFileSize = async (file: { id: string }) => {
        const inspection = await sdk.tracks.inspectTrack(
          {
            trackId: file.id,
            original: true
          },
          sdkRequestInit
        )
        if (!inspection.data?.size) {
          throw new Error(`File size not found for ${file.id}`)
        }
        return inspection.data.size
      }

      logger.debug({ stems, parentTrackFile }, 'Getting file sizes')

      const fileSizes = await Promise.all(stems.map(inspectFileSize))

      let parentSizeBytes = 0
      if (parentTrackFile) {
        try {
          parentSizeBytes = await inspectFileSize(parentTrackFile)
        } catch (error) {
          if (abortController.signal.aborted) {
            throw error
          }
          logger.warn(
            { err: error, parentTrackId: parentTrackFile.id },
            'Skipping parent track: original file not available'
          )
          parentTrackFile = null
        }
      }

      const totalSizeBytes =
        fileSizes.reduce((sum, size) => sum + size, 0) + parentSizeBytes
      logger.debug({ totalSizeBytes }, 'Calculated required disk space')

      logger.debug({ stems }, 'Downloading stems')

      await spaceManager.waitForSpace({
        token: jobId,
        bytes: totalSizeBytes,
        timeoutSeconds: config.maxDiskSpaceWaitSeconds,
        signal: abortController.signal
      })

      const jobTempDir = path.join(config.archiverTmpDir, jobId)
      if (!(await fileExists(jobTempDir))) {
        await fs.mkdir(jobTempDir, { recursive: true })
      }

      // Mirror list comes from the upload metadata. `track.download` is null
      // on tracks that aren't user-downloadable (stem-only uploads), so fall
      // back to the stream mirrors — same content node set, same placement.
      //
      // CAVEAT: the pinned @audius/sdk (10.0.0) predates these fields, and
      // its generated deserializer (TrackFromJSONTyped) drops unknown keys —
      // so even though api.audius.co returns download/stream at runtime,
      // this cast reads undefined and the list is effectively EMPTY until
      // the SDK is upgraded (2026-07-16 stems incident). That's safe only
      // because downloadFile tries the canonical redirect host first and the
      // archive node last; the mirrors are an optional middle tier.
      const trackWithMirrors = track as typeof track & {
        download?: { mirrors?: string[] } | null
        stream?: { mirrors?: string[] } | null
      }
      const trackMirrors =
        trackWithMirrors.download?.mirrors ??
        trackWithMirrors.stream?.mirrors ??
        []

      // Start all downloads immediately so we can await allSettled after a failure:
      // if one rejects, Promise.all would run the outer catch and removeTempFiles while
      // siblings are still writing — ENOENT on other WriteStreams and process crash.
      // downloadFile resolves the API's /tracks/{id}/download 302 once to get
      // the canonical signed content-node URL, then tries each mirror by
      // swapping the host. The signed path is host-agnostic so any mirror
      // that holds the file can serve it; if none can, we fall back to the
      // archive node (creatornode2) which is guaranteed to.
      const downloadTrackFile = async (stem: {
        id: string
        origFilename?: string
      }) => {
        const url = await sdk.tracks.getTrackDownloadUrl({
          trackId: stem.id,
          userId: hashedUserId,
          userSignature: signatureHeader,
          userData: messageHeader,
          filename: stem.origFilename ?? ''
        })

        const filePath = path.join(jobTempDir, stem.origFilename ?? 'file')
        return downloadFile({
          url,
          filePath,
          jobId,
          mirrors: trackMirrors,
          signal: abortController.signal
        })
      }

      const downloadPromises = stems.map(downloadTrackFile)
      // The parent download never rejects — it resolves to null on failure so
      // a broken or missing original can't fail the stems that did download.
      // (On abort it also resolves null; the stem promises reject in that case
      // and fail the job through the catch below.)
      const parentDownloadPromise = parentTrackFile
        ? downloadTrackFile(parentTrackFile).catch((error) => {
            if (!abortController.signal.aborted) {
              logger.warn(
                { err: error, parentTrackId: parentTrackFile?.id },
                'Skipping parent track: download failed'
              )
            }
            return null
          })
        : Promise.resolve(null)

      let downloadedFiles: string[]
      try {
        downloadedFiles = await Promise.all(downloadPromises)
      } catch (error) {
        abortController.abort()
        await Promise.allSettled([...downloadPromises, parentDownloadPromise])
        throw error
      }

      const parentFilePath = await parentDownloadPromise
      if (parentFilePath) {
        downloadedFiles.push(parentFilePath)
      }

      logger.debug(
        { files: downloadedFiles },
        'Successfully downloaded all stems'
      )

      logger.debug({ files: downloadedFiles }, 'Creating archive')
      const outputFile = await createArchive({
        files: downloadedFiles,
        jobId,
        archiveName: `${track.title}.zip`,
        signal: abortController.signal
      })

      for (const file of downloadedFiles) {
        if (file !== outputFile && (await fileExists(file))) {
          await fs.unlink(file)
        }
      }

      logger.info({ outputFile }, 'Successfully created stems archive')

      return { outputFile }
    } catch (error) {
      try {
        logger.error({ err: error }, 'Job failed, cleaning up temp files')
        await removeTempFiles(jobId)
        await spaceManager.releaseSpace(jobId)
      } catch (cleanupError) {
        logger.error({ err: cleanupError }, 'Error cleaning up while handling job failure')
      }

      if (abortController.signal.aborted) {
        logger.info('Job aborted')
        throw new UnrecoverableError('Job aborted')
      }

      throw error
    } finally {
      abortControllers.delete(jobId)
    }
  }

  const removeStemsArchiveJob = async (jobId: string) => {
    workerLogger.info({ jobId }, 'Removing stems archive job')
    const queue = getStemsArchiveQueue()
    try {
      await removeTempFiles(jobId)
      await spaceManager.releaseSpace(jobId)
      workerLogger.info({ jobId }, 'Removed stems archive job')
    } catch (error) {
      workerLogger.error({ error, jobId }, 'Failed to clean up stems archive')
      throw error
    } finally {
      await queue.remove(jobId)
    }
  }

  const cancelStemsArchiveJob = async (jobId: string) => {
    workerLogger.info({ jobId }, 'Cancelling stems archive job')
    const job = await getStemsArchiveQueue().getJob(jobId)
    if (job && (await job.isCompleted())) {
      try {
        await removeStemsArchiveJob(jobId)
      } finally {
        await job.remove()
      }
    } else if (abortControllers.has(jobId)) {
      const abortController = abortControllers.get(jobId)
      abortController?.abort()
    } else {
      workerLogger.info({ jobId }, 'Stems archive job not found')
    }
  }

  const onClosing: StemsArchiveWorkerListener['closing'] = () => {
    workerLogger.info('Worker closing, aborting all active jobs')
    for (const abortController of abortControllers.values()) {
      abortController.abort()
    }
  }

  return {
    processJob,
    onClosing,
    removeStemsArchiveJob,
    cancelStemsArchiveJob
  }
}

export const startStemsArchiveWorker = (services: WorkerServices) => {
  const {
    processJob,
    onClosing,
    removeStemsArchiveJob,
    cancelStemsArchiveJob
  } = createStemsArchiveWorker(services)

  const worker = new Worker<StemsArchiveJobData, StemsArchiveJobResult>(
    STEMS_ARCHIVE_QUEUE_NAME,
    processJob,
    {
      connection: {
        url: services.config.redisUrl
      },
      concurrency: services.config.concurrentJobs
    }
  )

  worker.on('closing', onClosing)

  return { worker, removeStemsArchiveJob, cancelStemsArchiveJob }
}
