/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testTimeout: 10000,
  setupFiles: ['<rootDir>/src/__tests__/jest.setup-env.js'],
  testPathIgnorePatterns: ['<rootDir>/dist'],
  testMatch: ['**/__tests__/**/*.test.ts']
}
