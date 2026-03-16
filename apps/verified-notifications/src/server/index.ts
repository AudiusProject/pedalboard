import express from 'express'
import { router as healthCheckRouter } from './routes/healthCheck'
import { createLogger } from '@pedalboard/logger'

const logger = createLogger('verified-notifications')

const DEFAULT_PORT = 6000

export class Server {
  app: express.Express
  port: number
  httpServer?: ReturnType<express.Express['listen']>

  constructor(port = DEFAULT_PORT) {
    this.app = express()
    this.port = port
  }

  init = async (): Promise<void> => {
    this.app.use('/health_check', healthCheckRouter)

    await new Promise<void>((resolve) => {
      this.httpServer = this.app.listen(this.port, () => {
        logger.info({ port: this.port }, 'server started at http://localhost:' + this.port)
        resolve()
      })
    })
  }

  close = (): void => {
    this.httpServer?.close()
    logger.info('server closed')
  }
}
