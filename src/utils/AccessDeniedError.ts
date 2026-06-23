export default class AccessDeniedError extends Error {
  statusCode = 403

  constructor(message: string) {
    super(message)
    this.name = 'AccessDeniedError'
  }
}
