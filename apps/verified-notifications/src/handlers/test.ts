import { isOldUpload } from './tracks'

const oldDate = 'Thu Nov 05 2020 20:36:07 GMT-0600'
const isOld = isOldUpload(oldDate)

// uploaded right now
const isNew = isOldUpload(new Date())

if (!isOld) {
  throw new Error('failed')
}

if (isNew) {
  throw new Error('failed here')
}
