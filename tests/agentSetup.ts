import { jest } from '@jest/globals'

// These tests ask a real model, so a correct agent can still give one off answer. A retry keeps a
// single bad answer from failing CI; a real bug fails every try, and each failed try is logged.
jest.retryTimes(2, { logErrorsBeforeRetry: true })
