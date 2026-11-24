module.exports = {
  preset: '@react-native/jest-preset',
  modulePathIgnorePatterns: [
    '<rootDir>/lib/',
    '<rootDir>/example/',
    '(setup)|(setup.(ts|tsx))',
    'components',
    'config.ts',
    'globalSetup.ts',
    'globalTeardown.ts'
  ],
  // modulePathIgnorePatterns only affects the module registry, not test
  // discovery. Without this, the .d.ts files emitted into lib/ by `bob build`
  // are picked up as test suites and fail with "must contain at least one test".
  // The unit tests (src/__tests__/unit) run with jest.unit.config.js.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/lib/', '<rootDir>/example/', '/__tests__/unit/'],
  globalSetup: './src/__tests__/globalSetup.ts',
  globalTeardown: './src/__tests__/globalTeardown.ts',
  transform: {
    '^.+\\.(js|jsx|ts|tsx)$': 'babel-jest',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|react-native-.*)/)',
  ],
};
