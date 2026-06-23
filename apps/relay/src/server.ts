import { healthCheck } from './routes/health'
import express from 'express'
import { errorHandler } from './middleware/errorHandler'
import { incomingRequestLogger } from './middleware/logging'
import { validator } from './middleware/validator'
import cors from 'cors'
import bodyParser from 'body-parser'
import { relayTransaction } from './txRelay'

export const app = express()

app.use(bodyParser.json())
app.use(
  bodyParser.urlencoded({
    extended: true
  })
)
app.use(bodyParser.text())
app.use(cors())

/** Reads */
app.get('/relay/health', incomingRequestLogger, healthCheck)

/** Writes */
app.post(
  '/relay',
  incomingRequestLogger,
  validator,
  // rateLimiterMiddleware,
  // antiAbuseMiddleware,
  relayTransaction
)

/** Register top level middlewares */
app.use(errorHandler)
