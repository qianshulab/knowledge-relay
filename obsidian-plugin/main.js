const { Notice, Plugin, PluginSettingTab, Setting, requestUrl, normalizePath } = require("obsidian");
const { applyCaptureTemplate } = require("./template.cjs");

const DEFAULT_SETTINGS = {
  serverUrl: "http://127.0.0.1:8787",
  token: "",
  inboxFolder: "",
  intervalMinutes: 5,
  syncOnStart: true,
  downloadAttachments: true,
  useTemplate: true,
  templatePath: "90-系统/模板/T-快速捕获.md",
  messageFiles: {},
  lastSyncAt: "",
  lastError: "",
};

function safeSegment(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|#^[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "微信收件";
}

function cleanFolder(value) {
  return normalizePath(
    String(value || "Inbox/微信")
      .replace(/\\/g, "/")
      .split("/")
      .filter((part) => part && part !== "." && part !== "..")
      .map(safeSegment)
      .join("/"),
  );
}

function joinUrl(base, path) {
  return String(base || "").replace(/\/+$/, "") + path;
}

function validatedServerUrl(value) {
  const raw = String(value || "").trim();
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("服务器地址只支持 HTTP/HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new Error("服务器地址不能包含账号、查询参数或锚点");
  const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !local) throw new Error("非本机服务器必须使用 HTTPS，以免同步令牌泄漏");
  return raw.replace(/\/+$/, "");
}

async function sha256Hex(buffer) {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

class WechatInboxSyncPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.syncing = false;
    this.status = this.addStatusBarItem();
    this.status.addClass("wechat-inbox-sync-status");
    this.updateStatus();
    this.addCommand({
      id: "sync-now",
      name: "立即同步知流收件箱",
      callback: () => this.syncNow(true),
    });
    this.addRibbonIcon("refresh-cw", "同步知流收件箱", () => this.syncNow(true));
    this.addSettingTab(new WechatInboxSettingTab(this.app, this));
    this.restartTimer();
    if (this.settings.syncOnStart && this.settings.token) {
      this.app.workspace.onLayoutReady(() => this.syncNow(false));
    }
  }

  onunload() {
    if (this.timer) window.clearInterval(this.timer);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.restartTimer();
    this.updateStatus();
  }

  restartTimer() {
    if (this.timer) window.clearInterval(this.timer);
    const minutes = Math.max(1, Number(this.settings.intervalMinutes) || 5);
    this.timer = window.setInterval(() => this.syncNow(false), minutes * 60 * 1000);
    this.registerInterval(this.timer);
  }

  updateStatus(text) {
    if (text) this.status.setText(text);
    else if (this.settings.lastError) this.status.setText("知流：同步异常");
    else if (this.settings.lastSyncAt) this.status.setText("知流：" + new Date(this.settings.lastSyncAt).toLocaleTimeString());
    else this.status.setText("知流：待同步");
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
    return requestUrl({
      url: joinUrl(validatedServerUrl(this.settings.serverUrl), path),
      method: options.method || "GET",
      headers: Object.assign(
        { Authorization: "Bearer " + this.settings.token },
        options.body ? { "Content-Type": "application/json" } : {},
      ),
      body: options.body ? JSON.stringify(options.body) : undefined,
      throw: false,
    });
  }

  async loadCaptureTemplate() {
    if (!this.settings.useTemplate) return { content: null, warning: "" };
    const templatePath = normalizePath(String(this.settings.templatePath || "").trim());
    if (!templatePath) return { content: null, warning: "尚未配置收件箱模板路径，已使用服务器笔记格式。" };
    const file = this.app.vault.getAbstractFileByPath(templatePath);
    if (!file || typeof file.extension !== "string" || file.extension.toLowerCase() !== "md") {
      return { content: null, warning: `没有找到模板：${templatePath}，已使用服务器笔记格式。` };
    }
    try {
      return { content: await this.app.vault.cachedRead(file), warning: "" };
    } catch (error) {
      return {
        content: null,
        warning: `读取模板失败：${error instanceof Error ? error.message : String(error)}，已使用服务器笔记格式。`,
      };
    }
  }

  async syncNow(showNotice) {
    if (this.syncing) {
      if (showNotice) new Notice("知流收件箱正在同步");
      return;
    }
    if (!this.settings.token) {
      if (showNotice) new Notice("请先在插件设置中填写同步令牌");
      return;
    }
    this.syncing = true;
    this.updateStatus("知流：同步中…");
    let total = 0;
    try {
      const template = await this.loadCaptureTemplate();
      if (showNotice && template.warning) new Notice(template.warning, 8000);
      for (let page = 0; page < 50; page += 1) {
        const response = await this.request("/api/sync/pull");
        if (response.status >= 400) throw new Error(response.json && response.json.error || "拉取失败：HTTP " + response.status);
        const batch = response.json;
        const folder = await this.ensureFolder(this.settings.inboxFolder || batch.folder || "Inbox/微信");
        const attachmentsFolder = await this.ensureFolder(folder + "/attachments");
        for (const item of batch.items || []) {
          const attachmentLinks = [];
          if (this.settings.downloadAttachments) {
            for (const attachment of item.attachments || []) {
              const storedName = safeSegment(String(attachment.id).slice(0, 8) + "-" + attachment.fileName);
              const attachmentPath = normalizePath(attachmentsFolder + "/" + storedName);
              const fileResponse = await this.request("/api/sync/attachments/" + encodeURIComponent(attachment.id));
              if (fileResponse.status >= 400) throw new Error("附件下载失败：" + attachment.fileName);
              const actualHash = await sha256Hex(fileResponse.arrayBuffer);
              if (attachment.sha256 && actualHash !== attachment.sha256) throw new Error("附件校验失败：" + attachment.fileName);
              if (attachment.mimeType === "text/markdown" || attachment.mimeType === "text/plain") {
                await this.writeText(attachmentPath, new TextDecoder("utf-8").decode(fileResponse.arrayBuffer));
              } else {
                await this.writeBinary(attachmentPath, fileResponse.arrayBuffer);
              }
              attachmentLinks.push("- [[" + attachmentPath + "|" + attachment.fileName.replace(/\|/g, " ") + "]] ");
            }
          }
          let notePath = this.settings.messageFiles[item.messageId];
          if (!notePath) notePath = normalizePath(folder + "/" + safeSegment(item.fileName.replace(/\.md$/i, "")) + ".md");
          const content = template.content
            ? applyCaptureTemplate(template.content, item, attachmentLinks)
            : String(item.markdown || "").trimEnd() +
              (attachmentLinks.length ? "\n\n## 同步附件\n\n" + attachmentLinks.join("\n") : "") + "\n";
          await this.writeText(notePath, content);
          this.settings.messageFiles[item.messageId] = notePath;
          total += 1;
        }
        await this.saveData(this.settings);
        if (!batch.batchId && !(batch.items || []).length) break;
        const ack = await this.request("/api/sync/ack", { method: "POST", body: { batchId: batch.batchId } });
        if (ack.status >= 400) throw new Error(ack.json && ack.json.error || "确认同步失败：HTTP " + ack.status);
        if (!batch.hasMore || !(batch.items || []).length) break;
      }
      this.settings.lastSyncAt = new Date().toISOString();
      this.settings.lastError = "";
      await this.saveData(this.settings);
      this.updateStatus();
      if (showNotice) new Notice(total ? "已同步 " + total + " 条微信消息" : "知流收件箱已经是最新状态");
    } catch (error) {
      this.settings.lastError = error instanceof Error ? error.message : String(error);
      await this.saveData(this.settings);
      this.updateStatus();
      new Notice("知流同步失败：" + this.settings.lastError, 8000);
    } finally {
      this.syncing = false;
    }
  }
}

class WechatInboxSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "知流同步" });
    containerEl.createEl("p", { text: "在服务端的“Obsidian 同步”页面创建设备，然后把令牌粘贴到这里。" });
    new Setting(containerEl).setName("服务器地址").setDesc("例如 http://127.0.0.1:8787 或你的 HTTPS 地址").addText((text) =>
      text.setPlaceholder("https://inbox.example.com").setValue(this.plugin.settings.serverUrl).onChange(async (value) => {
        this.plugin.settings.serverUrl = value.trim(); await this.plugin.saveSettings();
      }),
    );
    const tokenSetting = new Setting(containerEl).setName("同步令牌").setDesc("令牌等同于这个 Vault 的访问密码，请勿分享。");
    tokenSetting.settingEl.addClass("wechat-inbox-sync-token");
    tokenSetting.addTextArea((text) => text.setPlaceholder("obsidian_...").setValue(this.plugin.settings.token).onChange(async (value) => {
      this.plugin.settings.token = value.trim(); await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("覆盖收件箱目录").setDesc("留空时使用服务端为该设备配置的目录。").addText((text) =>
      text.setPlaceholder("Inbox/微信").setValue(this.plugin.settings.inboxFolder).onChange(async (value) => {
        this.plugin.settings.inboxFolder = value.trim(); await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("优先使用收件箱模板").setDesc("开启后，新消息和后续修订都会基于指定模板生成；模板不可用时安全回退。").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.useTemplate).onChange(async (value) => {
        this.plugin.settings.useTemplate = value; await this.plugin.saveSettings(); this.display();
      }),
    );
    if (this.plugin.settings.useTemplate) {
      new Setting(containerEl).setName("模板路径").setDesc("相对于当前 Vault 根目录，例如 90-系统/模板/T-快速捕获.md").addText((text) =>
        text.setPlaceholder("90-系统/模板/T-快速捕获.md").setValue(this.plugin.settings.templatePath).onChange(async (value) => {
          this.plugin.settings.templatePath = value.trim(); await this.plugin.saveSettings();
        }),
      ).addButton((button) => button.setButtonText("检查模板").onClick(async () => {
        const result = await this.plugin.loadCaptureTemplate();
        new Notice(result.content ? "模板读取成功，同步时会优先应用。" : result.warning, 6000);
      }));
    }
    new Setting(containerEl).setName("自动同步间隔").setDesc("最少 1 分钟。").addText((text) =>
      text.setValue(String(this.plugin.settings.intervalMinutes)).onChange(async (value) => {
        this.plugin.settings.intervalMinutes = Math.max(1, Number(value) || 5); await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("启动时同步").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.syncOnStart).onChange(async (value) => {
        this.plugin.settings.syncOnStart = value; await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("下载附件").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.downloadAttachments).onChange(async (value) => {
        this.plugin.settings.downloadAttachments = value; await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("立即同步").setDesc(this.plugin.settings.lastError ? "上次错误：" + this.plugin.settings.lastError : this.plugin.settings.lastSyncAt ? "上次成功：" + new Date(this.plugin.settings.lastSyncAt).toLocaleString() : "尚未同步").addButton((button) =>
      button.setButtonText("同步").setCta().onClick(() => this.plugin.syncNow(true)),
    );
  }
}

module.exports = WechatInboxSyncPlugin;
