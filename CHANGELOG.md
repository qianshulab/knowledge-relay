# Changelog

## 1.4.0 - 2026-08-13

- Added an integrated Nanobot provider console for API-key providers, local runtimes, custom OpenAI-compatible endpoints, and local OpenAI Codex OAuth.
- Added automatic Nanobot Runtime reload after provider configuration changes.
- Added a Nanobot-owned live model catalog with searchable browser-native model suggestions and manual fallback.
- Moved live model feedback into a dedicated status rail, aligned provider controls, and added a responsive two-column Agent workspace for wide screens.
- Grouped Agent diagnostics inside the provider console, equalized the wide-screen work cards, and moved account security from the dashboard into a dedicated Settings page.
- Rewrote user-facing guidance around goals and outcomes, while keeping infrastructure terminology inside advanced configuration only.
- Moved the low-frequency Settings entry beside the personal account on desktop, while preserving a compact mobile navigation fallback.
- Rebuilt Obsidian onboarding as a stable two-step setup with an always-visible plugin download, compact connection form, responsive status column, and purposeful empty state.
- Consolidated duplicate WeChat article rules into the single original workspace Skill.
- Refined the administration UI with a more dimensional runtime dashboard and cleaner Skill cards.
- Stabilized scrolling by replacing fixed blurred animation layers and hover movement with lightweight static effects.
- Added Docker build-time checks for the Python fetch tool, Node.js WeChat extractor, and Nanobot document/API runtime.

## 1.3.0 - 2026-08-13

- Made the official Nanobot Runtime the only AI execution path; Knowledge Relay no longer calls DeepSeek or fetches web pages itself.
- Installed the two requested upstream Skills at pinned revisions and made the admin UI edit the actual workspace `SKILL.md` files.
- Added a managed local Nanobot launcher and an isolated Docker sidecar with Node/Python Skill dependencies.
- Added derived-artifact validation, multipart upload limits, and an isolated original WeChat extractor launcher.
- Removed legacy provider keys and model choices from Knowledge Relay storage and UI.

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
