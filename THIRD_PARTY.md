# Third-party Skill references

Knowledge Relay pins the following user-selected repositories as Git submodules. The Knowledge Relay
process does not execute them; the separate official Nanobot Runtime installs and executes them as
workspace Skills. Docker builds copy the pinned submodule contents into the Nanobot sidecar only.

| Reference | Pinned revision | Usage |
| --- | --- | --- |
| [freestylefly/wechat-article-extractor-skill](https://github.com/freestylefly/wechat-article-extractor-skill) | `d8f74b8946065e64537f1ad39f962dbed86da3c7` | Complete original WeChat extraction Skill |
| [aresbit/fetch-skill](https://github.com/aresbit/fetch-skill) | `d67a579dd4533386e41b6175e07a70c10b6a0c8e` | Complete original URL routing/fetch Skill |
| [axtonliu/axton-obsidian-visual-skills](https://github.com/axtonliu/axton-obsidian-visual-skills) | `1265976d9746a84858b4b7b42fb86a215aa93de9` | Original Mermaid, Obsidian Canvas and Excalidraw Skills; MIT licensed |

The first repository states MIT in its README but does not include a license file at the pinned
revision. The second repository has no license file at the pinned revision. They remain separate
upstream repositories rather than copied source owned by this project. Before distributing a
prebuilt public image that contains either Skill, obtain or confirm the required redistribution
permission; source-based deployment can initialize the pinned submodules directly from upstream.

The Axton Obsidian Visual Skills repository is distributed under the MIT License. Its original
copyright and license remain in the pinned submodule. Knowledge Relay uses the Skills as Nanobot
workspace instructions and implements its own deterministic, validated web renderer and export
pipeline; it does not embed executable code from the generated diagram content.

## Document ingestion libraries

The application also uses the following runtime libraries for browser uploads and deterministic
document extraction. Their original licenses and notices remain available in their npm packages.

| Package | License | Usage |
| --- | --- | --- |
| `@fastify/multipart` | MIT | Bounded, streaming multipart uploads |
| `better-sqlite3` | MIT | Bundled SQLite runtime with FTS5 enabled on supported Linux, macOS and Windows targets |
| `pdfjs-dist` | Apache-2.0 | Local PDF text extraction |
| `turndown-plugin-gfm` | MIT | Preserve tables and other GitHub Flavored Markdown structures |
