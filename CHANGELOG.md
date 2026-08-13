# Changelog

## 1.6.1 - 2026-08-13

- Moved Obsidian plugin development and releases into a standalone repository while keeping a pinned integration reference in the main product.
- Upgraded the plugin to 1.3.1 and bundled all local modules into a single `main.js` with esbuild, fixing Obsidian activation failures caused by `require("./template.cjs")`.
- Added standalone plugin CI, versioned release packaging, checksum generation, and a regression check that rejects runtime local-module imports.
- Updated the server-bundled plugin package to contain only the five required Obsidian installation files.

## 1.6.0 - 2026-08-13

- Kept the two pinned upstream runtime Skills unchanged while adding deterministic URL routing and artifact rules around them.
- Replaced the conflicting Obsidian-Markdown prompt with structured knowledge-value, action, sensitivity, confidence, and warning guidance.
- Added professional rules for multimodal captures and cybersecurity research, and strengthened inbox routing and document-to-Markdown behavior.
- Split the Skills screen into executable Nanobot Skills and non-executable organization rules.
- Disabled unrelated bundled Nanobot Skills in the dedicated inbox Runtime to reduce accidental tool selection and unnecessary capability exposure.
- Allowed document-derived Markdown artifacts, prevented same-message artifact filename collisions, and enforced the supported category vocabulary server-side.

## 1.5.1 - 2026-08-13

- Recover interrupted AI work on startup and automatically restart a failed managed Nanobot Runtime.
- Unified remaining legacy green panels, forms, dialogs, Skills, sync cards, tokens, and success feedback into the blue-cyan-violet interface system.
- Replaced layout-shifting success banners with compact auto-dismissing status toasts and clearer refresh feedback.
- Added no-store delivery and UI build negotiation so an open console reloads automatically after future server interface upgrades.

## 1.5.0 - 2026-08-13

- Split the capture flow into a durable raw revision followed by an optional Nanobot-enriched revision, so AI latency or failure cannot block Obsidian delivery.
- Added sync protocol 1.1 fields with permanent remote IDs, deterministic content versions, source metadata, processing state, sensitivity, and idempotent ACK/reset semantics.
- Rebuilt Obsidian plugin 1.3.0 around ID-only deduplication, managed Markdown blocks, preserved user-owned sections/frontmatter, bounded retries, startup sync, explicit optional polling, and local sync status.
- Added sensitivity filtering, SHA-256 attachment verification, untrusted Markdown sanitization, token redaction, and conflict-safe handling for legacy notes without managed markers.
- Added plugin commands for immediate sync, status, local index repair, cursor reset, inbox navigation, and recent error inspection.
- Made the download endpoint choose the highest version between persistent uploaded releases and the application-bundled plugin.
- Added protocol, recovery, migration, and engineering audit documentation.

## 1.4.0 - 2026-08-13

- Added an integrated Nanobot provider console for API-key providers, local runtimes, custom OpenAI-compatible endpoints, and local OpenAI Codex OAuth.
- Added automatic Nanobot Runtime reload after provider configuration changes.
- Added a Nanobot-owned live model catalog with searchable browser-native model suggestions and manual fallback.
- Moved live model feedback into a dedicated status rail, aligned provider controls, and added a responsive two-column Agent workspace for wide screens.
- Grouped Agent diagnostics inside the provider console, equalized the wide-screen work cards, and moved account security from the dashboard into a dedicated Settings page.
- Rewrote user-facing guidance around goals and outcomes, while keeping infrastructure terminology inside advanced configuration only.
- Moved the low-frequency Settings entry beside the personal account on desktop, while preserving a compact mobile navigation fallback.
- Rebuilt Obsidian onboarding as a stable two-step setup with an always-visible plugin download, compact connection form, responsive status column, and purposeful empty state.
- Added owner-only Obsidian plugin publishing with ZIP validation, version protection, atomic persistent storage, live release metadata, and a stable download URL.
- Rebalanced the Obsidian workspace into two focused setup cards and a full-width connection status area, with infrequent plugin publishing moved into a dedicated dialog.
- Consolidated the primary navigation into Inbox, Obsidian, and Settings; merged the dashboard with the inbox, grouped infrequent WeChat/AI/Skill configuration under a status-aware settings hub, and rebuilt the sidebar account control.
- Replaced the sidebar with a compact top application bar, moved the personal account into an avatar menu, and flattened WeChat, AI, Skills, and account settings into one-click tabs.
- Added a live AI processing observatory with real message status, category distribution, and recent organization results; refreshed the product theme with a unified blue-cyan-violet visual system.
- Moved account security exclusively into the avatar menu, added editable personal naming, and required matching new-password confirmation on both client and server.
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
