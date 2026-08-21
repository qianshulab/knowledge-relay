# Privacy

Knowledge Relay is a self-hosted knowledge inbox. Each account has an isolated tenant identity;
messages, metadata, API tokens, bot connections, sync targets, and resource state are scoped to that
tenant. New attachments and derived Markdown are also written to tenant-specific directories under
`DATA_DIR`. Administrators can manage accounts and system-level model configuration, but ordinary
accounts cannot access another tenant's records or Runtime workspace.

Model credentials may be supplied through the Nanobot environment or saved from the administrator
control panel directly into Nanobot's `config.json`. They are not stored in the Knowledge Relay
database and are never returned to the browser after saving. Protect and back up the Nanobot config
as a secret-bearing file.

When Nanobot processing is enabled, message text and supported attachments are sent to the local,
tenant-dedicated Nanobot Runtime. Runtime workspaces, sessions, artifacts, and retrieval planning are
separated by tenant. Nanobot then sends the task context to its configured model provider. The original
`fetch-skill` may send a URL to Jina Reader, defuddle.md, markdown.new, FxTwitter, Camofox, WeSpy,
or a configured WeChat exporter according to its documented fallback chain. Disable that Skill if
those third-party transfers are not acceptable. The original WeChat extractor fetches the public
WeChat page directly.

Article images are downloaded once and stored as tenant-scoped attachments instead of being hotlinked
when a reader opens the page. If the host resolver is unavailable or returns a proxy Fake-IP, the
image cache may query a pinned AliDNS or Cloudflare DNS-over-HTTPS endpoint to verify that the image
hostname resolves only to public addresses. That fallback sends the hostname only; it does not send
article content, cookies, authorization headers, model credentials, or account data.

The Obsidian plugin sends only its device token to the configured Knowledge Relay server and
downloads the sync batches and attachments authorized for that device. Public deployments must
use HTTPS.
