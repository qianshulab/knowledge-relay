"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// src/template.cjs
var require_template = __commonJS({
  "src/template.cjs"(exports2, module2) {
    "use strict";
    var MANAGED_START = "<!-- knowledge-relay:managed:start -->";
    var MANAGED_END = "<!-- knowledge-relay:managed:end -->";
    function formatLocalDate(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value || "").slice(0, 10);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }
    function formatLocalTime(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join("");
    }
    function yamlString(value) {
      return JSON.stringify(String(value == null ? "" : value).replace(/[\r\n]+/g, " "));
    }
    function stripFrontmatter(markdown) {
      return String(markdown || "").replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "");
    }
    function extractOriginalContent(markdown) {
      const lines = stripFrontmatter(markdown).split(/\r?\n/);
      while (!lines[0] || /^#\s+/.test(lines[0])) lines.shift();
      const attachmentHeading = lines.findIndex((line) => /^##\s+附件\s*$/.test(line.trim()));
      const content = (attachmentHeading >= 0 ? lines.slice(0, attachmentHeading) : lines).join("\n").trim();
      return content || "\uFF08\u8FD9\u6761\u6D88\u606F\u4EC5\u5305\u542B\u9644\u4EF6\uFF09";
    }
    function summarize(content, title) {
      const lines = String(content || "").split(/\r?\n/).map((item) => item.replace(/^\s*(?:>|[-*+]\s+|#+\s*)/, "").trim()).filter((item) => item && !/^\[!/.test(item));
      const line = lines.find((item) => !/^https?:\/\/\S+$/i.test(item)) || lines[0];
      return (line || title || "\u5FAE\u4FE1\u6536\u4EF6").replace(/\s+/g, " ").slice(0, 500);
    }
    function firstUrl(content) {
      var _a;
      return ((_a = String(content || "").match(/https?:\/\/[^\s)>\]]+/i)) == null ? void 0 : _a[0]) || "";
    }
    function sanitizeMarkdown2(value, maximumLength = 22e4) {
      return String(value || "").replace(/\r\n?/g, "\n").replace(/<(script|style|iframe|object|embed|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "").replace(/<(script|style|iframe|object|embed|svg|math)\b[^>]*\/?>/gi, "").replace(/<\/?a\b[^>]*>/gi, "").replace(/<(?:img|audio|video|source|track|link|meta|form|input|button)\b[^>]*\/?>/gi, "").replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "").replace(/\]\(\s*(?:javascript|data\s*:\s*text\/html|file|obsidian)\s*:/gi, "](\u5DF2\u79FB\u9664\u4E0D\u5B89\u5168\u94FE\u63A5:").replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/gi, "[\u5916\u90E8\u56FE\u7247\uFF1A$1]($2)").replace(/!\[\[([^\]]+)\]\]/g, "[\u5DF2\u79FB\u9664\u5916\u90E8\u5D4C\u5165\uFF1A$1]").replace(/\u0000/g, "").slice(0, maximumLength).trim();
    }
    function sourceTypeLabel(value) {
      return { web: "\u7F51\u9875", rss: "RSS", api: "API", email: "\u90AE\u4EF6", manual: "\u624B\u5DE5\u5F55\u5165", cti: "\u5A01\u80C1\u60C5\u62A5", paper: "\u8BBA\u6587" }[value] || "\u5176\u4ED6";
    }
    function actionLabel(value) {
      return { none: "\u6682\u65E0\u5EFA\u8BAE", knowledge: "\u77E5\u8BC6\u5361\u7247", research: "\u7814\u7A76\u8BFE\u9898", project: "\u9879\u76EE", resource: "\u5B66\u4E60\u8D44\u6E90", practice: "\u5B89\u5168\u5B9E\u8DF5", delete: "\u5EFA\u8BAE\u5220\u9664" }[value] || "\u6682\u65E0\u5EFA\u8BAE";
    }
    function processingLabel(value) {
      return { pending: "\u5F85\u5904\u7406", enriched: "\u5DF2\u589E\u5F3A", fallback: "\u5DF2\u964D\u7EA7", failed: "\u5904\u7406\u5931\u8D25", completed: "\u5DF2\u589E\u5F3A" }[value] || "\u5F85\u5904\u7406";
    }
    function confidenceLabel(value) {
      return { high: "\u9AD8", medium: "\u4E2D", low: "\u4F4E" }[value] || "\u4F4E";
    }
    function sensitivityLabel(value) {
      return { public: "\u516C\u5F00", internal: "\u5185\u90E8", confidential: "\u673A\u5BC6", restricted: "\u4E25\u683C\u53D7\u9650" }[value] || "\u5185\u90E8";
    }
    function normalizeItem2(item) {
      const id = String(item.id || item.messageId || "");
      const markdown = sanitizeMarkdown2(item.contentMarkdown || extractOriginalContent(item.markdown));
      const sourceUrl = String(item.source && item.source.url || firstUrl(markdown));
      return {
        id,
        version: String(item.version || item.revision || "1"),
        revision: Number(item.revision || 1),
        title: String(item.title || "\u5FAE\u4FE1\u6536\u4EF6").replace(/[\r\n]+/g, " ").trim().slice(0, 120),
        createdAt: item.createdAt || item.receivedAt,
        updatedAt: item.updatedAt || item.receivedAt || item.createdAt,
        summary: String(item.summary || summarize(markdown, item.title)).replace(/[\r\n]+/g, " ").slice(0, 500),
        contentMarkdown: markdown.slice(0, 22e4),
        reason: String(item.reason || "").replace(/[\r\n]+/g, " ").slice(0, 300),
        suggestedAction: String(item.suggestedAction || "none"),
        source: {
          type: String(item.source && item.source.type || (sourceUrl ? "web" : "manual")),
          name: String(item.source && item.source.name || (sourceUrl ? "\u7F51\u9875\u6765\u6E90" : "\u5FAE\u4FE1 iLink")).replace(/[\r\n]+/g, " ").slice(0, 200),
          url: sourceUrl
        },
        tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === "string").slice(0, 10) : [],
        sensitivity: String(item.sensitivity || "internal"),
        deleted: item.deleted === true,
        processing: item.processing && typeof item.processing === "object" ? item.processing : {
          status: item.agentStatus || "fallback",
          confidence: "low",
          warnings: []
        },
        attachments: Array.isArray(item.attachments) ? item.attachments.filter((attachment) => attachment && typeof attachment === "object").map((attachment) => ({
          id: String(attachment.id || "").slice(0, 500),
          fileName: String(attachment.fileName || "\u9644\u4EF6").replace(/[\r\n|]+/g, " ").slice(0, 200),
          mimeType: String(attachment.mimeType || "application/octet-stream").replace(/[\r\n]+/g, "").slice(0, 100),
          size: Number(attachment.size || 0),
          sha256: String(attachment.sha256 || "").toLowerCase()
        })).slice(0, 50) : []
      };
    }
    function buildManagedBlock(item, attachmentLinks = []) {
      const value = normalizeItem2(item);
      const sourceLines = [
        `- **\u6765\u6E90\uFF1A** ${value.source.name || "\u5FAE\u4FE1 iLink"}`,
        `- **\u6765\u6E90\u7C7B\u578B\uFF1A** ${sourceTypeLabel(value.source.type)}`,
        ...value.source.url ? [`- **\u539F\u59CB\u94FE\u63A5\uFF1A** ${value.source.url}`] : []
      ];
      const warnings = Array.isArray(value.processing.warnings) ? value.processing.warnings.filter((warning) => typeof warning === "string").slice(0, 10) : [];
      return [
        MANAGED_START,
        "",
        "> [!todo] \u77E5\u6D41\u540C\u6B65\u6355\u83B7",
        "> \u8BF7\u5224\u65AD\u8FD9\u6761\u5185\u5BB9\u662F\u5426\u503C\u5F97\u8FDB\u4E00\u6B65\u63D0\u70BC\uFF1B\u77E5\u6D41\u53EA\u66F4\u65B0\u672C\u6258\u7BA1\u533A\u5757\u3002",
        "",
        "## \u4E00\u53E5\u8BDD\u8BF4\u660E",
        "",
        value.summary || "\uFF08\u5C1A\u672A\u751F\u6210\u6458\u8981\uFF09",
        "",
        "## \u539F\u59CB\u5185\u5BB9 / \u94FE\u63A5",
        "",
        ...sourceLines,
        "",
        "### \u540C\u6B65\u5185\u5BB9",
        "",
        value.contentMarkdown || "\uFF08\u8FD9\u6761\u6D88\u606F\u4EC5\u5305\u542B\u9644\u4EF6\uFF09",
        ...attachmentLinks.length ? ["", "### \u540C\u6B65\u9644\u4EF6", "", ...attachmentLinks] : [],
        "",
        "## \u4E3A\u4EC0\u4E48\u503C\u5F97\u4FDD\u7559",
        "",
        value.reason || "\uFF08\u7B49\u5F85\u4F60\u5224\u65AD\uFF09",
        "",
        "> [!info] AI \u6574\u7406\u5EFA\u8BAE",
        `> \u5EFA\u8BAE\u65B9\u5411\uFF1A${actionLabel(value.suggestedAction)}`,
        `> \u5904\u7406\u72B6\u6001\uFF1A${processingLabel(value.processing.status)}`,
        `> \u7F6E\u4FE1\u5EA6\uFF1A${confidenceLabel(value.processing.confidence)}`,
        "> \u6B64\u5EFA\u8BAE\u4EC5\u4F9B\u53C2\u8003\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u79FB\u52A8\u6216\u5904\u7406\u7B14\u8BB0\u3002",
        ...warnings.length ? ["", "> [!warning] \u6570\u636E\u8D28\u91CF\u63D0\u9192", ...warnings.map((warning) => `> ${String(warning).replace(/[\r\n]+/g, " ")}`)] : [],
        "",
        MANAGED_END
      ].join("\n");
    }
    function removeManagedTemplateSections(template) {
      const headings = ["\u4E00\u53E5\u8BDD\u8BF4\u660E", "\u539F\u59CB\u5185\u5BB9 / \u94FE\u63A5", "\u4E3A\u4EC0\u4E48\u503C\u5F97\u4FDD\u7559", "\u540C\u6B65\u9644\u4EF6"];
      let result = String(template || "");
      for (const heading of headings) {
        const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        result = result.replace(new RegExp(`^##\\s+${escaped}[ \\t]*\\r?\\n[\\s\\S]*?(?=^##\\s+|\\s*$)`, "m"), "");
      }
      return result;
    }
    function upsertFrontmatter(markdown, fields, createFields) {
      const source = String(markdown || "");
      if (!/^---\s*\r?\n/.test(source)) {
        const lines = Object.entries({ ...createFields, ...fields }).map(([key, value]) => `${key}: ${value}`);
        return `---
${lines.join("\n")}
---

${source}`;
      }
      const end = source.indexOf("\n---", 4);
      if (end < 0) return source;
      let header = source.slice(4, end);
      for (const [key, value] of Object.entries(fields)) {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`^${escaped}:.*$`, "m");
        header = pattern.test(header) ? header.replace(pattern, `${key}: ${value}`) : `${header.trimEnd()}
${key}: ${value}`;
      }
      for (const [key, value] of Object.entries(createFields || {})) {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (!new RegExp(`^${escaped}:`, "m").test(header)) header = `${header.trimEnd()}
${key}: ${value}`;
      }
      return `---
${header.trim()}
${source.slice(end)}`;
    }
    function syncMetadata(item, initial) {
      const value = normalizeItem2(item);
      const update = {
        \u66F4\u65B0\u65E5\u671F: formatLocalDate(value.updatedAt),
        \u8FDC\u7A0B\u7248\u672C: yamlString(value.version),
        \u540C\u6B65\u72B6\u6001: "\u5DF2\u540C\u6B65",
        Agent\u5904\u7406\u72B6\u6001: processingLabel(value.processing.status),
        \u77E5\u6D41\u4FEE\u8BA2: String(value.revision)
      };
      const create = initial ? {
        \u8FDC\u7A0BID: yamlString(value.id),
        \u77E5\u6D41\u6D88\u606FID: yamlString(value.id),
        \u521B\u5EFA\u65E5\u671F: formatLocalDate(value.createdAt),
        \u654F\u611F\u7EA7\u522B: sensitivityLabel(value.sensitivity)
      } : {};
      return { update, create };
    }
    function applyCaptureTemplate2(template, item, attachmentLinks = []) {
      const value = normalizeItem2(item);
      const values = {
        date: formatLocalDate(value.createdAt),
        time: formatLocalTime(value.createdAt),
        datetime: `${formatLocalDate(value.createdAt)} ${formatLocalTime(value.createdAt)}`.trim(),
        title: value.title,
        message_id: value.id,
        revision: String(value.revision),
        source: value.source.url || value.source.name
      };
      let result = removeManagedTemplateSections(template).replace(
        /{{\s*(date|time|datetime|title|message_id|revision|source)\s*}}/gi,
        (_match, key) => values[String(key).toLowerCase()] || ""
      );
      result = result.replace(/{{\s*(content|summary|attachments)\s*}}/gi, "");
      if (/^来源:\s*""\s*$/m.test(result)) result = result.replace(/^来源:\s*""\s*$/m, `\u6765\u6E90: ${yamlString(value.source.name)}`);
      const block = buildManagedBlock(item, attachmentLinks);
      const nextHeading = result.match(/^##\s+下一步\s*$/m);
      result = nextHeading ? result.replace(/^##\s+下一步\s*$/m, `${block}

## \u4E0B\u4E00\u6B65`) : `${result.trimEnd()}

${block}

## \u4E0B\u4E00\u6B65

- [ ] \u5220\u9664\uFF1A\u6CA1\u6709\u6301\u7EED\u4EF7\u503C
- [ ] \u8F6C\u4E3A\u77E5\u8BC6\u5361\u7247\u6216\u7814\u7A76\u8BFE\u9898

## \u4E34\u65F6\u5907\u6CE8
`;
      const metadata = syncMetadata(item, true);
      return `${upsertFrontmatter(result, metadata.update, metadata.create).trimEnd()}
`;
    }
    function updateManagedNote2(existing, item, attachmentLinks = []) {
      const start = existing.indexOf(MANAGED_START);
      const end = existing.indexOf(MANAGED_END);
      if (start < 0 || end < start) return { updated: false, conflict: true, content: existing };
      const block = buildManagedBlock(item, attachmentLinks);
      const merged = existing.slice(0, start) + block + existing.slice(end + MANAGED_END.length);
      const metadata = syncMetadata(item, false);
      return { updated: true, conflict: false, content: `${upsertFrontmatter(merged, metadata.update, {}).trimEnd()}
` };
    }
    function extractRemoteId2(markdown) {
      var _a, _b, _c;
      const header = ((_a = String(markdown || "").match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)) == null ? void 0 : _a[1]) || "";
      const value = ((_c = (_b = header.match(/^(?:远程ID|知流消息ID):\s*(.+)$/m)) == null ? void 0 : _b[1]) == null ? void 0 : _c.trim()) || "";
      if (!value) return "";
      try {
        return JSON.parse(value);
      } catch (e) {
        return value.replace(/^['"]|['"]$/g, "");
      }
    }
    module2.exports = {
      MANAGED_START,
      MANAGED_END,
      applyCaptureTemplate: applyCaptureTemplate2,
      buildManagedBlock,
      extractOriginalContent,
      extractRemoteId: extractRemoteId2,
      formatLocalDate,
      normalizeItem: normalizeItem2,
      sanitizeMarkdown: sanitizeMarkdown2,
      summarize,
      updateManagedNote: updateManagedNote2
    };
  }
});

// src/main.js
var { Modal, Notice, Plugin, PluginSettingTab, Setting, requestUrl, normalizePath } = require("obsidian");
var {
  applyCaptureTemplate,
  extractRemoteId,
  normalizeItem,
  sanitizeMarkdown,
  updateManagedNote
} = require_template();
var FALLBACK_TEMPLATE = `---
\u7C7B\u578B: \u6355\u83B7
\u72B6\u6001: \u5F85\u5904\u7406
\u521B\u5EFA\u65E5\u671F: "{{date}}"
\u6765\u6E90: ""
tags:
  - \u72B6\u6001/\u5F85\u5904\u7406
\u654F\u611F\u7EA7\u522B: \u5185\u90E8
---

# {{title}}

## \u4E0B\u4E00\u6B65

- [ ] \u5220\u9664\uFF1A\u6CA1\u6709\u6301\u7EED\u4EF7\u503C
- [ ] \u8F6C\u4E3A\u77E5\u8BC6\u5361\u7247\u6216\u7814\u7A76\u8BFE\u9898

## \u4E34\u65F6\u5907\u6CE8
`;
var DEFAULT_SETTINGS = {
  serverUrl: "http://127.0.0.1:8787",
  token: "",
  inboxFolder: "",
  syncOnStart: true,
  startupDelaySeconds: 3,
  enableInterval: false,
  intervalMinutes: 5,
  pageSize: 50,
  maxPages: 10,
  requestTimeoutSeconds: 15,
  showNotifications: true,
  allowManagedUpdates: true,
  maxSensitivity: "internal",
  downloadAttachments: true,
  useTemplate: true,
  templatePath: "90-\u7CFB\u7EDF/\u6A21\u677F/T-\u5FEB\u901F\u6355\u83B7.md",
  installationId: "",
  records: {},
  resolvedInboxFolder: "",
  lastCursor: "",
  lastSyncAt: "",
  lastSuccessAt: "",
  lastError: "",
  lastSummary: null
};
var SENSITIVITY_RANK = { public: 0, internal: 1, confidential: 2, restricted: 3 };
function safeSegment(value) {
  return String(value || "").replace(/[\\/:*?"<>|#^[\]\x00-\x1f]/g, " ").replace(/\s+/g, " ").replace(/[. ]+$/g, "").trim().slice(0, 120) || "\u672A\u547D\u540D\u6355\u83B7";
}
function cleanFolder(value) {
  const normalized = String(value || "\u6536\u4EF6\u7BB1").replace(/\\/g, "/").split("/").filter((part) => part && part !== "." && part !== "..").map(safeSegment).join("/");
  return normalizePath(normalized || "\u6536\u4EF6\u7BB1");
}
function joinUrl(base, path) {
  return String(base || "").replace(/\/+$/, "") + path;
}
function validatedServerUrl(value) {
  const raw = String(value || "").trim();
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("\u670D\u52A1\u5668\u5730\u5740\u53EA\u652F\u6301 HTTP/HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new Error("\u670D\u52A1\u5668\u5730\u5740\u4E0D\u80FD\u5305\u542B\u8D26\u53F7\u3001\u67E5\u8BE2\u53C2\u6570\u6216\u951A\u70B9");
  const local = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !local) throw new Error("\u975E\u672C\u673A\u670D\u52A1\u5668\u5FC5\u987B\u4F7F\u7528 HTTPS\uFF0C\u4EE5\u514D\u540C\u6B65\u4EE4\u724C\u6CC4\u6F0F");
  return raw.replace(/\/+$/, "");
}
function sanitizeError(error, token) {
  let message = error instanceof Error ? error.message : String(error);
  if (token) message = message.split(token).join("[\u5DF2\u9690\u85CF\u4EE4\u724C]");
  return message.replace(/(?:obsidian_|sk-)[A-Za-z0-9_-]{8,}/g, "[\u5DF2\u9690\u85CF\u51ED\u636E]").replace(/[\r\n\t]+/g, " ").slice(0, 500);
}
function sleep(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
async function sha256Hex(value) {
  const input = value instanceof ArrayBuffer ? value : new TextEncoder().encode(String(value));
  const hash = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function validateItem(raw) {
  if (!raw || typeof raw !== "object") throw new Error("\u540C\u6B65\u6570\u636E\u9879\u4E0D\u662F\u5BF9\u8C61");
  if (typeof raw.contentMarkdown === "string" && raw.contentMarkdown.length > 22e4) throw new Error("\u5355\u6761\u540C\u6B65\u6B63\u6587\u8D85\u8FC7\u5B89\u5168\u9650\u5236");
  if (Array.isArray(raw.attachments) && raw.attachments.length > 50) throw new Error("\u5355\u6761\u540C\u6B65\u9644\u4EF6\u6570\u91CF\u8D85\u8FC7\u5B89\u5168\u9650\u5236");
  const item = normalizeItem(raw);
  if (!item.id || item.id.length > 500) throw new Error("\u540C\u6B65\u6570\u636E\u7F3A\u5C11\u6709\u6548\u8FDC\u7A0B ID");
  if (!item.version || item.version.length > 200) throw new Error("\u540C\u6B65\u6570\u636E\u7F3A\u5C11\u6709\u6548\u7248\u672C");
  if (!item.title || item.title.length > 120) throw new Error("\u540C\u6B65\u6570\u636E\u6807\u9898\u65E0\u6548");
  if (item.contentMarkdown.length > 22e4) throw new Error("\u5355\u6761\u540C\u6B65\u6B63\u6587\u8D85\u8FC7\u5B89\u5168\u9650\u5236");
  if (item.attachments.length > 50) throw new Error("\u5355\u6761\u540C\u6B65\u9644\u4EF6\u6570\u91CF\u8D85\u8FC7\u5B89\u5168\u9650\u5236");
  let attachmentBytes = 0;
  for (const attachment of item.attachments) {
    if (!attachment.id || !attachment.fileName) throw new Error("\u540C\u6B65\u9644\u4EF6\u7F3A\u5C11\u5FC5\u8981\u5B57\u6BB5");
    if (!Number.isFinite(attachment.size) || attachment.size < 0 || attachment.size > 100 * 1024 * 1024) throw new Error("\u540C\u6B65\u9644\u4EF6\u5927\u5C0F\u65E0\u6548");
    if (attachment.sha256 && !/^[a-f0-9]{64}$/.test(attachment.sha256)) throw new Error("\u540C\u6B65\u9644\u4EF6\u6821\u9A8C\u548C\u65E0\u6548");
    attachmentBytes += attachment.size;
  }
  if (attachmentBytes > 300 * 1024 * 1024) throw new Error("\u5355\u6761\u540C\u6B65\u9644\u4EF6\u603B\u4F53\u79EF\u8D85\u8FC7\u5B89\u5168\u9650\u5236");
  if (item.source.url) {
    const url = new URL(item.source.url);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("\u6765\u6E90\u94FE\u63A5\u534F\u8BAE\u4E0D\u53D7\u652F\u6301");
  }
  return item;
}
function validateBatch(response) {
  if (!response || typeof response !== "object") throw new Error("\u670D\u52A1\u7AEF\u8FD4\u56DE\u4E0D\u662F JSON \u5BF9\u8C61");
  if (response.schemaVersion && !["1.0", "1.1"].includes(response.schemaVersion)) throw new Error("\u540C\u6B65\u534F\u8BAE\u7248\u672C\u4E0D\u53D7\u652F\u6301");
  if (!Array.isArray(response.items) || response.items.length > 100) throw new Error("\u540C\u6B65\u5206\u9875\u6570\u636E\u65E0\u6548");
  return {
    ...response,
    batchId: typeof response.batchId === "string" ? response.batchId : "",
    items: response.items.map(validateItem),
    hasMore: response.hasMore === true
  };
}
var TextModal = class extends Modal {
  constructor(app, title, lines) {
    super(app);
    this.title = title;
    this.lines = lines;
  }
  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.title });
    for (const line of this.lines) this.contentEl.createEl("p", { text: line });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("\u5173\u95ED").setCta().onClick(() => this.close()));
  }
};
var ResetCursorModal = class extends Modal {
  constructor(app, confirm) {
    super(app);
    this.confirmReset = confirm;
  }
  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "\u91CD\u7F6E\u540C\u6B65\u6E38\u6807" });
    this.contentEl.createEl("p", { text: "\u670D\u52A1\u7AEF\u4F1A\u91CD\u65B0\u53D1\u9001\u5386\u53F2\u8BB0\u5F55\u3002\u672C\u5730\u8FDC\u7A0B ID \u7D22\u5F15\u4ECD\u4F1A\u963B\u6B62\u91CD\u590D\u521B\u5EFA\u3002" });
    this.contentEl.createEl("p", { text: "\u8FD9\u662F\u7B2C\u4E00\u6B21\u786E\u8BA4\uFF1B\u70B9\u51FB\u540E\u8FD8\u4F1A\u8981\u6C42\u518D\u6B21\u786E\u8BA4\u3002" });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("\u53D6\u6D88").onClick(() => this.close())).addButton((button) => button.setButtonText("\u7EE7\u7EED\u91CD\u7F6E").setWarning().onClick(async () => {
      this.close();
      if (!window.confirm("\u518D\u6B21\u786E\u8BA4\uFF1A\u786E\u5B9A\u4ECE\u5934\u91CD\u653E\u670D\u52A1\u7AEF\u540C\u6B65\u8BB0\u5F55\u5417\uFF1F")) return;
      await this.confirmReset();
    }));
  }
};
var KnowledgeRelaySyncPlugin = class extends Plugin {
  async onload() {
    const stored = await this.loadData() || {};
    const migratedRecords = Object.fromEntries(
      Object.entries(stored.messageFiles || {}).map(([id, filePath]) => [id, {
        version: "legacy",
        filePath,
        localReference: crypto.randomUUID(),
        dismissed: false,
        processed: false,
        restricted: false,
        conflict: false,
        lastSeenAt: stored.lastSyncAt || ""
      }])
    );
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored, {
      installationId: stored.installationId || crypto.randomUUID(),
      records: Object.assign({}, migratedRecords, stored.records || {})
    });
    delete this.settings.messageFiles;
    this.syncing = false;
    this.startedOnce = false;
    this.remotePathCache = null;
    this.remoteIndexComplete = false;
    this.status = this.addStatusBarItem();
    this.status.addClass("wechat-inbox-sync-status");
    this.updateStatus();
    this.registerCommands();
    this.addRibbonIcon("refresh-cw", "\u540C\u6B65\u77E5\u6D41\u6536\u4EF6\u53F0", () => this.syncNow(true));
    this.addSettingTab(new KnowledgeRelaySettingTab(this.app, this));
    this.registerVaultTracking();
    this.restartTimer();
    if (this.settings.syncOnStart && this.settings.token) {
      this.app.workspace.onLayoutReady(() => {
        if (this.startedOnce) return;
        this.startedOnce = true;
        const delay = Math.max(0, Math.min(30, Number(this.settings.startupDelaySeconds) || 3)) * 1e3;
        this.startTimer = window.setTimeout(() => this.syncNow(false), delay);
      });
    }
    this.register(() => {
      if (this.startTimer) window.clearTimeout(this.startTimer);
      if (this.timer) window.clearInterval(this.timer);
    });
    await this.saveData(this.settings);
  }
  registerCommands() {
    this.addCommand({ id: "sync-now", name: "\u7ACB\u5373\u540C\u6B65", callback: () => this.syncNow(true) });
    this.addCommand({ id: "show-sync-status", name: "\u67E5\u770B\u4E0A\u6B21\u540C\u6B65\u72B6\u6001", callback: () => this.showStatus() });
    this.addCommand({ id: "rescan-sync-records", name: "\u91CD\u65B0\u626B\u63CF\u672C\u5730\u540C\u6B65\u8BB0\u5F55", callback: () => this.rescanRecords(true) });
    this.addCommand({ id: "reset-sync-cursor", name: "\u91CD\u7F6E\u540C\u6B65\u6E38\u6807", callback: () => new ResetCursorModal(this.app, () => this.resetCursor()).open() });
    this.addCommand({ id: "open-inbox", name: "\u6253\u5F00\u6536\u4EF6\u7BB1", callback: () => this.openInbox() });
    this.addCommand({ id: "show-last-error", name: "\u67E5\u770B\u6700\u8FD1\u4E00\u6B21\u9519\u8BEF", callback: () => this.showLastError() });
  }
  registerVaultTracking() {
    this.registerEvent(this.app.vault.on("rename", async (file, oldPath) => {
      for (const [remoteId, record] of Object.entries(this.settings.records)) {
        if (record.filePath !== oldPath) continue;
        record.filePath = file.path;
        const inbox = this.effectiveInboxFolder() + "/";
        record.processed = !file.path.startsWith(inbox);
        record.lastSeenAt = (/* @__PURE__ */ new Date()).toISOString();
        if (this.remotePathCache) this.remotePathCache.set(remoteId, file.path);
        await this.saveData(this.settings);
        break;
      }
    }));
    this.registerEvent(this.app.vault.on("delete", async (file) => {
      for (const record of Object.values(this.settings.records)) {
        if (record.filePath !== file.path) continue;
        record.filePath = "";
        record.dismissed = true;
        record.lastSeenAt = (/* @__PURE__ */ new Date()).toISOString();
        if (this.remotePathCache) {
          for (const [remoteId, filePath] of this.remotePathCache.entries()) {
            if (filePath === file.path) this.remotePathCache.delete(remoteId);
          }
        }
        await this.saveData(this.settings);
        break;
      }
    }));
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.restartTimer();
    this.updateStatus();
  }
  restartTimer() {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
    if (!this.settings.enableInterval) return;
    const minutes = Math.max(5, Number(this.settings.intervalMinutes) || 5);
    this.timer = window.setInterval(() => {
      if (!document.hidden && !this.syncing) this.syncNow(false);
    }, minutes * 60 * 1e3);
  }
  updateStatus(text) {
    if (text) this.status.setText(text);
    else if (this.settings.lastError) this.status.setText("\u77E5\u6D41\uFF1A\u540C\u6B65\u5F02\u5E38");
    else if (this.settings.lastSuccessAt) this.status.setText("\u77E5\u6D41\uFF1A" + new Date(this.settings.lastSuccessAt).toLocaleTimeString());
    else this.status.setText("\u77E5\u6D41\uFF1A\u5F85\u540C\u6B65");
  }
  notify(message, duration = 5e3) {
    if (this.settings.showNotifications) new Notice(message, duration);
  }
  async ensureFolder(folder) {
    const normalized = cleanFolder(folder);
    let current = "";
    for (const segment of normalized.split("/")) {
      current = current ? current + "/" + segment : segment;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
    return normalized;
  }
  async writeText(path, content) {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing && typeof existing.extension === "string") await this.app.vault.modify(existing, content);
    else await this.app.vault.create(path, content);
  }
  async writeBinary(path, content) {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing && typeof existing.extension === "string") await this.app.vault.modifyBinary(existing, content);
    else await this.app.vault.createBinary(path, content);
  }
  async request(path, options = {}) {
    if (!this.settings.serverUrl || !this.settings.token) throw new Error("\u8BF7\u5148\u586B\u5199\u670D\u52A1\u5668\u5730\u5740\u548C\u540C\u6B65\u4EE4\u724C");
    const timeout = Math.max(5, Math.min(60, Number(this.settings.requestTimeoutSeconds) || 15)) * 1e3;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        let timeoutId;
        const response = await Promise.race([
          requestUrl({
            url: joinUrl(validatedServerUrl(this.settings.serverUrl), path),
            method: options.method || "GET",
            headers: Object.assign(
              { Authorization: "Bearer " + this.settings.token, Accept: "application/json" },
              options.body ? { "Content-Type": "application/json" } : {}
            ),
            body: options.body ? JSON.stringify(options.body) : void 0,
            throw: false
          }),
          new Promise((_, reject) => {
            timeoutId = window.setTimeout(() => reject(new Error("\u8BF7\u6C42\u8D85\u65F6")), timeout);
          })
        ]).finally(() => timeoutId && window.clearTimeout(timeoutId));
        if (response.status === 401 || response.status === 403) {
          const error2 = new Error("\u540C\u6B65\u6388\u6743\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u521B\u5EFA\u4EE4\u724C");
          error2.status = response.status;
          throw error2;
        }
        if (response.status < 400) return response;
        const serverMessage = response.json && typeof response.json.error === "string" ? response.json.error : "";
        const error = new Error(serverMessage || `\u670D\u52A1\u5668\u8FD4\u56DE HTTP ${response.status}`);
        error.status = response.status;
        const retryAfter = Number(response.headers && (response.headers["retry-after"] || response.headers["Retry-After"])) || 0;
        error.retryAfter = Math.min(retryAfter * 1e3, 3e4);
        throw error;
      } catch (error) {
        lastError = error;
        const status = Number(error && error.status || 0);
        if ([401, 403].includes(status) || attempt === 2 || status >= 400 && status < 500 && status !== 429) break;
        await sleep(error.retryAfter || 500 * Math.pow(2, attempt));
      }
    }
    throw new Error(sanitizeError(lastError, this.settings.token));
  }
  async loadCaptureTemplate() {
    if (!this.settings.useTemplate) return { content: FALLBACK_TEMPLATE, warning: "" };
    const templatePath = normalizePath(String(this.settings.templatePath || "").trim());
    if (!templatePath) return { content: FALLBACK_TEMPLATE, warning: "\u5C1A\u672A\u914D\u7F6E\u6A21\u677F\u8DEF\u5F84\uFF0C\u5DF2\u4F7F\u7528\u77E5\u6D41\u5B89\u5168\u6A21\u677F\u3002" };
    const file = this.app.vault.getAbstractFileByPath(templatePath);
    if (!file || typeof file.extension !== "string" || file.extension.toLowerCase() !== "md") {
      return { content: FALLBACK_TEMPLATE, warning: `\u6CA1\u6709\u627E\u5230\u6A21\u677F\uFF1A${templatePath}\uFF0C\u5DF2\u4F7F\u7528\u77E5\u6D41\u5B89\u5168\u6A21\u677F\u3002` };
    }
    try {
      return { content: await this.app.vault.cachedRead(file), warning: "" };
    } catch (error) {
      return { content: FALLBACK_TEMPLATE, warning: `\u8BFB\u53D6\u6A21\u677F\u5931\u8D25\uFF1A${sanitizeError(error, this.settings.token)}\uFF0C\u5DF2\u4F7F\u7528\u77E5\u6D41\u5B89\u5168\u6A21\u677F\u3002` };
    }
  }
  async findRemoteId(remoteId) {
    if (this.remotePathCache && this.remotePathCache.has(remoteId)) return this.remotePathCache.get(remoteId) || "";
    if (!this.remoteIndexComplete) await this.buildRemoteIndex();
    return this.remotePathCache && this.remotePathCache.get(remoteId) || "";
  }
  prepareRemoteIndex() {
    this.remotePathCache = new Map(
      Object.entries(this.settings.records).filter(([, record]) => {
        if (typeof record.filePath !== "string" || !record.filePath) return false;
        const file = this.app.vault.getAbstractFileByPath(record.filePath);
        return Boolean(file && typeof file.extension === "string");
      }).map(([remoteId, record]) => [remoteId, record.filePath])
    );
    this.remoteIndexComplete = false;
  }
  effectiveInboxFolder() {
    return cleanFolder(this.settings.inboxFolder || this.settings.resolvedInboxFolder || "\u6536\u4EF6\u7BB1");
  }
  async buildRemoteIndex() {
    const index = this.remotePathCache || /* @__PURE__ */ new Map();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const content = await this.app.vault.cachedRead(file);
      const remoteId = extractRemoteId(content);
      if (remoteId) index.set(remoteId, file.path);
    }
    this.remotePathCache = index;
    this.remoteIndexComplete = true;
    return index;
  }
  async rescanRecords(showNotice) {
    this.remotePathCache = /* @__PURE__ */ new Map();
    this.remoteIndexComplete = false;
    const index = await this.buildRemoteIndex();
    let found = 0;
    for (const [remoteId, filePath] of index.entries()) {
      const record = this.settings.records[remoteId] || {
        version: "unknown",
        localReference: crypto.randomUUID(),
        dismissed: false,
        restricted: false
      };
      record.filePath = filePath;
      record.processed = !filePath.startsWith(this.effectiveInboxFolder() + "/");
      record.conflict = false;
      record.lastSeenAt = (/* @__PURE__ */ new Date()).toISOString();
      this.settings.records[remoteId] = record;
      found += 1;
    }
    await this.saveData(this.settings);
    if (showNotice) this.notify(`\u5DF2\u91CD\u65B0\u7D22\u5F15 ${found} \u6761\u77E5\u6D41\u7B14\u8BB0`);
    return found;
  }
  isSensitivityAllowed(value) {
    var _a, _b;
    if (value === "restricted") return false;
    return ((_a = SENSITIVITY_RANK[value]) != null ? _a : 1) <= ((_b = SENSITIVITY_RANK[this.settings.maxSensitivity]) != null ? _b : 1);
  }
  async downloadItemAttachments(item, folder) {
    if (!this.settings.downloadAttachments || !Array.isArray(item.attachments) || !item.attachments.length) return [];
    const attachmentsFolder = await this.ensureFolder(folder + "/\u9644\u4EF6");
    const links = [];
    for (const attachment of item.attachments) {
      if (!attachment || typeof attachment.id !== "string" || typeof attachment.fileName !== "string") continue;
      let storedName = safeSegment(attachment.id.slice(0, 8) + "-" + attachment.fileName);
      if (attachment.mimeType === "text/markdown" && !/\.md$/i.test(storedName)) storedName += ".md";
      else if (attachment.mimeType === "text/plain" && !/\.txt$/i.test(storedName)) storedName += ".txt";
      else if (/\.(?:html?|svg|js|css)$/i.test(storedName)) storedName += ".bin";
      const attachmentPath = normalizePath(attachmentsFolder + "/" + storedName);
      const fileResponse = await this.request("/api/sync/attachments/" + encodeURIComponent(attachment.id));
      const actualHash = await sha256Hex(fileResponse.arrayBuffer);
      if (attachment.sha256 && actualHash !== attachment.sha256) throw new Error("\u9644\u4EF6\u5B8C\u6574\u6027\u6821\u9A8C\u5931\u8D25");
      if (attachment.size && fileResponse.arrayBuffer.byteLength !== attachment.size) throw new Error("\u9644\u4EF6\u957F\u5EA6\u4E0E\u670D\u52A1\u7AEF\u8BB0\u5F55\u4E0D\u4E00\u81F4");
      if (attachment.mimeType === "text/markdown") {
        await this.writeText(attachmentPath, sanitizeMarkdown(new TextDecoder("utf-8").decode(fileResponse.arrayBuffer), 2 * 1024 * 1024));
      } else if (attachment.mimeType === "text/plain") {
        await this.writeText(attachmentPath, new TextDecoder("utf-8").decode(fileResponse.arrayBuffer).slice(0, 2 * 1024 * 1024));
      } else {
        await this.writeBinary(attachmentPath, fileResponse.arrayBuffer);
      }
      links.push("- [[" + attachmentPath + "|" + attachment.fileName.replace(/\|/g, " ") + "]]");
    }
    return links;
  }
  async newNotePath(item, folder) {
    const date = new Date(item.createdAt || Date.now());
    const datePart = Number.isNaN(date.getTime()) ? "\u672A\u77E5\u65E5\u671F 0000" : [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-") + " " + String(date.getHours()).padStart(2, "0") + String(date.getMinutes()).padStart(2, "0");
    const base = safeSegment(datePart + " - " + item.title);
    let path = normalizePath(folder + "/" + base + ".md");
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing && typeof existing.extension === "string") {
      const content = await this.app.vault.cachedRead(existing);
      if (extractRemoteId(content) !== item.id) path = normalizePath(folder + "/" + base + "-" + (await sha256Hex(item.id)).slice(0, 8) + ".md");
    }
    return path;
  }
  async processItem(item, folder, template) {
    const record = this.settings.records[item.id];
    if (item.deleted) {
      this.settings.records[item.id] = Object.assign({}, record, {
        version: item.version,
        localReference: record && record.localReference || crypto.randomUUID(),
        dismissed: true,
        lastSeenAt: (/* @__PURE__ */ new Date()).toISOString()
      });
      await this.saveData(this.settings);
      return { id: item.id, version: item.version, result: "dismissed", localReference: this.settings.records[item.id].localReference };
    }
    if (record && record.dismissed) return { id: item.id, version: item.version, result: "dismissed", localReference: record.localReference };
    if (record && record.processed) return { id: item.id, version: item.version, result: "skipped_processed", localReference: record.localReference };
    if (!this.isSensitivityAllowed(item.sensitivity)) {
      this.settings.records[item.id] = Object.assign({}, record, {
        version: item.version,
        localReference: record && record.localReference || crypto.randomUUID(),
        restricted: true,
        dismissed: false,
        processed: false,
        conflict: false,
        lastSeenAt: (/* @__PURE__ */ new Date()).toISOString()
      });
      await this.saveData(this.settings);
      return { id: item.id, version: item.version, result: "skipped_restricted", localReference: this.settings.records[item.id].localReference };
    }
    const wasRestricted = Boolean(record && record.restricted);
    let notePath = record && record.filePath || "";
    let file = notePath ? this.app.vault.getAbstractFileByPath(notePath) : null;
    if (record && !file && !wasRestricted) {
      notePath = await this.findRemoteId(item.id);
      file = notePath ? this.app.vault.getAbstractFileByPath(notePath) : null;
      if (!file) {
        record.conflict = true;
        record.lastSeenAt = (/* @__PURE__ */ new Date()).toISOString();
        await this.saveData(this.settings);
        return { id: item.id, version: item.version, result: "invalid", localReference: record.localReference };
      }
    }
    if (!record && !file) {
      notePath = await this.findRemoteId(item.id);
      file = notePath ? this.app.vault.getAbstractFileByPath(notePath) : null;
    }
    const localReference = record && record.localReference || crypto.randomUUID();
    if (record && record.version === item.version && file) {
      record.lastSeenAt = (/* @__PURE__ */ new Date()).toISOString();
      await this.saveData(this.settings);
      return { id: item.id, version: item.version, result: "unchanged", localReference };
    }
    const attachmentLinks = await this.downloadItemAttachments(item, folder);
    let content;
    let result;
    if (file && typeof file.extension === "string") {
      if (!this.settings.allowManagedUpdates) {
        const tracked = record || {
          version: "unknown",
          filePath: file.path,
          localReference,
          dismissed: false,
          processed: false,
          restricted: false,
          conflict: false
        };
        tracked.pendingVersion = item.version;
        tracked.lastSeenAt = (/* @__PURE__ */ new Date()).toISOString();
        this.settings.records[item.id] = tracked;
        await this.saveData(this.settings);
        return { id: item.id, version: item.version, result: "unchanged", localReference };
      }
      const existing = await this.app.vault.cachedRead(file);
      const update = updateManagedNote(existing, item, attachmentLinks);
      if (update.conflict) {
        this.settings.records[item.id] = Object.assign({}, record, { filePath: file.path, localReference, conflict: true, lastSeenAt: (/* @__PURE__ */ new Date()).toISOString() });
        await this.saveData(this.settings);
        return { id: item.id, version: item.version, result: "invalid", localReference };
      }
      content = update.content;
      notePath = file.path;
      result = "updated";
    } else {
      notePath = await this.newNotePath(item, folder);
      content = applyCaptureTemplate(template, item, attachmentLinks);
      result = "created";
    }
    await this.writeText(notePath, content);
    if (this.remotePathCache) this.remotePathCache.set(item.id, notePath);
    this.settings.records[item.id] = {
      version: item.version,
      revision: item.revision,
      filePath: notePath,
      contentHash: await sha256Hex(content),
      localReference,
      dismissed: false,
      processed: false,
      restricted: false,
      conflict: false,
      lastSeenAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    await this.saveData(this.settings);
    return { id: item.id, version: item.version, result, localReference };
  }
  async syncNow(showNotice) {
    if (this.syncing) {
      if (showNotice) this.notify("\u77E5\u6D41\u6536\u4EF6\u53F0\u6B63\u5728\u540C\u6B65");
      return;
    }
    if (!this.settings.token) {
      if (showNotice) this.notify("\u8BF7\u5148\u5728\u63D2\u4EF6\u8BBE\u7F6E\u4E2D\u586B\u5199\u540C\u6B65\u4EE4\u724C");
      return;
    }
    this.syncing = true;
    this.settings.lastSyncAt = (/* @__PURE__ */ new Date()).toISOString();
    this.updateStatus("\u77E5\u6D41\uFF1A\u540C\u6B65\u4E2D\u2026");
    const summary = { created: 0, updated: 0, unchanged: 0, skipped: 0, conflicts: 0, pages: 0 };
    try {
      const template = await this.loadCaptureTemplate();
      this.prepareRemoteIndex();
      if (showNotice && template.warning) this.notify(template.warning, 8e3);
      const maximumPages = Math.max(1, Math.min(50, Number(this.settings.maxPages) || 10));
      const limit = Math.max(1, Math.min(100, Number(this.settings.pageSize) || 50));
      for (let page = 0; page < maximumPages; page += 1) {
        const response = await this.request("/api/sync/pull?limit=" + limit);
        if (String(response.text || "").length > 2 * 1024 * 1024) throw new Error("\u5355\u9875\u540C\u6B65\u54CD\u5E94\u8D85\u8FC7 2 MB \u5B89\u5168\u9650\u5236");
        const batch = validateBatch(response.json);
        const folder = await this.ensureFolder(this.settings.inboxFolder || batch.folder || "\u6536\u4EF6\u7BB1");
        this.settings.resolvedInboxFolder = folder;
        const results = [];
        for (const item of batch.items) {
          const result = await this.processItem(item, folder, template.content);
          results.push(result);
          if (result.result === "created") summary.created += 1;
          else if (result.result === "updated") summary.updated += 1;
          else if (result.result === "unchanged") summary.unchanged += 1;
          else if (result.result === "invalid") summary.conflicts += 1;
          else summary.skipped += 1;
        }
        summary.pages += 1;
        if (!batch.batchId && !batch.items.length) break;
        const ack = await this.request("/api/sync/ack", {
          method: "POST",
          body: {
            schemaVersion: "1.1",
            syncId: batch.syncId || batch.batchId,
            batchId: batch.batchId,
            results
          }
        });
        if (!ack.json || ack.json.ok !== true) throw new Error("\u670D\u52A1\u7AEF\u672A\u786E\u8BA4\u540C\u6B65\u56DE\u6267");
        this.settings.lastCursor = String(ack.json.cursor == null ? "" : ack.json.cursor);
        await this.saveData(this.settings);
        if (!batch.hasMore || !batch.items.length) break;
      }
      this.settings.lastSuccessAt = (/* @__PURE__ */ new Date()).toISOString();
      this.settings.lastError = "";
      this.settings.lastSummary = summary;
      await this.saveData(this.settings);
      this.updateStatus();
      if (showNotice) {
        const changed = summary.created + summary.updated;
        this.notify(changed ? `\u77E5\u6D41\u540C\u6B65\u5B8C\u6210\uFF1A\u65B0\u589E ${summary.created}\uFF0C\u66F4\u65B0 ${summary.updated}` : "\u77E5\u6D41\u6536\u4EF6\u53F0\u5DF2\u7ECF\u662F\u6700\u65B0\u72B6\u6001");
        if (summary.conflicts) this.notify(`${summary.conflicts} \u6761\u5185\u5BB9\u9700\u8981\u91CD\u65B0\u626B\u63CF\u672C\u5730\u8BB0\u5F55\u540E\u5904\u7406`, 8e3);
      }
    } catch (error) {
      this.settings.lastError = sanitizeError(error, this.settings.token);
      await this.saveData(this.settings);
      this.updateStatus();
      this.notify("\u77E5\u6D41\u540C\u6B65\u5931\u8D25\uFF1A" + this.settings.lastError, 8e3);
    } finally {
      this.syncing = false;
      this.remotePathCache = null;
      this.remoteIndexComplete = false;
    }
  }
  showStatus() {
    const summary = this.settings.lastSummary || {};
    new TextModal(this.app, "\u77E5\u6D41\u540C\u6B65\u72B6\u6001", [
      this.settings.lastSuccessAt ? "\u4E0A\u6B21\u6210\u529F\uFF1A" + new Date(this.settings.lastSuccessAt).toLocaleString() : "\u5C1A\u672A\u6210\u529F\u540C\u6B65",
      `\u65B0\u589E ${summary.created || 0} \xB7 \u66F4\u65B0 ${summary.updated || 0} \xB7 \u672A\u53D8\u5316 ${summary.unchanged || 0}`,
      `\u8DF3\u8FC7 ${summary.skipped || 0} \xB7 \u51B2\u7A81 ${summary.conflicts || 0}`,
      `\u672C\u5730\u7D22\u5F15 ${Object.keys(this.settings.records).length} \u6761`
    ]).open();
  }
  showLastError() {
    new TextModal(this.app, "\u6700\u8FD1\u4E00\u6B21\u540C\u6B65\u9519\u8BEF", [this.settings.lastError || "\u6682\u65E0\u540C\u6B65\u9519\u8BEF"]).open();
  }
  async resetCursor() {
    try {
      await this.request("/api/sync/reset", { method: "POST", body: { schemaVersion: "1.1" } });
      this.settings.lastCursor = "";
      await this.saveData(this.settings);
      this.notify("\u670D\u52A1\u7AEF\u6E38\u6807\u5DF2\u91CD\u7F6E\uFF1B\u672C\u5730\u8FDC\u7A0B ID \u7D22\u5F15\u4F1A\u9632\u6B62\u91CD\u590D\u7B14\u8BB0", 7e3);
    } catch (error) {
      this.notify("\u91CD\u7F6E\u5931\u8D25\uFF1A" + sanitizeError(error, this.settings.token), 8e3);
    }
  }
  async openInbox() {
    const folder = this.effectiveInboxFolder();
    const explanation = this.app.vault.getAbstractFileByPath(folder + "/\u6536\u4EF6\u7BB1\u8BF4\u660E.md");
    if (explanation && typeof explanation.extension === "string") return this.app.workspace.getLeaf(false).openFile(explanation);
    const file = this.app.vault.getMarkdownFiles().find((item) => item.path.startsWith(folder + "/"));
    if (file) return this.app.workspace.getLeaf(false).openFile(file);
    this.notify(`\u6536\u4EF6\u7BB1 ${folder} \u4E2D\u8FD8\u6CA1\u6709\u7B14\u8BB0`);
  }
};
var KnowledgeRelaySettingTab = class extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "\u77E5\u6D41\u540C\u6B65" });
    containerEl.createEl("p", { text: "\u540C\u6B65\u4EE4\u724C\u5DF2\u7ECF\u7ED1\u5B9A\u552F\u4E00 Obsidian \u8FDE\u63A5\uFF0C\u56E0\u6B64\u65E0\u9700\u518D\u586B\u5199 collectionId\u3002" });
    new Setting(containerEl).setName("\u670D\u52A1\u5668\u5730\u5740").setDesc("\u975E\u672C\u673A\u5730\u5740\u5FC5\u987B\u4F7F\u7528 HTTPS").addText(
      (text) => text.setPlaceholder("https://inbox.example.com").setValue(this.plugin.settings.serverUrl).onChange(async (value) => {
        this.plugin.settings.serverUrl = value.trim();
        await this.plugin.saveSettings();
      })
    );
    const tokenSetting = new Setting(containerEl).setName("\u540C\u6B65\u4EE4\u724C").setDesc("\u5F53\u524D\u517C\u5BB9\u7248\u672C\u4F1A\u52A0\u5BC6\u4F20\u8F93\u5E76\u4FDD\u5B58\u5728\u63D2\u4EF6 data.json\uFF1B\u4E0D\u4F1A\u5199\u5165\u7B14\u8BB0\u3001\u65E5\u5FD7\u6216\u56DE\u6267\u3002\u8BF7\u4FDD\u62A4 Vault \u914D\u7F6E\u76EE\u5F55\u3002");
    tokenSetting.settingEl.addClass("wechat-inbox-sync-token");
    tokenSetting.addTextArea((text) => text.setPlaceholder("obsidian_...").setValue(this.plugin.settings.token).onChange(async (value) => {
      this.plugin.settings.token = value.trim();
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("\u8986\u76D6\u6536\u4EF6\u7BB1\u76EE\u5F55").setDesc("\u7559\u7A7A\u65F6\u4F7F\u7528\u670D\u52A1\u7AEF\u4E3A\u8BE5\u8FDE\u63A5\u8BBE\u7F6E\u7684\u76EE\u5F55").addText(
      (text) => text.setPlaceholder("\u6536\u4EF6\u7BB1").setValue(this.plugin.settings.inboxFolder).onChange(async (value) => {
        this.plugin.settings.inboxFolder = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("\u4F18\u5148\u4F7F\u7528\u5FEB\u901F\u6355\u83B7\u6A21\u677F").setDesc("\u65B0\u7B14\u8BB0\u6309\u6A21\u677F\u521B\u5EFA\uFF1B\u8FDC\u7A0B\u4FEE\u8BA2\u53EA\u66F4\u65B0\u6258\u7BA1\u533A\u5757").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.useTemplate).onChange(async (value) => {
        this.plugin.settings.useTemplate = value;
        await this.plugin.saveSettings();
        this.display();
      })
    );
    if (this.plugin.settings.useTemplate) {
      new Setting(containerEl).setName("\u6A21\u677F\u8DEF\u5F84").setDesc("\u76F8\u5BF9\u4E8E Vault \u6839\u76EE\u5F55").addText(
        (text) => text.setPlaceholder("90-\u7CFB\u7EDF/\u6A21\u677F/T-\u5FEB\u901F\u6355\u83B7.md").setValue(this.plugin.settings.templatePath).onChange(async (value) => {
          this.plugin.settings.templatePath = value.trim();
          await this.plugin.saveSettings();
        })
      ).addButton((button) => button.setButtonText("\u68C0\u67E5\u6A21\u677F").onClick(async () => {
        const result = await this.plugin.loadCaptureTemplate();
        this.plugin.notify(result.warning || "\u6A21\u677F\u8BFB\u53D6\u6210\u529F\uFF0C\u540C\u6B65\u65F6\u4F1A\u4FDD\u7559\u7528\u6237\u7F16\u8F91\u533A\u3002", 6e3);
      }));
    }
    new Setting(containerEl).setName("\u5141\u8BB8\u66F4\u65B0\u6258\u7BA1\u533A\u5757").setDesc("\u53EA\u66F4\u65B0\u6807\u8BB0\u533A\u5757\u548C\u540C\u6B65\u72B6\u6001\uFF0C\u4E0D\u8986\u76D6\u4E0B\u4E00\u6B65\u3001\u4E34\u65F6\u5907\u6CE8\u6216\u81EA\u5B9A\u4E49\u5C5E\u6027").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.allowManagedUpdates).onChange(async (value) => {
        this.plugin.settings.allowManagedUpdates = value;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("\u542F\u52A8\u65F6\u540C\u6B65").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.syncOnStart).onChange(async (value) => {
        this.plugin.settings.syncOnStart = value;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("\u542F\u52A8\u5EF6\u8FDF\uFF08\u79D2\uFF09").setDesc("\u9ED8\u8BA4 3 \u79D2\uFF0C\u4E0D\u963B\u585E Obsidian \u542F\u52A8").addText(
      (text) => text.setValue(String(this.plugin.settings.startupDelaySeconds)).onChange(async (value) => {
        this.plugin.settings.startupDelaySeconds = Math.max(0, Math.min(30, Number(value) || 3));
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("\u5B9A\u65F6\u540C\u6B65").setDesc("\u9ED8\u8BA4\u5173\u95ED\uFF1B\u5F00\u542F\u540E\u6700\u77ED\u6BCF 5 \u5206\u949F").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.enableInterval).onChange(async (value) => {
        this.plugin.settings.enableInterval = value;
        await this.plugin.saveSettings();
        this.display();
      })
    );
    if (this.plugin.settings.enableInterval) {
      new Setting(containerEl).setName("\u5B9A\u65F6\u540C\u6B65\u95F4\u9694\uFF08\u5206\u949F\uFF09").addText(
        (text) => text.setValue(String(this.plugin.settings.intervalMinutes)).onChange(async (value) => {
          this.plugin.settings.intervalMinutes = Math.max(5, Number(value) || 5);
          await this.plugin.saveSettings();
        })
      );
    }
    new Setting(containerEl).setName("\u5355\u9875\u6570\u91CF").setDesc("1\u2013100\uFF0C\u9ED8\u8BA4 50").addText(
      (text) => text.setValue(String(this.plugin.settings.pageSize)).onChange(async (value) => {
        this.plugin.settings.pageSize = Math.max(1, Math.min(100, Number(value) || 50));
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("\u5355\u6B21\u6700\u5927\u9875\u6570").setDesc("\u9ED8\u8BA4 10").addText(
      (text) => text.setValue(String(this.plugin.settings.maxPages)).onChange(async (value) => {
        this.plugin.settings.maxPages = Math.max(1, Math.min(50, Number(value) || 10));
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("\u8BF7\u6C42\u8D85\u65F6\uFF08\u79D2\uFF09").setDesc("5\u201360\uFF0C\u9ED8\u8BA4 15").addText(
      (text) => text.setValue(String(this.plugin.settings.requestTimeoutSeconds)).onChange(async (value) => {
        this.plugin.settings.requestTimeoutSeconds = Math.max(5, Math.min(60, Number(value) || 15));
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("\u5141\u8BB8\u540C\u6B65\u7684\u6700\u9AD8\u654F\u611F\u7EA7\u522B").setDesc("\u4E25\u683C\u53D7\u9650\u5185\u5BB9\u59CB\u7EC8\u4E0D\u4F1A\u5199\u5165\u666E\u901A Vault").addDropdown(
      (dropdown) => dropdown.addOption("public", "\u516C\u5F00").addOption("internal", "\u5185\u90E8").addOption("confidential", "\u673A\u5BC6").setValue(this.plugin.settings.maxSensitivity).onChange(async (value) => {
        this.plugin.settings.maxSensitivity = value;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("\u4E0B\u8F7D\u9644\u4EF6").setDesc("\u4E0B\u8F7D\u524D\u6821\u9A8C SHA-256\uFF0C\u6D3E\u751F Markdown \u4E5F\u4F5C\u4E3A\u9644\u4EF6\u4FDD\u5B58").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.downloadAttachments).onChange(async (value) => {
        this.plugin.settings.downloadAttachments = value;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("\u663E\u793A\u540C\u6B65\u901A\u77E5").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.showNotifications).onChange(async (value) => {
        this.plugin.settings.showNotifications = value;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("\u540C\u6B65\u64CD\u4F5C").setDesc(this.plugin.settings.lastError ? "\u4E0A\u6B21\u9519\u8BEF\uFF1A" + this.plugin.settings.lastError : this.plugin.settings.lastSuccessAt ? "\u4E0A\u6B21\u6210\u529F\uFF1A" + new Date(this.plugin.settings.lastSuccessAt).toLocaleString() : "\u5C1A\u672A\u540C\u6B65").addButton((button) => button.setButtonText("\u67E5\u770B\u72B6\u6001").onClick(() => this.plugin.showStatus())).addButton((button) => button.setButtonText("\u7ACB\u5373\u540C\u6B65").setCta().onClick(() => this.plugin.syncNow(true)));
  }
};
module.exports = KnowledgeRelaySyncPlugin;
