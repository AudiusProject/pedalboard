import axios from 'axios'
import { Semaphore } from 'await-semaphore'
import type { App } from '@pedalboard/basekit'
import { getConfig } from './config'
import { getCachedHealthyContentNodes, readDbOffset, storeDbOffset } from './redis'

const MAX_CONCURRENT_REQUESTS = 10
const semaphore = new Semaphore(MAX_CONCURRENT_REQUESTS)
const REQUEST_TIMEOUT = 5000
const DB_OFFSET_KEY = 'discovery:backfill_audio_analyses:offset3'

type TrackRow = {
  track_id: number
  track_cid: string | null
  audio_upload_id: string | null
  musical_key: string | null
  bpm: number | null
  audio_analysis_error_count: number
}

type UpdateRow = {
  track_id: number
  musical_key: string | null
  bpm: number | null
  error_count: number
}

function formatErrorLog (
  message: string,
  track: TrackRow,
  node: string,
  attemptNo: number
): string {
  let errLog = `Error retrieving audio analysis on ${node}: ${message}. Attempt #${attemptNo} for track ID ${track.track_id}, track CID ${track.track_cid}`
  if (track.audio_upload_id) {
    errLog += `, upload ID ${track.audio_upload_id}`
  }
  if (attemptNo < 5) {
    errLog += '. Trying another content node...'
  } else {
    errLog += '. Skipping track...'
  }
  return errLog
}

async function getAudioAnalysis (
  contentNodes: string[],
  track: TrackRow
): Promise<UpdateRow | null> {
  let formattedResult: UpdateRow | null = null
  const trackCid = track.track_cid
  if (!trackCid) return formattedResult
  if (track.musical_key != null && track.bpm != null) return formattedResult

  const audioUploadId = track.audio_upload_id ?? ''
  const isLegacyTrack = !audioUploadId
  const release = await semaphore.acquire()

  for (let i = 0; i < 5; i++) {
    let contentNode = 'https://creatornode2.audius.co'
    const checkStoreAllNodeNext = i === 3

    if (i < 3 || (track.audio_analysis_error_count ?? 0) >= 3) {
      contentNode = contentNodes[Math.floor(Math.random() * contentNodes.length)]
    }
    if ((track.audio_analysis_error_count ?? 0) >= 3 && i < 3) {
      contentNode = 'https://creatornode2.audius.co'
    }

    try {
      let analysisUrl = `${contentNode}/uploads/${audioUploadId}`
      if (isLegacyTrack) {
        analysisUrl = `${contentNode}/tracks/legacy/${trackCid}/analysis`
      }
      const response = await axios.get(analysisUrl, { timeout: REQUEST_TIMEOUT })

      if (response.status === 200) {
        const resultsKey = isLegacyTrack ? 'results' : 'audio_analysis_results'
        const errorCountKey = isLegacyTrack ? 'error_count' : 'audio_analysis_error_count'
        const statusKey = isLegacyTrack ? 'status' : 'audio_analysis_status'
        const results = response.data[resultsKey]
        const errorCount = response.data[errorCountKey]
        const analysisStatus = response.data[statusKey]

        if (results == null && analysisStatus !== 'error') continue

        console.log(
          `Successfully retrieved audio analysis results for track ID ${track.track_id}, track CID ${trackCid}${audioUploadId ? `, upload ID: ${audioUploadId}` : ''} via ${contentNode}`
        )

        let musicalKey: string | null = null
        let bpm: number | null = null
        if (results?.key != null) {
          if (results.key.length > 12) {
            console.log(`Skipping bad musical key from ${analysisUrl}`)
            continue
          }
          musicalKey = results.key
        } else if (results?.Key != null) {
          if (results.Key.length > 12) {
            console.log(`Skipping bad musical key from ${analysisUrl}`)
            continue
          }
          musicalKey = results.Key
        }
        if (results?.bpm != null) bpm = results.bpm
        else if (results?.BPM != null) bpm = results.BPM

        if (
          musicalKey === track.musical_key &&
          bpm === track.bpm &&
          errorCount === track.audio_analysis_error_count
        ) {
          break
        }
        formattedResult = {
          track_id: track.track_id,
          musical_key: musicalKey,
          bpm,
          error_count: errorCount
        }
        break
      } else {
        console.log(
          formatErrorLog(`Received ${response.status} response`, track, contentNode, i + 1)
        )
        if (response.status !== 404 && checkStoreAllNodeNext) {
          console.log('Sleeping before retrying prod cn2')
          await new Promise((resolve) => setTimeout(resolve, 10000))
        }
        continue
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(formatErrorLog(message, track, contentNode, i + 1))
      if (checkStoreAllNodeNext) {
        console.log('Sleeping before retrying prod cn2')
        await new Promise((resolve) => setTimeout(resolve, 10000))
      }
      continue
    }
  }
  release()
  return formattedResult
}

async function fetchTracks (
  offset: number,
  limit: number,
  db: ReturnType<App['getDnDb']>
): Promise<TrackRow[]> {
  return await db('tracks')
    .select(
      'track_id',
      'track_cid',
      'audio_upload_id',
      'musical_key',
      'bpm',
      'audio_analysis_error_count'
    )
    .andWhere('track_cid', 'is not', null)
    .andWhere('genre', '!=', 'Podcasts')
    .andWhere('genre', '!=', 'Podcast')
    .andWhere('genre', '!=', 'Audiobooks')
    .orderBy('track_id', 'asc')
    .offset(offset)
    .limit(limit)
}

async function processBatches (
  db: ReturnType<App['getDnDb']>,
  batchSize: number
): Promise<void> {
  let offset: number | null
  while (true) {
    console.time('Batch processing time')
    const contentNodes = await getCachedHealthyContentNodes()
    if (contentNodes.length === 0) {
      console.timeEnd('Batch processing time')
      console.error('No healthy content nodes found. Please investigate')
      return
    }
    offset = await readDbOffset(DB_OFFSET_KEY)
    if (offset == null) offset = 0

    const tracks = await fetchTracks(offset, batchSize, db)
    if (tracks.length === 0) {
      console.timeEnd('Batch processing time')
      break
    }

    const analyzePromises = tracks.map((track) =>
      getAudioAnalysis(contentNodes.map((n) => n.endpoint), track)
    )
    const updates = (await Promise.all(analyzePromises)).filter(
      (u): u is UpdateRow => u != null
    )
    console.log(`Updating ${updates.length} tracks`)

    await db.transaction(async (trx) => {
      for (const update of updates) {
        await trx('tracks')
          .where({ track_id: update.track_id })
          .update({
            musical_key: update.musical_key ?? trx.raw('musical_key'),
            bpm: update.bpm ?? trx.raw('bpm'),
            audio_analysis_error_count: update.error_count
          })
      }
    })

    offset += batchSize
    await storeDbOffset(DB_OFFSET_KEY, offset)
    console.timeEnd('Batch processing time')
    console.log(`Processed ${tracks.length} tracks. New offset: ${offset}`)

    if (getConfig().testRun) {
      console.log(
        `[TEST RUN] Saved audio analyses for the following track IDs: ${tracks.map((t) => t.track_id)}`
      )
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 10000))
  }
}

export async function backfillDiscovery (app: App): Promise<void> {
  const config = getConfig()
  if (!config.delegatePrivateKey) {
    console.error('Missing required delegate private key. Terminating...')
    return
  }
  if (config.environment !== 'prod') {
    console.log(
      'Discovery audio analysis backfill is only meant to run on prod. Terminating...'
    )
    return
  }
  const db = app.getDnDb()
  const BACKFILL_BATCH_SIZE = config.testRun ? 100 : 3000
  await processBatches(db, BACKFILL_BATCH_SIZE)
  console.log('backfill_discovery.ts | No more tracks to backfill. Goodbye!')
}
