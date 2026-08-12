# Changelog

## 1.2.2 - 2026-08-13

- Kept environment-provided model keys as runtime-only secrets instead of copying them into the encrypted database when settings are saved.

## 1.2.1 - 2026-08-13

- Added an explicit, default-off compatibility mode for trusted local proxies that use the `198.18.0.0/15` Fake-IP range.
- Fixed pinned-address lookup behavior on Node.js versions that request all DNS results.
- Verified the full public webpage → Markdown → DeepSeek classification path.

## 1.2.0 - 2026-08-13

- Added safe WeChat article and generic webpage adapters with pinned upstream references.
- Added derived Markdown attachments and Obsidian plugin 1.2.0 support.
- Added DeepSeek V4 JSON-mode compatibility and real completion health tests.
- Added model failure fallback with deduplicated WeChat alerts.
- Preserved admin routes across refresh/back/forward and added plugin download.
- Added login throttling, security headers, origin checks, Docker healthcheck, and release docs.
