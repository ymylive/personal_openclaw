module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/__tests__/**/*.test.js', '**/*.test.js'],
    collectCoverageFrom: [
        '**/*.js',
        '!node_modules/**',
        '!AdminPanel/**',
        '!jest.config.js'
    ],
    coverageDirectory: 'coverage',
    coverageThreshold: {
        global: { lines: 10 }
    }
};
