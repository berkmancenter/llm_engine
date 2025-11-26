class ApiError extends Error {
  public statusCode: number

  public isOperational: boolean

  public stack: string

  constructor(statusCode, message, isOperational = true, stack = '') {
    super(message)
    this.statusCode = statusCode
    this.isOperational = isOperational
    if (stack) {
      this.stack = stack
    } else {
      Error.captureStackTrace(this, this.constructor)
    }
  }
}
export default ApiError
