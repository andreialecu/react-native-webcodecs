// Unit tests that run on Node, without a device (src/__tests__/unit). The
// e2e tests (jest.config.js) need the example app running on a device.
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/__tests__/unit/**/*.test.ts'],
  transform: {
    '^.+\\.(js|jsx|ts|tsx)$': 'babel-jest',
  },
};
