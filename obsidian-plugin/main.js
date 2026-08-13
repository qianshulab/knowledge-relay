const { Modal, Notice, Plugin, PluginSettingTab, Setting, requestUrl, normalizePath } = require("obsidian");
const {
  applyCaptureTemplate,
  extractRemoteId,
  normalizeItem,
  sanitizeMarkdown,
  updateManagedNote,
} = require("./template.cjs");

const FALLBACK_TEMPLATE = `---
类型: 捕获
状态: 待处理
创建日期: "{{date}}"
来源: ""
tags:
  - 状态/待处理
敏感级别: 内部
---

# {{title}}

## 下一步

- [ ] 删除：没有持续价值
- [ ] 转为知识卡片或研究课题

## 临时备注
`;

const DEFAULT_SETTINGS = {
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
  templatePath: "90-系统/模板/T-快速捕获.md",
  installationId: "",
  records: {},
  resolvedInboxFolder: "",
  lastCursor: "",
  lastSyncAt: "",
  lastSuccessAt: "",
  lastError: "",
  lastSummary: null,
};

const SENSITIVITY_RANK = { public: 0, internal: 1, confidential: 2, restricted: 3 };

function safeSegment(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|#^[\]\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120) || "未命名捕获";
}

function cleanFolder(value) {
  const normalized = String(value || "收件箱")
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .map(safeSegment)
    .join("/");
  return normalizePath(normalized || "收件箱");
}

function joinUrl(base, path) {
  return String(base || "").replace(/\/+$/, "") + path;
}

function validatedServerUrl(value) {
  const raw = String(value || "").trim();
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("服务器地址只支持 HTTP/HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new Error("服务器地址不能包含账号、查询参数或锚点");
  const local = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !local) throw new Error("非本机服务器必须使用 HTTPS，以免同步令牌泄漏");
  return raw.replace(/\/+$/, "");
}

function sanitizeError(error, token) {
  let message = error instanceof Error ? error.message : String(error);
  if (token) message = message.split(token).join("[已隐藏令牌]");
  return message
    .replace(/(?:obsidian_|sk-)[A-Za-z0-9_-]{8,}/g, "[已隐藏凭据]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500);
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
  if (!raw || typeof raw !== "object") throw new Error("同步数据项不是对象");
  if (typeof raw.contentMarkdown === "string" && raw.contentMarkdown.length > 220000) throw new Error("单条同步正文超过安全限制");
  if (Array.isArray(raw.attachments) && raw.attachments.length > 50) throw new Error("单条同步附件数量超过安全限制");
  const item = normalizeItem(raw);
  if (!item.id || item.id.length > 500) throw new Error("同步数据缺少有效远程 ID");
  if (!item.version || item.version.length > 200) throw new Error("同步数据缺少有效版本");
  if (!item.title || item.title.length > 120) throw new Error("同步数据标题无效");
  if (item.contentMarkdown.length > 220000) throw new Error("单条同步正文超过安全限制");
  if (item.attachments.length > 50) throw new Error("单条同步附件数量超过安全限制");
  let attachmentBytes = 0;
  for (const attachment of item.attachments) {
    if (!attachment.id || !attachment.fileName) throw new Error("同步附件缺少必要字段");
    if (!Number.isFinite(attachment.size) || attachment.size < 0 || attachment.size > 100 * 1024 * 1024) throw new Error("同步附件大小无效");
    if (attachment.sha256 && !/^[a-f0-9]{64}$/.test(attachment.sha256)) throw new Error("同步附件校验和无效");
    attachmentBytes += attachment.size;
  }
  if (attachmentBytes > 300 * 1024 * 1024) throw new Error("单条同步附件总体积超过安全限制");
  if (item.source.url) {
    const url = new URL(item.source.url);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("来源链接协议不受支持");
  }
  return item;
}

function validateBatch(response) {
  if (!response || typeof response !== "object") throw new Error("服务端返回不是 JSON 对象");
  if (response.schemaVersion && !["1.0", "1.1"].includes(response.schemaVersion)) throw new Error("同步协议版本不受支持");
  if (!Array.isArray(response.items) || response.items.length > 100) throw new Error("同步分页数据无效");
  return {
    ...response,
    batchId: typeof response.batchId === "string" ? response.batchId : "",
    items: response.items.map(validateItem),
    hasMore: response.hasMore === true,
  };
}

class TextModal extends Modal {
  constructor(app, title, lines) {
    super(app);
    this.title = title;
    this.lines = lines;
  }
  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.title });
    for (const line of this.lines) this.contentEl.createEl("p", { text: line });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("关闭").setCta().onClick(() => this.close()));
  }
}

class ResetCursorModal extends Modal {
  constructor(app, confirm) {
    super(app);
    this.confirmReset = confirm;
  }
  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "重置同步游标" });
    this.contentEl.createEl("p", { text: "服务端会重新发送历史记录。本地远程 ID 索引仍会阻止重复创建。" });
    this.contentEl.createEl("p", { text: "这是第一次确认；点击后还会要求再次确认。" });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("继续重置").setWarning().onClick(async () => {
        this.close();
        if (!window.confirm("再次确认：确定从头重放服务端同步记录吗？")) return;
        await this.confirmReset();
      }));
  }
}

class KnowledgeRelaySyncPlugin extends Plugin {
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
        lastSeenAt: stored.lastSyncAt || "",
      }]),
    );
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored, {
      installationId: stored.installationId || crypto.randomUUID(),
      records: Object.assign({}, migratedRecords, stored.records || {}),
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
    this.addRibbonIcon("refresh-cw", "同步知流收件台", () => this.syncNow(true));
    this.addSettingTab(new KnowledgeRelaySettingTab(this.app, this));
    this.registerVaultTracking();
    this.restartTimer();
    if (this.settings.syncOnStart && this.settings.token) {
      this.app.workspace.onLayoutReady(() => {
        if (this.startedOnce) return;
        this.startedOnce = true;
        const delay = Math.max(0, Math.min(30, Number(this.settings.startupDelaySeconds) || 3)) * 1000;
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
    this.addCommand({ id: "sync-now", name: "立即同步", callback: () => this.syncNow(true) });
    this.addCommand({ id: "show-sync-status", name: "查看上次同步状态", callback: () => this.showStatus() });
    this.addCommand({ id: "rescan-sync-records", name: "重新扫描本地同步记录", callback: () => this.rescanRecords(true) });
    this.addCommand({ id: "reset-sync-cursor", name: "重置同步游标", callback: () => new ResetCursorModal(this.app, () => this.resetCursor()).open() });
    this.addCommand({ id: "open-inbox", name: "打开收件箱", callback: () => this.openInbox() });
    this.addCommand({ id: "show-last-error", name: "查看最近一次错误", callback: () => this.showLastError() });
  }

  registerVaultTracking() {
    this.registerEvent(this.app.vault.on("rename", async (file, oldPath) => {
      for (const [remoteId, record] of Object.entries(this.settings.records)) {
        if (record.filePath !== oldPath) continue;
        record.filePath = file.path;
        const inbox = this.effectiveInboxFolder() + "/";
        record.processed = !file.path.startsWith(inbox);
        record.lastSeenAt = new Date().toISOString();
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
        record.lastSeenAt = new Date().toISOString();
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
    }, minutes * 60 * 1000);
  }

  updateStatus(text) {
    if (text) this.status.setText(text);
    else if (this.settings.lastError) this.status.setText("知流：同步异常");
    else if (this.settings.lastSuccessAt) this.status.setText("知流：" + new Date(this.settings.lastSuccessAt).toLocaleTimeString());
    else this.status.setText("知流：待同步");
  }

  notify(message, duration = 5000) {
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
    if (!this.settings.serverUrl || !this.settings.token) throw new Error("请先填写服务器地址和同步令牌");
    const timeout = Math.max(5, Math.min(60, Number(this.settings.requestTimeoutSeconds) || 15)) * 1000;
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
              options.body ? { "Content-Type": "application/json" } : {},
            ),
            body: options.body ? JSON.stringify(options.body) : undefined,
            throw: false,
          }),
          new Promise((_, reject) => {
            timeoutId = window.setTimeout(() => reject(new Error("请求超时")), timeout);
          }),
        ]).finally(() => timeoutId && window.clearTimeout(timeoutId));
        if (response.status === 401 || response.status === 403) {
          const error = new Error("同步授权已失效，请重新创建令牌");
          error.status = response.status;
          throw error;
        }
        if (response.status < 400) return response;
        const serverMessage = response.json && typeof response.json.error === "string" ? response.json.error : "";
        const error = new Error(serverMessage || `服务器返回 HTTP ${response.status}`);
        error.status = response.status;
        const retryAfter = Number(response.headers && (response.headers["retry-after"] || response.headers["Retry-After"])) || 0;
        error.retryAfter = Math.min(retryAfter * 1000, 30000);
        throw error;
      } catch (error) {
        lastError = error;
        const status = Number(error && error.status || 0);
        if ([401, 403].includes(status) || attempt === 2 || (status >= 400 && status < 500 && status !== 429)) break;
        await sleep(error.retryAfter || 500 * Math.pow(2, attempt));
      }
    }
    throw new Error(sanitizeError(lastError, this.settings.token));
  }

  async loadCaptureTemplate() {
    if (!this.settings.useTemplate) return { content: FALLBACK_TEMPLATE, warning: "" };
    const templatePath = normalizePath(String(this.settings.templatePath || "").trim());
    if (!templatePath) return { content: FALLBACK_TEMPLATE, warning: "尚未配置模板路径，已使用知流安全模板。" };
    const file = this.app.vault.getAbstractFileByPath(templatePath);
    if (!file || typeof file.extension !== "string" || file.extension.toLowerCase() !== "md") {
      return { content: FALLBACK_TEMPLATE, warning: `没有找到模板：${templatePath}，已使用知流安全模板。` };
    }
    try {
      return { content: await this.app.vault.cachedRead(file), warning: "" };
    } catch (error) {
      return { content: FALLBACK_TEMPLATE, warning: `读取模板失败：${sanitizeError(error, this.settings.token)}，已使用知流安全模板。` };
    }
  }

  async findRemoteId(remoteId) {
    if (this.remotePathCache && this.remotePathCache.has(remoteId)) return this.remotePathCache.get(remoteId) || "";
    if (!this.remoteIndexComplete) await this.buildRemoteIndex();
    return this.remotePathCache && this.remotePathCache.get(remoteId) || "";
  }

  prepareRemoteIndex() {
    this.remotePathCache = new Map(
      Object.entries(this.settings.records)
        .filter(([, record]) => {
          if (typeof record.filePath !== "string" || !record.filePath) return false;
          const file = this.app.vault.getAbstractFileByPath(record.filePath);
          return Boolean(file && typeof file.extension === "string");
        })
        .map(([remoteId, record]) => [remoteId, record.filePath]),
    );
    this.remoteIndexComplete = false;
  }

  effectiveInboxFolder() {
    return cleanFolder(this.settings.inboxFolder || this.settings.resolvedInboxFolder || "收件箱");
  }

  async buildRemoteIndex() {
    const index = this.remotePathCache || new Map();
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
    this.remotePathCache = new Map();
    this.remoteIndexComplete = false;
    const index = await this.buildRemoteIndex();
    let found = 0;
    for (const [remoteId, filePath] of index.entries()) {
      const record = this.settings.records[remoteId] || {
        version: "unknown",
        localReference: crypto.randomUUID(),
        dismissed: false,
        restricted: false,
      };
      record.filePath = filePath;
      record.processed = !filePath.startsWith(this.effectiveInboxFolder() + "/");
      record.conflict = false;
      record.lastSeenAt = new Date().toISOString();
      this.settings.records[remoteId] = record;
      found += 1;
    }
    await this.saveData(this.settings);
    if (showNotice) this.notify(`已重新索引 ${found} 条知流笔记`);
    return found;
  }

  isSensitivityAllowed(value) {
    if (value === "restricted") return false;
    return (SENSITIVITY_RANK[value] ?? 1) <= (SENSITIVITY_RANK[this.settings.maxSensitivity] ?? 1);
  }

  async downloadItemAttachments(item, folder) {
    if (!this.settings.downloadAttachments || !Array.isArray(item.attachments) || !item.attachments.length) return [];
    const attachmentsFolder = await this.ensureFolder(folder + "/附件");
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
      if (attachment.sha256 && actualHash !== attachment.sha256) throw new Error("附件完整性校验失败");
      if (attachment.size && fileResponse.arrayBuffer.byteLength !== attachment.size) throw new Error("附件长度与服务端记录不一致");
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
    const datePart = Number.isNaN(date.getTime()) ? "未知日期 0000" : [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
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
        lastSeenAt: new Date().toISOString(),
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
        lastSeenAt: new Date().toISOString(),
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
        record.lastSeenAt = new Date().toISOString();
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
      record.lastSeenAt = new Date().toISOString();
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
          conflict: false,
        };
        tracked.pendingVersion = item.version;
        tracked.lastSeenAt = new Date().toISOString();
        this.settings.records[item.id] = tracked;
        await this.saveData(this.settings);
        return { id: item.id, version: item.version, result: "unchanged", localReference };
      }
      const existing = await this.app.vault.cachedRead(file);
      const update = updateManagedNote(existing, item, attachmentLinks);
      if (update.conflict) {
        this.settings.records[item.id] = Object.assign({}, record, { filePath: file.path, localReference, conflict: true, lastSeenAt: new Date().toISOString() });
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
      lastSeenAt: new Date().toISOString(),
    };
    await this.saveData(this.settings);
    return { id: item.id, version: item.version, result, localReference };
  }

  async syncNow(showNotice) {
    if (this.syncing) {
      if (showNotice) this.notify("知流收件台正在同步");
      return;
    }
    if (!this.settings.token) {
      if (showNotice) this.notify("请先在插件设置中填写同步令牌");
      return;
    }
    this.syncing = true;
    this.settings.lastSyncAt = new Date().toISOString();
    this.updateStatus("知流：同步中…");
    const summary = { created: 0, updated: 0, unchanged: 0, skipped: 0, conflicts: 0, pages: 0 };
    try {
      const template = await this.loadCaptureTemplate();
      this.prepareRemoteIndex();
      if (showNotice && template.warning) this.notify(template.warning, 8000);
      const maximumPages = Math.max(1, Math.min(50, Number(this.settings.maxPages) || 10));
      const limit = Math.max(1, Math.min(100, Number(this.settings.pageSize) || 50));
      for (let page = 0; page < maximumPages; page += 1) {
        const response = await this.request("/api/sync/pull?limit=" + limit);
        if (String(response.text || "").length > 2 * 1024 * 1024) throw new Error("单页同步响应超过 2 MB 安全限制");
        const batch = validateBatch(response.json);
        const folder = await this.ensureFolder(this.settings.inboxFolder || batch.folder || "收件箱");
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
            results,
          },
        });
        if (!ack.json || ack.json.ok !== true) throw new Error("服务端未确认同步回执");
        this.settings.lastCursor = String(ack.json.cursor == null ? "" : ack.json.cursor);
        await this.saveData(this.settings);
        if (!batch.hasMore || !batch.items.length) break;
      }
      this.settings.lastSuccessAt = new Date().toISOString();
      this.settings.lastError = "";
      this.settings.lastSummary = summary;
      await this.saveData(this.settings);
      this.updateStatus();
      if (showNotice) {
        const changed = summary.created + summary.updated;
        this.notify(changed ? `知流同步完成：新增 ${summary.created}，更新 ${summary.updated}` : "知流收件台已经是最新状态");
        if (summary.conflicts) this.notify(`${summary.conflicts} 条内容需要重新扫描本地记录后处理`, 8000);
      }
    } catch (error) {
      this.settings.lastError = sanitizeError(error, this.settings.token);
      await this.saveData(this.settings);
      this.updateStatus();
      this.notify("知流同步失败：" + this.settings.lastError, 8000);
    } finally {
      this.syncing = false;
      this.remotePathCache = null;
      this.remoteIndexComplete = false;
    }
  }

  showStatus() {
    const summary = this.settings.lastSummary || {};
    new TextModal(this.app, "知流同步状态", [
      this.settings.lastSuccessAt ? "上次成功：" + new Date(this.settings.lastSuccessAt).toLocaleString() : "尚未成功同步",
      `新增 ${summary.created || 0} · 更新 ${summary.updated || 0} · 未变化 ${summary.unchanged || 0}`,
      `跳过 ${summary.skipped || 0} · 冲突 ${summary.conflicts || 0}`,
      `本地索引 ${Object.keys(this.settings.records).length} 条`,
    ]).open();
  }

  showLastError() {
    new TextModal(this.app, "最近一次同步错误", [this.settings.lastError || "暂无同步错误"]).open();
  }

  async resetCursor() {
    try {
      await this.request("/api/sync/reset", { method: "POST", body: { schemaVersion: "1.1" } });
      this.settings.lastCursor = "";
      await this.saveData(this.settings);
      this.notify("服务端游标已重置；本地远程 ID 索引会防止重复笔记", 7000);
    } catch (error) {
      this.notify("重置失败：" + sanitizeError(error, this.settings.token), 8000);
    }
  }

  async openInbox() {
    const folder = this.effectiveInboxFolder();
    const explanation = this.app.vault.getAbstractFileByPath(folder + "/收件箱说明.md");
    if (explanation && typeof explanation.extension === "string") return this.app.workspace.getLeaf(false).openFile(explanation);
    const file = this.app.vault.getMarkdownFiles().find((item) => item.path.startsWith(folder + "/"));
    if (file) return this.app.workspace.getLeaf(false).openFile(file);
    this.notify(`收件箱 ${folder} 中还没有笔记`);
  }
}

class KnowledgeRelaySettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "知流同步" });
    containerEl.createEl("p", { text: "同步令牌已经绑定唯一 Obsidian 连接，因此无需再填写 collectionId。" });
    new Setting(containerEl).setName("服务器地址").setDesc("非本机地址必须使用 HTTPS").addText((text) =>
      text.setPlaceholder("https://inbox.example.com").setValue(this.plugin.settings.serverUrl).onChange(async (value) => {
        this.plugin.settings.serverUrl = value.trim(); await this.plugin.saveSettings();
      }),
    );
    const tokenSetting = new Setting(containerEl).setName("同步令牌").setDesc("当前兼容版本会加密传输并保存在插件 data.json；不会写入笔记、日志或回执。请保护 Vault 配置目录。");
    tokenSetting.settingEl.addClass("wechat-inbox-sync-token");
    tokenSetting.addTextArea((text) => text.setPlaceholder("obsidian_...").setValue(this.plugin.settings.token).onChange(async (value) => {
      this.plugin.settings.token = value.trim(); await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("覆盖收件箱目录").setDesc("留空时使用服务端为该连接设置的目录").addText((text) =>
      text.setPlaceholder("收件箱").setValue(this.plugin.settings.inboxFolder).onChange(async (value) => {
        this.plugin.settings.inboxFolder = value.trim(); await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("优先使用快速捕获模板").setDesc("新笔记按模板创建；远程修订只更新托管区块").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.useTemplate).onChange(async (value) => {
        this.plugin.settings.useTemplate = value; await this.plugin.saveSettings(); this.display();
      }),
    );
    if (this.plugin.settings.useTemplate) {
      new Setting(containerEl).setName("模板路径").setDesc("相对于 Vault 根目录").addText((text) =>
        text.setPlaceholder("90-系统/模板/T-快速捕获.md").setValue(this.plugin.settings.templatePath).onChange(async (value) => {
          this.plugin.settings.templatePath = value.trim(); await this.plugin.saveSettings();
        }),
      ).addButton((button) => button.setButtonText("检查模板").onClick(async () => {
        const result = await this.plugin.loadCaptureTemplate();
        this.plugin.notify(result.warning || "模板读取成功，同步时会保留用户编辑区。", 6000);
      }));
    }
    new Setting(containerEl).setName("允许更新托管区块").setDesc("只更新标记区块和同步状态，不覆盖下一步、临时备注或自定义属性").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.allowManagedUpdates).onChange(async (value) => {
        this.plugin.settings.allowManagedUpdates = value; await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("启动时同步").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.syncOnStart).onChange(async (value) => {
        this.plugin.settings.syncOnStart = value; await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("启动延迟（秒）").setDesc("默认 3 秒，不阻塞 Obsidian 启动").addText((text) =>
      text.setValue(String(this.plugin.settings.startupDelaySeconds)).onChange(async (value) => {
        this.plugin.settings.startupDelaySeconds = Math.max(0, Math.min(30, Number(value) || 3)); await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("定时同步").setDesc("默认关闭；开启后最短每 5 分钟").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.enableInterval).onChange(async (value) => {
        this.plugin.settings.enableInterval = value; await this.plugin.saveSettings(); this.display();
      }),
    );
    if (this.plugin.settings.enableInterval) {
      new Setting(containerEl).setName("定时同步间隔（分钟）").addText((text) =>
        text.setValue(String(this.plugin.settings.intervalMinutes)).onChange(async (value) => {
          this.plugin.settings.intervalMinutes = Math.max(5, Number(value) || 5); await this.plugin.saveSettings();
        }),
      );
    }
    new Setting(containerEl).setName("单页数量").setDesc("1–100，默认 50").addText((text) =>
      text.setValue(String(this.plugin.settings.pageSize)).onChange(async (value) => {
        this.plugin.settings.pageSize = Math.max(1, Math.min(100, Number(value) || 50)); await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("单次最大页数").setDesc("默认 10").addText((text) =>
      text.setValue(String(this.plugin.settings.maxPages)).onChange(async (value) => {
        this.plugin.settings.maxPages = Math.max(1, Math.min(50, Number(value) || 10)); await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("请求超时（秒）").setDesc("5–60，默认 15").addText((text) =>
      text.setValue(String(this.plugin.settings.requestTimeoutSeconds)).onChange(async (value) => {
        this.plugin.settings.requestTimeoutSeconds = Math.max(5, Math.min(60, Number(value) || 15)); await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("允许同步的最高敏感级别").setDesc("严格受限内容始终不会写入普通 Vault").addDropdown((dropdown) =>
      dropdown.addOption("public", "公开").addOption("internal", "内部").addOption("confidential", "机密").setValue(this.plugin.settings.maxSensitivity).onChange(async (value) => {
        this.plugin.settings.maxSensitivity = value; await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("下载附件").setDesc("下载前校验 SHA-256，派生 Markdown 也作为附件保存").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.downloadAttachments).onChange(async (value) => {
        this.plugin.settings.downloadAttachments = value; await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("显示同步通知").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.showNotifications).onChange(async (value) => {
        this.plugin.settings.showNotifications = value; await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("同步操作").setDesc(this.plugin.settings.lastError ? "上次错误：" + this.plugin.settings.lastError : this.plugin.settings.lastSuccessAt ? "上次成功：" + new Date(this.plugin.settings.lastSuccessAt).toLocaleString() : "尚未同步")
      .addButton((button) => button.setButtonText("查看状态").onClick(() => this.plugin.showStatus()))
      .addButton((button) => button.setButtonText("立即同步").setCta().onClick(() => this.plugin.syncNow(true)));
  }
}

module.exports = KnowledgeRelaySyncPlugin;
