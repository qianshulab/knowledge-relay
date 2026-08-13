# Knowledge Relay 1.3 — ten-round product review

1. **Supply chain:** pinned both requested Skill sources; rejected dynamic webpage script execution and runtime code downloads; shipped an independent adapter.
2. **Safe fetch:** validates HTTP(S), credentials, ports, every DNS answer and redirect; blocks private/reserved IPs; limits time, redirects, bytes, encodings, and content types.
3. **Parsing:** has a dedicated WeChat selector path and a Readability-based general webpage path; removes active content and converts the result to Markdown.
4. **Nanobot pipeline:** Knowledge Relay calls only the official Nanobot Runtime; Nanobot owns DeepSeek configuration, Agent Loop, tools, original workspace Skills, and model behavior.
5. **Fallback:** a model failure keeps the original note, records the reason, creates no partial Markdown attachment, and can send a redacted, deduplicated WeChat alert.
6. **Obsidian:** derived `.md` files join the normal attachment snapshot, are checksum verified, written as UTF-8, and ACKed only after the whole batch succeeds.
7. **UI:** route hash survives refresh/back/forward; adapters and prompt rules are visibly different; model pipeline and plugin download are shown in context.
8. **Security:** login throttling, security headers, origin checks, encrypted secrets, redacted provider errors, dependency audit, and 30 automated tests.
9. **Docker:** non-root runtime, init, healthcheck, no-new-privileges, bounded tmpfs, persistent data volume, and plugin release asset in the image.
10. **Release:** MIT license, third-party notice, privacy/security/contribution docs, changelog, CI, plugin checksum, and public-repository hygiene.

Product references informed the iteration: Obsidian Web Clipper's template matching and interpreter
context; Cubox's capture → parse/snapshot → AI → tag/search → export flow. Knowledge Relay keeps a
narrower promise: capture from WeChat and reliably land an auditable Markdown representation in a
user-owned Vault.
