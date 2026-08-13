# Third-party Skill references

Knowledge Relay pins the following user-selected repositories as Git submodules. The Knowledge Relay
process does not execute them; the separate official Nanobot Runtime installs and executes them as
workspace Skills. Docker builds copy the pinned submodule contents into the Nanobot sidecar only.

| Reference | Pinned revision | Usage |
| --- | --- | --- |
| [freestylefly/wechat-article-extractor-skill](https://github.com/freestylefly/wechat-article-extractor-skill) | `d8f74b8946065e64537f1ad39f962dbed86da3c7` | Complete original WeChat extraction Skill |
| [aresbit/fetch-skill](https://github.com/aresbit/fetch-skill) | `d67a579dd4533386e41b6175e07a70c10b6a0c8e` | Complete original URL routing/fetch Skill |

The first repository states MIT in its README but does not include a license file at the pinned
revision. The second repository has no license file at the pinned revision. They remain separate
upstream repositories rather than copied source owned by this project. Before distributing a
prebuilt public image that contains either Skill, obtain or confirm the required redistribution
permission; source-based deployment can initialize the pinned submodules directly from upstream.
