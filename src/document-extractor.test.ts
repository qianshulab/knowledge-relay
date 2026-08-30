import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import AdmZip from "adm-zip";
import { afterEach, describe, expect, it } from "vitest";

import type { CaptureInput } from "./capture.js";
import type { AppConfig } from "./config.js";
import { extractCaptureDocuments } from "./document-extractor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function captureWithFile(fileName: string, mimeType: string, content: Buffer): Promise<{ capture: CaptureInput; config: AppConfig }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-document-"));
  temporaryDirectories.push(dataDir);
  const filePath = path.join(dataDir, fileName);
  await fs.writeFile(filePath, content);
  return {
    config: { dataDir } as AppConfig,
    capture: {
      id: `manual:${fileName}`,
      source: { channel: "manual", type: "manual", externalId: fileName, name: "浏览器上传" },
      captureType: "file",
      actorId: "owner",
      receivedAt: new Date().toISOString(),
      text: "",
      attachments: [{ kind: "file", fileName, path: filePath, size: content.length, mimeType }],
    },
  };
}

async function captureWithFiles(files: Array<{ fileName: string; mimeType: string; content: Buffer }>): Promise<{ capture: CaptureInput; config: AppConfig }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-relay-documents-"));
  temporaryDirectories.push(dataDir);
  const attachments = [];
  for (const file of files) {
    const filePath = path.join(dataDir, file.fileName);
    await fs.writeFile(filePath, file.content);
    attachments.push({ kind: "file" as const, fileName: file.fileName, path: filePath, size: file.content.length, mimeType: file.mimeType });
  }
  return {
    config: { dataDir } as AppConfig,
    capture: {
      id: "manual:multiple-files",
      source: { channel: "manual", type: "manual", externalId: "multiple-files", name: "浏览器上传" },
      captureType: "file",
      actorId: "owner",
      receivedAt: new Date().toISOString(),
      text: "项目资料",
      attachments,
    },
  };
}

describe("deterministic document extraction", () => {
  it("keeps Markdown bundle images addressable through attachment references", async () => {
    const archive = new AdmZip();
    archive.addFile("README.md", Buffer.from("# 使用说明\n\n下面是架构图。\n\n![架构图](<assets/system diagram.png>)"));
    archive.addFile("assets/system diagram.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const input = await captureWithFile("project.zip", "application/zip", archive.toBuffer());

    const result = await extractCaptureDocuments(input.config, input.capture, "tenant-one");

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.markdown).toMatch(/!\[架构图\]\(attachment:\/\/[a-f0-9]{64}\)/);
    expect(result.assets).toHaveLength(1);
    await expect(fs.stat(result.assets[0]!.path)).resolves.toBeTruthy();
  });

  it("turns DOCX paragraphs and tables into readable Markdown", async () => {
    const archive = new AdmZip();
    archive.addFile("word/document.xml", Buffer.from(`<?xml version="1.0"?>
      <w:document xmlns:w="w"><w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>安装方法</w:t></w:r></w:p>
        <w:tbl>
          <w:tr><w:tc><w:p><w:r><w:t>平台</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>状态</w:t></w:r></w:p></w:tc></w:tr>
          <w:tr><w:tc><w:p><w:r><w:t>Claude Code</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>原生</w:t></w:r></w:p></w:tc></w:tr>
        </w:tbl>
      </w:body></w:document>`));
    const input = await captureWithFile("guide.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", archive.toBuffer());

    const result = await extractCaptureDocuments(input.config, input.capture);

    expect(result.documents[0]?.markdown).toContain("## 安装方法");
    expect(result.documents[0]?.markdown).toContain("| 平台 | 状态 |");
    expect(result.documents[0]?.markdown).toContain("| Claude Code | 原生 |");
  });

  it("turns XLSX worksheets into bounded Markdown tables", async () => {
    const archive = new AdmZip();
    archive.addFile("xl/workbook.xml", Buffer.from(`<workbook><sheets><sheet name="支持矩阵" r:id="rId1"/></sheets></workbook>`));
    archive.addFile("xl/_rels/workbook.xml.rels", Buffer.from(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`));
    archive.addFile("xl/sharedStrings.xml", Buffer.from(`<sst><si><t>平台</t></si><si><t>状态</t></si><si><t>Cursor</t></si><si><t>支持</t></si></sst>`));
    archive.addFile("xl/worksheets/sheet1.xml", Buffer.from(`<worksheet><sheetData>
      <row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>
    </sheetData></worksheet>`));
    const input = await captureWithFile("matrix.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", archive.toBuffer());

    const result = await extractCaptureDocuments(input.config, input.capture);

    expect(result.documents[0]?.markdown).toContain("## 支持矩阵");
    expect(result.documents[0]?.markdown).toContain("| 平台 | 状态 |");
    expect(result.documents[0]?.markdown).toContain("| Cursor | 支持 |");
  });

  it("preserves tables when importing standalone HTML", async () => {
    const html = Buffer.from(`<html><body><main><h1>兼容性</h1><table><tr><th>平台</th><th>状态</th></tr><tr><td>Codex</td><td>支持</td></tr></table></main></body></html>`);
    const input = await captureWithFile("compatibility.html", "text/html", html);

    const result = await extractCaptureDocuments(input.config, input.capture);

    expect(result.documents[0]?.markdown).toContain("| 平台 | 状态 |");
    expect(result.documents[0]?.markdown).toContain("| Codex | 支持 |");
  });

  it("extracts supported office documents from a generic ZIP archive", async () => {
    const spreadsheet = new AdmZip();
    spreadsheet.addFile("xl/workbook.xml", Buffer.from(`<workbook><sheets><sheet name="清单" r:id="rId1"/></sheets></workbook>`));
    spreadsheet.addFile("xl/_rels/workbook.xml.rels", Buffer.from(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`));
    spreadsheet.addFile("xl/worksheets/sheet1.xml", Buffer.from(`<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>项目</t></is></c><c r="B1" t="inlineStr"><is><t>状态</t></is></c></row></sheetData></worksheet>`));
    const archive = new AdmZip();
    archive.addFile("docs/matrix.xlsx", spreadsheet.toBuffer());
    archive.addFile("notes.txt", Buffer.from("部署前完成验证"));
    const input = await captureWithFile("bundle.zip", "application/zip", archive.toBuffer());

    const result = await extractCaptureDocuments(input.config, input.capture);

    expect(result.documents[0]?.markdown).toContain("## matrix");
    expect(result.documents[0]?.markdown).toContain("| 项目 | 状态 |");
    expect(result.documents[0]?.markdown).toContain("## notes");
    expect(result.documents[0]?.markdown).toContain("部署前完成验证");
  });

  it("combines multiple uploaded documents into one stable reading article", async () => {
    const input = await captureWithFiles([
      { fileName: "guide.md", mimeType: "text/markdown", content: Buffer.from("# 指南\n\n安装步骤") },
      { fileName: "checklist.txt", mimeType: "text/plain", content: Buffer.from("发布前检查") },
    ]);

    const result = await extractCaptureDocuments(input.config, input.capture);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.title).toBe("项目资料");
    expect(result.documents[0]?.markdown).toContain("## guide");
    expect(result.documents[0]?.markdown).toContain("## checklist");
  });
});
