import { describe, expect, it } from "vitest";

import {
  estimateEvidenceTokens,
  retrieveKnowledgeEvidence,
  verifyKnowledgeAnswer,
  type KnowledgeEvidenceSource,
  type KnowledgeRetrievalStore,
} from "./knowledge-retriever.js";
import type { InboxSearchResult, KnowledgeChunkSearchResult } from "./storage/database.js";

function chunk(messageId: string, ordinal = 0, content = `${messageId} 的可验证知识段落`): KnowledgeChunkSearchResult {
  return {
    messageId,
    ordinal,
    title: `资料 ${messageId}`,
    summary: `${messageId} 摘要`,
    heading: `章节 ${ordinal + 1}`,
    content,
    domains: ["测试领域"],
    knowledgePoints: ["检索增强"],
    score: 100 - ordinal,
  };
}

function fakeStore(rankings: Record<string, KnowledgeChunkSearchResult[]>): KnowledgeRetrievalStore {
  const all = Array.from(new Map(
    Object.values(rankings).flat().map((item) => [item.messageId, item]),
  ).values());
  return {
    searchKnowledgeChunks(query, limit = 30) {
      return (rankings[query] || []).slice(0, limit);
    },
    searchInbox() {
      return [] as InboxSearchResult[];
    },
    knowledgeChunksForMessage(messageId, limit = 4) {
      return all.filter((item) => item.messageId === messageId).slice(0, limit);
    },
    getMessage() {
      return undefined;
    },
    getMessageDetail() {
      return undefined;
    },
  };
}

function source(id: string): KnowledgeEvidenceSource {
  return {
    id,
    title: `资料 ${id}`,
    summary: `${id} 摘要`,
    content: `${id} 正文`,
    excerpt: `${id} 证据`,
    domains: [],
    knowledgePoints: [],
    chunkOrdinals: [0],
  };
}

describe("知识问答证据检索", () => {
  it("按上下文预算动态选择来源，不再固定截断为 8 篇文章", () => {
    const candidates = Array.from({ length: 15 }, (_, index) =>
      chunk(`doc-${index + 1}`, 0, `备份策略证据 ${index + 1}：${"不同来源的事实说明。".repeat(8)}`),
    );
    const result = retrieveKnowledgeEvidence(fakeStore({ "备份策略": candidates }), {
      question: "备份策略",
      maxEvidenceCharacters: 42_000,
      maxEvidenceTokens: 12_000,
    });

    expect(result.sources).toHaveLength(15);
    expect(result.diagnostics.selectedSources).toBe(15);
    expect(result.diagnostics.selectedChunks).toBe(15);
    expect(result.diagnostics.usedCharacters).toBeLessThanOrEqual(result.diagnostics.characterBudget);
    expect(result.diagnostics.estimatedTokens).toBeLessThanOrEqual(result.diagnostics.tokenBudget);
  });

  it("用 RRF 融合多个查询的排名，并优先反复命中的证据", () => {
    const shared = chunk("shared", 0, "NAS 离线备份和异地副本的共同建议");
    const firstOnly = chunk("single", 0, "NAS 离线备份和异地副本的共同建议");
    const result = retrieveKnowledgeEvidence(fakeStore({
      "NAS 备份": [firstOnly, chunk("noise-1"), shared],
      "离线副本": [shared, chunk("noise-2")],
    }), {
      question: "NAS 备份",
      plan: { queries: ["离线副本"] },
    });

    expect(result.diagnostics.queries).toEqual(["NAS 备份", "离线副本"]);
    expect(result.sources[0]?.id).toBe("shared");
  });

  it("遵守租户会话范围，并让字符与 token 预算限制最终上下文", () => {
    const candidates = Array.from({ length: 12 }, (_, index) =>
      chunk(`doc-${index + 1}`, 0, `范围证据 ${index + 1}：${"这是用于验证预算的中文段落。".repeat(80)}`),
    );
    const allowed = new Set(candidates.slice(0, 7).map((item) => item.messageId));
    const result = retrieveKnowledgeEvidence(fakeStore({ "范围问题": candidates }), {
      question: "范围问题",
      allowedMessageIds: allowed,
      maxEvidenceCharacters: 4_000,
      maxEvidenceTokens: 2_000,
      maxChunkCharacters: 1_200,
    });

    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources.length).toBeLessThan(7);
    expect(result.sources.every((item) => allowed.has(item.id))).toBe(true);
    expect(result.diagnostics.usedCharacters).toBeLessThanOrEqual(4_000);
    expect(result.diagnostics.estimatedTokens).toBeLessThanOrEqual(2_000);
  });

  it("只保留能映射到本轮证据的引用，并移除虚构编号", () => {
    const sources = [source("a"), source("b")];
    const verified = verifyKnowledgeAnswer(
      "第一项事实。[S1] 不存在的来源。[S9]",
      sources,
      ["b", "not-present"],
    );

    expect(verified.answer).toBe("第一项事实。[S1] 不存在的来源。");
    expect(verified.citedSourceIds).toEqual(["a", "b"]);
    expect(verified.grounded).toBe(true);
  });

  it("模型没有提供任何可验证引用时不会落库为有依据答案", () => {
    const verified = verifyKnowledgeAnswer("根据经验应该这样做。", [source("a")], []);

    expect(verified.grounded).toBe(false);
    expect(verified.citedSourceIds).toEqual([]);
    expect(verified.answer).toContain("没有给出可验证的来源引用");
  });

  it("回答引用超过持久化上限时移除无法随消息保存的尾部标记", () => {
    const sources = Array.from({ length: 30 }, (_, index) => source(`doc-${index + 1}`));
    const answer = sources.map((_item, index) => `事实 ${index + 1}。[S${index + 1}]`).join(" ");
    const verified = verifyKnowledgeAnswer(answer, sources, sources.map((item) => item.id));

    expect(verified.citedSourceIds).toHaveLength(24);
    expect(verified.answer).toContain("[S24]");
    expect(verified.answer).not.toContain("[S25]");
    expect(verified.answer).not.toContain("[S30]");
  });

  it("对中文证据采用比英文更保守的 token 估算", () => {
    expect(estimateEvidenceTokens("中文知识证据")).toBe(6);
    expect(estimateEvidenceTokens("abcdefgh")).toBe(2);
  });
});
