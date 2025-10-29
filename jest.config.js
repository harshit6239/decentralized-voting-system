/** @type {import('jest').Config} */
module.exports = {
    testEnvironment: "node",
    testMatch: [
        "**/src/tests/**/*.test.js",
        "**/src/ledger/tests/**/*.test.js",
        "**/src/audit/tests/**/*.test.js",
    ],
    collectCoverageFrom: ["src/**/*.js", "!src/tests/**"],
    passWithNoTests: true,
};
