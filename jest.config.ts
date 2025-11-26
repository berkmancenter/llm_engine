export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: [
    '**/tests/**/*.test.ts',
    '!**/tests/agents/**/*.test.ts',
    '!**/tests/adapters/development/**/*.test.ts',
    '!**/tests/handlers/development/**/*.test.ts'
  ],
  setupFilesAfterEnv: ['./tests/setup.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true
      }
    ]
  }
}
