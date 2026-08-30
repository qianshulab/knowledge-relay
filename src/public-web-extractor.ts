import { load, type Cheerio, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

import { requestPublicHtml } from "./web-assets.js";
import type { ExtractedWebContent } from "./web-content.js";

const ARTICLE_SELECTORS = [
  "[itemprop='articleBody']",
  "article",
  ".article-content",
  ".article__content",
  ".post-content",
  ".post__content",
  ".entry-content",
  ".markdown-body",
  ".message.message_md_type",
  "main",
] as const;

const REMOVE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "form",
  "nav",
  "footer",
  "aside",
  "[hidden]",
  "[aria-hidden='true']",
  ".advertisement",
  ".comments",
  ".comment-list",
  ".related-posts",
  ".share-buttons",
] as const;

function cleanText(value: string | undefined, maximum = 200): string | undefined {
  const result = value?.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
  return result || undefined;
}

function meta($: CheerioAPI, ...selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const value = cleanText($(selector).first().attr("content"));
    if (value) return value;
  }
  return undefined;
}

function articleScore(root: Cheerio<AnyNode>): number {
  const textLength = root.text().replace(/\s+/g, " ").trim().length;
  const images = root.find("img").length;
  const paragraphs = root.find("p,pre,blockquote,li").length;
  const links = root.find("a").text().replace(/\s+/g, " ").trim().length;
  const linkPenalty = textLength ? Math.round((links / textLength) * 500) : 0;
  return textLength + images * 320 + Math.min(paragraphs, 80) * 24 - linkPenalty;
}

function findArticleRoot($: CheerioAPI, sourceUrl: string): Cheerio<AnyNode> | undefined {
  const hostname = new URL(sourceUrl).hostname.toLowerCase();
  if (hostname === "bbs.kanxue.com" || hostname.endsWith(".kanxue.com")) {
    const kanxue = $(".message.message_md_type").first();
    if (kanxue.length) return kanxue;
  }
  let best: { root: Cheerio<AnyNode>; score: number } | undefined;
  for (const selector of ARTICLE_SELECTORS) {
    $(selector).each((_index, element) => {
      const root = $(element);
      const score = articleScore(root);
      if (!best || score > best.score) best = { root, score };
    });
  }
  return best && best.score >= 300 ? best.root : undefined;
}

function imageSource(element: Cheerio<AnyNode>): string | undefined {
  for (const attribute of ["data-src", "data-original", "data-lazy-src", "data-url", "src"]) {
    const value = element.attr(attribute)?.trim();
    if (value && !/^(?:data|blob|javascript):/i.test(value)) return value;
  }
  return element.attr("srcset")?.split(",")[0]?.trim().split(/\s+/)[0];
}

function normalizeArticleImages($: CheerioAPI, root: Cheerio<AnyNode>, sourceUrl: string): void {
  root.find("img").each((index, element) => {
    const image = $(element);
    const candidate = imageSource(image);
    if (!candidate) {
      image.remove();
      return;
    }
    try {
      const absolute = new URL(candidate.replace(/&amp;/gi, "&"), sourceUrl);
      if (!["http:", "https:"].includes(absolute.protocol)) throw new Error("unsupported image URL");
      image.attr("src", absolute.toString());
      image.attr("alt", cleanText(image.attr("alt"), 120) || `正文图片 ${index + 1}`);
      image.removeAttr("srcset");
    } catch {
      image.remove();
    }
  });
}

export function extractWebContentFromHtml(
  html: string,
  sourceUrl: string,
): ExtractedWebContent | undefined {
  const $ = load(html);
  const hostname = new URL(sourceUrl).hostname.toLowerCase();
  const root = findArticleRoot($, sourceUrl);
  if (!root) return undefined;
  const article = load(`<main>${root.html() || ""}</main>`, null, false);
  const articleRoot = article("main");
  for (const selector of REMOVE_SELECTORS) articleRoot.find(selector).remove();
  normalizeArticleImages(article, articleRoot, sourceUrl);

  const kanxueTitle = hostname === "bbs.kanxue.com" || hostname.endsWith(".kanxue.com")
    ? cleanText($("dl.row.small dt .break-all span").first().text())
      || cleanText($("title").first().text())?.replace(/-[^-]+-看雪安全社区.*$/u, "")
    : undefined;
  const title = kanxueTitle || meta(
    $,
    "meta[property='og:title']",
    "meta[name='twitter:title']",
  ) || cleanText($("h1").first().text()) || cleanText($("title").first().text()) || hostname;
  const author = meta(
    $,
    "meta[name='author']",
    "meta[property='article:author']",
  ) || cleanText($("[rel='author'], .author, .post-author").first().text(), 120);
  const publishedAt = meta(
    $,
    "meta[property='article:published_time']",
    "meta[name='date']",
    "meta[name='publishdate']",
  ) || cleanText($("time[datetime]").first().attr("datetime"), 80);

  const turndown = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "_",
    headingStyle: "atx",
  });
  turndown.use(gfm);
  turndown.remove(["button", "input", "select", "textarea"]);
  const markdown = turndown.turndown(articleRoot.html() || "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  const textLength = articleRoot.text().replace(/\s+/g, " ").trim().length;
  if (textLength < 200 || markdown.length < 200) return undefined;
  return {
    url: sourceUrl,
    title,
    ...(author ? { author } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    markdown,
    sourceType: "web",
  };
}

export async function extractPublicWebContent(url: string): Promise<ExtractedWebContent | undefined> {
  const response = await requestPublicHtml(url);
  return extractWebContentFromHtml(response.html, response.url);
}
