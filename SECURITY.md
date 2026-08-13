# Security

## Supported version

Security fixes are applied to the latest release.

## Reporting

Please do not open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability reporting for this repository and include a minimal
reproduction, affected version, and impact.

## Deployment baseline

- Bind to `127.0.0.1` unless an HTTPS reverse proxy is in front of the service.
- Never commit `.env`, `data/`, Obsidian sync tokens, iLink credentials, or API keys.
- Obsidian plugin publishing is owner-authenticated and origin-checked. Uploaded ZIP files are never extracted on the server; structure, paths, size, version, CRC, plugin ID, and SHA-256 are validated before an atomic persistent publish.
- Back up `data/inbox.sqlite`, `data/media`, `data/derived`, and `data/app-secret.key` together.
- Rotate a model key immediately if it was exposed in a terminal, issue, build log, or chat.
- The model-provider form is an owner-only Nanobot control plane. Use it only over localhost or HTTPS; saved keys live in the mode-0600 Nanobot config and are never returned by the API.
- Live model discovery runs inside the authenticated Nanobot sidecar and returns model metadata only; Knowledge Relay never receives the provider credential.
- Only enable Skills you trust. The Knowledge Relay process never executes Skill scripts; the isolated official Nanobot Runtime executes the two pinned workspace Skills and has network access by design.
- Treat every synchronized Markdown body as untrusted. Plugin 1.3 strips active HTML, dangerous URI schemes, local embeds, and automatic remote image loading before writing a managed block.
- Sync ACK payloads contain remote ID, version, result, and a random local reference only; Vault paths, note content, model prompts, and tokens are not returned to the server.
- `restricted` records are never written to a normal Vault. This is a delivery guard, not a replacement for filesystem encryption or device security.
