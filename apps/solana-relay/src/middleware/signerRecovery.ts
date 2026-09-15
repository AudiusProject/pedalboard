import { Table, Users } from '@pedalboard/storage'
import { recoverPersonalSignature } from 'eth-sig-util'
import { NextFunction, Request, Response } from 'express'

import { db } from '../db'

export const userSignerRecoveryMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = req.get('Encoded-Data-Message')
    const sig = req.get('Encoded-Data-Signature')

    if (!sig || !data) {
      return next()
    }
    const walletAddress = recoverPersonalSignature({ data, sig })
    const user = await db<Users>(Table.Users)
      .where('wallet', '=', walletAddress)
      .first()
    res.locals.signerUser = user
    if (!user) {
      res.locals.logger.warn(
        { walletAddress },
        'No user found matching signature'
      )
    }
    next()
  } catch (e) {
    next(e)
  }
}

