# Third-party Skill references

Knowledge Relay does **not** redistribute or execute the scripts from the following repositories.
It implements an independent, restricted TypeScript adapter after reviewing their documented behavior.

| Reference | Pinned revision | Usage |
| --- | --- | --- |
| [freestylefly/wechat-article-extractor-skill](https://github.com/freestylefly/wechat-article-extractor-skill) | `d8f74b8946065e64537f1ad39f962dbed86da3c7` | WeChat article metadata and content-field reference |
| [aresbit/fetch-skill](https://github.com/aresbit/fetch-skill) | `d67a579dd4533386e41b6175e07a70c10b6a0c8e` | URL-type routing and Markdown output reference |

The local audit clones under `external-skills/` are ignored by Git and are not part of releases.
The first repository states MIT in its README but does not include a license file at the pinned
revision. The second repository has no license file at the pinned revision. No source from either
repository is copied into this project.
