# Privacy

Knowledge Relay is a self-hosted, single-owner inbox. Messages, attachments, derived Markdown,
sync state, encrypted iLink credentials, and encrypted model keys are stored under `DATA_DIR`.

When AI processing is enabled, message text and safely extracted article text are sent to the
configured model endpoint. WeChat and generic webpage adapters fetch the original public URL
directly; they do not use Jina, defuddle, markdown.new, or another reader proxy by default.

The Obsidian plugin sends only its device token to the configured Knowledge Relay server and
downloads the sync batches and attachments authorized for that device. Public deployments must
use HTTPS.
