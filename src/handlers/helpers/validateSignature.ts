import crypto from 'crypto'
import httpStatus from 'http-status'
import ApiError from '../../utils/ApiError.js'

export default function validateSignature(
  timestamp: string,
  rawBody: string,
  providedSignature: string,
  secret: string
): boolean {
  // Prevent replay attacks (5-minute window)
  const FIVE_MINUTES = 60 * 5
  const time = Math.floor(Date.now() / 1000)
  if (Math.abs(time - parseInt(timestamp, 10)) > FIVE_MINUTES) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Request too old')
  }

  const baseString = `v0:${timestamp}:${rawBody}`
  const computedSignature = `v0=${crypto.createHmac('sha256', secret).update(baseString, 'utf8').digest('hex')}`

  // Compare signatures using constant-time comparison
  let isValid = false
  try {
    if (providedSignature && computedSignature.length === providedSignature.length) {
      isValid = crypto.timingSafeEqual(Buffer.from(computedSignature, 'utf8'), Buffer.from(providedSignature, 'utf8'))
    }
  } catch {
    // If timingSafeEqual fails for any reason, signature is invalid
    isValid = false
  }

  return isValid
}
