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
- Back up `data/inbox.sqlite`, `data/media`, `data/derived`, and `data/app-secret.key` together.
- Rotate a model key immediately if it was exposed in a terminal, issue, build log, or chat.
- The model-provider form is an owner-only Nanobot control plane. Use it only over localhost or HTTPS; saved keys live in the mode-0600 Nanobot config and are never returned by the API.
- Only enable Skills you trust. The Knowledge Relay process never executes Skill scripts; the isolated official Nanobot Runtime executes the two pinned workspace Skills and has network access by design.
