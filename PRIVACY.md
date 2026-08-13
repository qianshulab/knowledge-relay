# Privacy

Knowledge Relay is a self-hosted, single-owner inbox. Messages, attachments, derived Markdown,
sync state, and encrypted iLink credentials are stored under `DATA_DIR`. The model key is supplied
to the separate Nanobot Runtime through its environment and is not stored by Knowledge Relay.

When Nanobot processing is enabled, message text and supported attachments are sent to the local
Nanobot Runtime. Nanobot then sends the task context to its configured model provider. The original
`fetch-skill` may send a URL to Jina Reader, defuddle.md, markdown.new, FxTwitter, Camofox, WeSpy,
or a configured WeChat exporter according to its documented fallback chain. Disable that Skill if
those third-party transfers are not acceptable. The original WeChat extractor fetches the public
WeChat page directly.

The Obsidian plugin sends only its device token to the configured Knowledge Relay server and
downloads the sync batches and attachments authorized for that device. Public deployments must
use HTTPS.
