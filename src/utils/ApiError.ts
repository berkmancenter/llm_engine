interface ApiErrorOptions {
  isOperational?: boolean
  stack?: string
  /** A fixed string sent to the client, so it can tell apart refusals that share a status code. */
  reason?: string
}

class ApiError extends Error {
  public statusCode: number

  public isOperational: boolean

  public stack: string

  public reason?: string

  constructor(statusCode, message, { isOperational = true, stack = '', reason }: ApiErrorOptions = {}) {
    super(message)
    this.statusCode = statusCode
    this.isOperational = isOperational
    this.reason = reason
    if (stack) {
      this.stack = stack
    } else {
      Error.captureStackTrace(this, this.constructor)
    }
  }
}
export default ApiError
