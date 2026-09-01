import { jest } from '@jest/globals'

// eslint-disable-next-line @typescript-eslint/no-explicit-any, import/newline-after-import
;(globalThis as any).jest = jest

jest.setTimeout(30000)
