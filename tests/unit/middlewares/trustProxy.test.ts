import httpMocks from 'node-mocks-http'
import { warnOnShortForwardedChain } from '../../../src/middlewares/trustProxy.js'
import logger from '../../../src/config/logger.js'

const requestWith = (forwardedFor?: string, url = '/v1/auth/invite/resend') =>
  httpMocks.createRequest({
    url,
    originalUrl: url,
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }
  })

describe('warnOnShortForwardedChain', () => {
  let warnSpy

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  test('stays quiet when the header has as many entries as the configured hops', () => {
    const middleware = warnOnShortForwardedChain(3)
    const next = jest.fn()

    middleware(requestWith('198.51.100.1, 192.0.2.10, 192.0.2.20'), httpMocks.createResponse(), next)

    expect(warnSpy).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('warns once, without any address, when the header is shorter than the configured hops', () => {
    const middleware = warnOnShortForwardedChain(3)
    const next = jest.fn()

    middleware(requestWith('198.51.100.1, 192.0.2.10'), httpMocks.createResponse(), next)
    middleware(requestWith('198.51.100.2, 192.0.2.10'), httpMocks.createResponse(), next)

    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [message] = warnSpy.mock.calls[0]
    expect(message).toContain('TRUST_PROXY_HOPS')
    expect(message).not.toMatch(/\d+\.\d+\.\d+\.\d+/)
    expect(next).toHaveBeenCalledTimes(2)
  })

  test('warns when a request arrives with no forwarded header at all', () => {
    const middleware = warnOnShortForwardedChain(3)

    middleware(requestWith(), httpMocks.createResponse(), jest.fn())

    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  test('ignores health checks, which never carry the header', () => {
    const middleware = warnOnShortForwardedChain(3)

    middleware(requestWith(undefined, '/v1/health'), httpMocks.createResponse(), jest.fn())

    expect(warnSpy).not.toHaveBeenCalled()
  })
})
