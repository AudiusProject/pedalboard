import express from 'express'
import { MESSAGE_HEADER, SIGNATURE_HEADER } from '../constants'
import {
  JobStatus,
  getOrCreateStemsArchiveJob,
  getStemsArchiveJob
} from '../jobs/createStemsArchive'
import { logger } from '../logger'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { basename } from 'path'
import { OptionalHashId } from '@audius/sdk'
import { queryParamToBoolean } from './utils'
import { UserSignatureVerifier } from '../auth/verifyUserSignature'

const removeInternalStatusFields = (jobStatus: JobStatus) => {
  const { returnvalue: _, ...rest } = jobStatus
  return rest
}

export const stemsRouter = ({
  removeStemsArchiveJob,
  cancelStemsArchiveJob,
  verifyUserSignature
}: {
  removeStemsArchiveJob: (jobId: string) => Promise<void>
  cancelStemsArchiveJob: (jobId: string) => Promise<void>
  verifyUserSignature: UserSignatureVerifier
}) => {
  const router = express.Router()
  router.post('/:trackId', async (req, res) => {
    try {
      const { trackId: trackIdString } = req.params
      const trackId = OptionalHashId.parse(trackIdString)
      const userId = OptionalHashId.parse(req.query.user_id)
      const messageHeader = req.header(MESSAGE_HEADER)
      const signatureHeader = req.header(SIGNATURE_HEADER)
      const includeParentTrack = queryParamToBoolean(req.query.include_parent)

      if (!userId || !trackId || !messageHeader || !signatureHeader) {
        return res.status(400).json({
          error: 'Missing required parameters'
        })
      }

      // Prove the caller controls the wallet behind `user_id` before doing any
      // work. Enqueuing first and letting the downstream content fetches fail
      // on their own auth meant an unauthenticated caller could spend our disk,
      // bandwidth and api.audius.co rate-limit budget at will.
      const verification = await verifyUserSignature({
        userId,
        messageHeader,
        signatureHeader
      })

      if (!verification.ok) {
        if (verification.reason === 'user lookup failed') {
          // Our dependency failed, not their credentials. Saying 401 here
          // would send a legitimate user off chasing a login problem during a
          // discovery outage.
          return res.status(503).json({ error: 'Could not verify request' })
        }
        logger.warn(
          { userId, trackId, reason: verification.reason },
          'Rejected stems archive request with invalid signature'
        )
        // Deliberately generic to the caller; the specific reason is logged.
        return res.status(401).json({ error: 'Invalid signature' })
      }

      const jobStatus = await getOrCreateStemsArchiveJob({
        trackId,
        userId: userId,
        messageHeader,
        signatureHeader,
        includeParentTrack
      })

      res.status(200).json(removeInternalStatusFields(jobStatus))
    } catch (error) {
      logger.error({ error }, 'Failed to create stems archive job')
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  router.get('/job/:jobId', async (req, res) => {
    try {
      const { jobId } = req.params
      const job = await getStemsArchiveJob(jobId)

      if (!job) {
        return res.status(404).json({ error: 'Job not found' })
      }

      res.status(200).json(removeInternalStatusFields(job))
    } catch (error) {
      logger.error({ error }, 'Failed to get stems archive job')
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  router.delete('/job/:jobId', async (req, res) => {
    const { jobId } = req.params
    try {
      await cancelStemsArchiveJob(jobId)
    } catch (error) {
      logger.error({ error }, 'Failed to cancel stems archive job')
    } finally {
      res.status(204).send()
    }
  })

  router.get('/download/:jobId', async (req, res) => {
    const { jobId } = req.params
    try {
      const job = await getStemsArchiveJob(jobId)

      if (!job) {
        return res.status(404).json({ error: 'Job not found' })
      }

      if (job.state !== 'completed') {
        return res.status(400).json({ error: 'Job is not completed' })
      }

      const { returnvalue } = job
      if (!returnvalue) {
        return res.status(400).json({ error: 'Job has no return value' })
      }

      const { outputFile } = returnvalue
      const filename = basename(outputFile)

      const stats = await stat(outputFile)

      res.setHeader('Content-Type', 'application/zip')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.setHeader('Content-Length', stats.size)

      res.on('finish', async () => {
        try {
          await removeStemsArchiveJob(jobId)
        } catch (error) {
          logger.error(
            { error, jobId },
            'Failed to clean up stems archive after download'
          )
        }
      })

      createReadStream(outputFile)
        .on('error', (error) => {
          logger.error({ error, jobId }, 'Failed to stream archive file')
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to stream archive file' })
          }
        })
        .pipe(res)
    } catch (error) {
      logger.error({ error }, 'Failed to get stems archive')
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' })
      }
    }
  })

  return router
}
