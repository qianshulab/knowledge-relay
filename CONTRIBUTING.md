# Contributing

1. Use Node.js 22.13 or newer and run `npm ci`.
2. Create a focused branch and add tests for behavior changes.
3. Run `npm run verify` and `npm audit` before opening a pull request.
4. Never include real API keys, iLink tokens, sync tokens, databases, or personal Vault files.

External Skill integrations must pin their source revision, document licensing,
avoid runtime code downloads, and pass the URL/redirect/private-network tests.
