import express from 'express'

export const startHealthServer = (port: number): Promise<void> => {
  const app = express()
  app.get('/health_check', (_req, res) => {
    res.status(200).json({ healthy: 'yes' })
  })
  return new Promise((resolve, reject) => {
    app.listen(port, () => resolve()).on('error', reject)
  })
}
