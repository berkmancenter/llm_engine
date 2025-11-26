class WebsocketError extends Error {
  public originalError: { [key: string]: unknown }

  public data: { [key: string]: unknown }

  public statusCode: number

  constructor(error, data) {
    super(error.message)
    this.originalError = error
    this.data = data
    this.statusCode = error.statusCode
    Error.captureStackTrace(this, this.constructor)
  }
}
export default WebsocketError
