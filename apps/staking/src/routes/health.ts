import { NextFunction, Request, Response } from 'express'
import { App } from '@pedalboard/basekit'
import { SharedData } from '..'

export const health = (_app: App<SharedData>) => async (
  _req: Request,
  res: Response,
  next: NextFunction
) => {
  res.send({ status: 'ok' })
  next()
}
