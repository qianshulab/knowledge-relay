# Security

Security fixes are applied to the latest release.

Please use GitHub private vulnerability reporting instead of opening a public issue. Include the affected version, a minimal reproduction, and the expected impact.

- Synchronization tokens are stored in the plugin's `data.json`; protect the Vault configuration directory and revoke the server connection when a device is lost.
- Non-local Knowledge Relay servers must use HTTPS.
- Downloaded attachments are checked against the server-provided SHA-256 before being written.
- External Markdown is sanitized before entering a managed note block.
- Release ZIP files contain a bundled `main.js`; the plugin does not load local source modules at runtime.
