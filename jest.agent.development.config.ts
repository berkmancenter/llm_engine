export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/agents/development/**/*.test.ts'],
  setupFilesAfterEnv: ['./tests/setup.ts'],
  reporters: ['default', 'langsmith/jest/reporter'],
  extensionsToTreatAsEsm: ['.ts'],
  globalSetup: './jest.agent.globalSetup.js',
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
