import type {
  InboxSearchOptions,
  InboxSearchResult,
  KnowledgeChunkSearchResult,
  MessageDetail,
  MessageListItem,
} from "./storage/database.js";

export type KnowledgeRetrievalPlan = {
  queries?: string[];
  domains?: string[];
  knowledgePoints?: string[];
  tools?: string[];
};

export type KnowledgeEvidenceSource = {
  id: string;
  title: string;
  summary: string;
  content: string;
  excerpt: string;
  domains: string[];
  knowledgePoints: string[];
  chunkOrdinals: number[];
};

export type KnowledgeRetrievalDiagnostics = {
  queries: string[];
  candidateChunks: number;
  candidateDocuments: number;
  selectedChunks: number;
  selectedSources: number;
  usedCharacters: number;
  estimatedTokens: number;
  characterBudget: number;
  tokenBudget: number;
};

export type KnowledgeRetrievalResult = {
  sources: KnowledgeEvidenceSource[];
  diagnostics: KnowledgeRetrievalDiagnostics;
};

export type KnowledgeRetrievalStore = {
  searchKnowledgeChunks(query: string, limit?: number): KnowledgeChunkSearchResult[];
  searchInbox(query: string, options?: InboxSearchOptions): InboxSearchResult[];
  knowledgeChunksForMessage(messageId: string, limit?: number): KnowledgeChunkSearchResult[];
  getMessage(messageId: string): MessageListItem | undefined;
  getMessageDetail(messageId: string): MessageDetail | undefined;
};

export type KnowledgeRetrievalInput = {
  question: string;
  contextualQuestion?: string;
  plan?: KnowledgeRetrievalPlan;
  allowedMessageIds?: ReadonlySet<string>;
  continuityMessageIds?: string[];
  pinnedMessageIds?: string[];
  maxEvidenceCharacters?: number;
  maxEvidenceTokens?: number;
  maxChunkCharacters?: number;
};

type RankedChunk = {
  chunk: KnowledgeChunkSearchResult;
  rrfScore: number;
  documentScore: number;
  queryHits: Set<number>;
  nativeScore: number;
  pinned: boolean;
};

const RRF_K = 60;
const DEFAULT_CHARACTER_BUDGET = 42_000;
const DEFAULT_TOKEN_BUDGET = 12_000;
const DEFAULT_CHUNK_CHARACTER_LIMIT = 4_800;
const MAX_QUERY_VARIANTS = 8;
const MAX_CHUNKS_PER_SOURCE = 3;
// Keep enough verified references for broad synthesis questions. Retrieval is
// already constrained by the evidence budget, so an additional eight-source
// ceiling only hides valid coverage from the user.
const MAX_PERSISTED_CITATIONS = 24;
const MAX_REFERENCEABLE_SOURCES = 99;

function cleanText(value: string, maximum: number): string {
  return value.normalize("NFKC").replace(/[\r\t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, maximum);
}

function cleanQuery(value: string): string {
  return cleanText(value, 500).replace(/\s+/g, " ");
}

function uniqueStrings(values: Array<string | undefined>, limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const cleaned = cleanQuery(value);
    const key = cleaned.toLocaleLowerCase("zh-CN");
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
    if (result.length >= limit) break;
  }
  return result;
}

function searchTokens(value: string): Set<string> {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const tokens = new Set<string>();
  for (const token of normalized.match(/[a-z0-9][a-z0-9_.+#/-]{1,63}/g) || []) tokens.add(token);
  for (const block of normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}/gu) || []) {
    const characters = Array.from(block);
    if (characters.length === 2) tokens.add(block);
    for (let index = 0; index < characters.length - 1; index += 1) {
      tokens.add(characters.slice(index, index + 2).join(""));
      if (tokens.size >= 256) break;
    }
    if (tokens.size >= 256) break;
  }
  return tokens;
}

function tokenOverlap(queryTokens: ReadonlySet<string>, value: string): number {
  if (!queryTokens.size) return 0;
  const valueTokens = searchTokens(value);
  let matches = 0;
  for (const token of queryTokens) if (valueTokens.has(token)) matches += 1;
  return matches / queryTokens.size;
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

export function estimateEvidenceTokens(value: string): number {
  let han = 0;
  let other = 0;
  for (const character of value) {
    if (/\p{Script=Han}/u.test(character)) han += 1;
    else if (!/\s/u.test(character)) other += 1;
  }
  return Math.max(1, han + Math.ceil(other / 4));
}

function shouldCarryConversationContext(question: string): boolean {
  const cleaned = cleanQuery(question);
  return cleaned.length <= 36 || /(?:它|这个|这些|上述|前面|刚才|其中|继续|那(?:么|个|些)?|其区别|还有呢|为什么呢)/.test(cleaned);
}

function fallbackChunk(detail: MessageDetail): KnowledgeChunkSearchResult | undefined {
  const content = cleanText(
    detail.contentMarkdown || detail.detailsMarkdown || detail.markdown || detail.text,
    DEFAULT_CHUNK_CHARACTER_LIMIT,
  );
  if (!content) return undefined;
  return {
    messageId: detail.id,
    ordinal: -1,
    title: detail.title,
    summary: detail.summary,
    heading: detail.title || "正文",
    content,
    domains: detail.domains,
    knowledgePoints: detail.knowledgePoints,
    score: 0,
  };
}

function scoped(input: KnowledgeRetrievalInput, messageId: string): boolean {
  return !input.allowedMessageIds || input.allowedMessageIds.has(messageId);
}

function chunkKey(chunk: Pick<KnowledgeChunkSearchResult, "messageId" | "ordinal">): string {
  return `${chunk.messageId}:${chunk.ordinal}`;
}

function addRrfChunk(
  candidates: Map<string, RankedChunk>,
  chunk: KnowledgeChunkSearchResult,
  queryIndex: number,
  rank: number,
  weight: number,
  pinned = false,
): void {
  const key = chunkKey(chunk);
  const current = candidates.get(key) || {
    chunk,
    rrfScore: 0,
    documentScore: 0,
    queryHits: new Set<number>(),
    nativeScore: 0,
    pinned: false,
  };
  current.rrfScore += weight / (RRF_K + rank + 1);
  current.nativeScore = Math.max(current.nativeScore, Number.isFinite(chunk.score) ? chunk.score : 0);
  current.queryHits.add(queryIndex);
  current.pinned ||= pinned;
  candidates.set(key, current);
}

function addDocumentRanking(
  scores: Map<string, number>,
  items: InboxSearchResult[],
  weight: number,
  input: KnowledgeRetrievalInput,
): void {
  items.forEach((item, rank) => {
    if (!scoped(input, item.id)) return;
    scores.set(item.id, (scores.get(item.id) || 0) + weight / (RRF_K + rank + 1));
  });
}

function metadataRankings(
  store: KnowledgeRetrievalStore,
  input: KnowledgeRetrievalInput,
  scores: Map<string, number>,
): void {
  const plan = input.plan;
  if (!plan) return;
  const searches: InboxSearchOptions[] = [
    ...(plan.domains || []).slice(0, 5).map((domain) => ({ organized: true, domain, limit: 20 })),
    ...(plan.knowledgePoints || []).slice(0, 5).map((knowledgePoint) => ({ organized: true, knowledgePoint, limit: 20 })),
    ...(plan.tools || []).slice(0, 5).map((tool) => ({ organized: true, tool, limit: 20 })),
  ];
  searches.forEach((options) => addDocumentRanking(scores, store.searchInbox("", options), 0.72, input));
}

function candidateScore(candidate: RankedChunk, questionTokens: ReadonlySet<string>): number {
  const chunk = candidate.chunk;
  const overlap = tokenOverlap(questionTokens, `${chunk.title}\n${chunk.heading}\n${chunk.content}`);
  const nativeTieBreak = Math.min(Math.log1p(Math.max(0, candidate.nativeScore)) / 10_000, 0.002);
  return (candidate.pinned ? 1 : 0)
    + candidate.rrfScore
    + candidate.documentScore * 0.55
    + overlap * 0.08
    + Math.min(candidate.queryHits.size, MAX_QUERY_VARIANTS) * 0.0015
    + nativeTieBreak;
}

function selectedChunkText(chunk: KnowledgeChunkSearchResult, maximum: number): string {
  const heading = cleanText(chunk.heading || "正文", 180);
  const content = cleanText(chunk.content, maximum);
  return content ? `## ${heading}\n${content}` : "";
}

function selectDiverseChunks(
  ranked: RankedChunk[],
  questionTokens: ReadonlySet<string>,
  characterBudget: number,
  tokenBudget: number,
  chunkCharacterLimit: number,
): RankedChunk[] {
  const selected: RankedChunk[] = [];
  const selectedKeys = new Set<string>();
  const selectedFingerprints = new Set<string>();
  const perSource = new Map<string, number>();
  const rejectedKeys = new Set<string>();
  const candidateTokenSets = new Map(ranked.map((candidate) => [
    chunkKey(candidate.chunk),
    searchTokens(`${candidate.chunk.heading}\n${candidate.chunk.content}`),
  ]));
  let usedCharacters = 0;
  let usedTokens = 0;

  const trySelect = (candidate: RankedChunk): boolean => {
    const key = chunkKey(candidate.chunk);
    if (selectedKeys.has(key) || (perSource.get(candidate.chunk.messageId) || 0) >= MAX_CHUNKS_PER_SOURCE) return false;
    if (!perSource.has(candidate.chunk.messageId) && perSource.size >= MAX_REFERENCEABLE_SOURCES) return false;
    const text = selectedChunkText(candidate.chunk, chunkCharacterLimit);
    if (!text) return false;
    const fingerprint = cleanText(candidate.chunk.content, 600).replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
    if (fingerprint.length >= 120 && selectedFingerprints.has(fingerprint)) return false;
    const characters = text.length + 180;
    const tokens = estimateEvidenceTokens(text) + 60;
    if (usedCharacters + characters > characterBudget || usedTokens + tokens > tokenBudget) return false;
    selected.push(candidate);
    selectedKeys.add(key);
    if (fingerprint.length >= 120) selectedFingerprints.add(fingerprint);
    perSource.set(candidate.chunk.messageId, (perSource.get(candidate.chunk.messageId) || 0) + 1);
    usedCharacters += characters;
    usedTokens += tokens;
    return true;
  };

  // First pass intentionally favors coverage: one strongest passage from every useful source.
  for (const candidate of ranked) {
    if (perSource.has(candidate.chunk.messageId)) continue;
    trySelect(candidate);
  }

  // Second pass adds complementary passages without allowing one long document to dominate.
  while (true) {
    let best: RankedChunk | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const candidate of ranked) {
      const key = chunkKey(candidate.chunk);
      if (selectedKeys.has(key) || rejectedKeys.has(key)) continue;
      if ((perSource.get(candidate.chunk.messageId) || 0) >= MAX_CHUNKS_PER_SOURCE) continue;
      const tokens = candidateTokenSets.get(key) || new Set<string>();
      const maximumSimilarity = selected.reduce((maximum, item) => Math.max(
        maximum,
        jaccard(tokens, candidateTokenSets.get(chunkKey(item.chunk)) || new Set<string>()),
      ), 0);
      const score = candidateScore(candidate, questionTokens) * (1 - maximumSimilarity * 0.38);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (!best) break;
    if (!trySelect(best)) rejectedKeys.add(chunkKey(best.chunk));
  }
  return selected;
}

export function retrieveKnowledgeEvidence(
  store: KnowledgeRetrievalStore,
  input: KnowledgeRetrievalInput,
): KnowledgeRetrievalResult {
  const characterBudget = Math.max(4_000, Math.min(120_000, Math.floor(input.maxEvidenceCharacters || DEFAULT_CHARACTER_BUDGET)));
  const tokenBudget = Math.max(2_000, Math.min(40_000, Math.floor(input.maxEvidenceTokens || DEFAULT_TOKEN_BUDGET)));
  const chunkCharacterLimit = Math.max(800, Math.min(12_000, Math.floor(input.maxChunkCharacters || DEFAULT_CHUNK_CHARACTER_LIMIT)));
  const includeContext = shouldCarryConversationContext(input.question);
  const queries = uniqueStrings([
    input.question,
    ...(includeContext ? [input.contextualQuestion] : []),
    ...(input.plan?.queries || []),
  ], MAX_QUERY_VARIANTS);
  const candidates = new Map<string, RankedChunk>();
  const documentScores = new Map<string, number>();

  queries.forEach((query, queryIndex) => {
    const queryWeight = queryIndex === 0 ? 1.35 : Math.max(0.72, 1.05 - queryIndex * 0.05);
    store.searchKnowledgeChunks(query, 80).forEach((chunk, rank) => {
      if (scoped(input, chunk.messageId)) addRrfChunk(candidates, chunk, queryIndex, rank, queryWeight);
    });
    addDocumentRanking(documentScores, store.searchInbox(query, { organized: true, limit: 20 }), queryWeight * 0.7, input);
  });
  metadataRankings(store, input, documentScores);

  const pinnedIds = uniqueStrings(input.pinnedMessageIds || [], 100).filter((id) => scoped(input, id));
  const continuityIds = includeContext
    ? uniqueStrings(input.continuityMessageIds || [], 30).filter((id) => scoped(input, id) && !pinnedIds.includes(id))
    : [];
  const enrichDocument = (messageId: string, weight: number, pinned: boolean): void => {
    const chunks = store.knowledgeChunksForMessage(messageId, 12);
    if (!chunks.length) {
      const detail = store.getMessageDetail(messageId);
      const fallback = detail && detail.agentStatus === "completed" ? fallbackChunk(detail) : undefined;
      if (fallback) addRrfChunk(candidates, fallback, queries.length, 0, weight, pinned);
    } else {
      chunks.forEach((chunk, rank) => addRrfChunk(candidates, chunk, queries.length, rank, weight, pinned));
    }
    documentScores.set(messageId, (documentScores.get(messageId) || 0) + weight / (RRF_K + 1));
  };
  pinnedIds.forEach((id) => enrichDocument(id, 8, true));
  continuityIds.forEach((id) => enrichDocument(id, 0.55, false));

  // Metadata/title matches contribute document priors. Pull a small set of their indexed passages
  // so filters can recover evidence even when exact question words are absent from the body.
  Array.from(documentScores.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 60)
    .forEach(([messageId], documentRank) => {
      const chunks = store.knowledgeChunksForMessage(messageId, 6);
      chunks.forEach((chunk, rank) => {
        const key = chunkKey(chunk);
        const current = candidates.get(key) || {
          chunk,
          rrfScore: 0,
          documentScore: 0,
          queryHits: new Set<number>(),
          nativeScore: 0,
          pinned: false,
        };
        current.documentScore += (documentScores.get(messageId) || 0) / (1 + documentRank * 0.04 + rank * 0.08);
        candidates.set(key, current);
      });
    });

  for (const candidate of candidates.values()) {
    candidate.documentScore += documentScores.get(candidate.chunk.messageId) || 0;
  }
  const questionTokens = searchTokens(`${input.contextualQuestion || ""}\n${input.question}`);
  const ranked = Array.from(candidates.values()).sort((left, right) =>
    candidateScore(right, questionTokens) - candidateScore(left, questionTokens)
    || right.queryHits.size - left.queryHits.size
    || left.chunk.ordinal - right.chunk.ordinal,
  );
  const selected = selectDiverseChunks(ranked, questionTokens, characterBudget, tokenBudget, chunkCharacterLimit);
  const grouped = new Map<string, RankedChunk[]>();
  for (const candidate of selected) {
    const current = grouped.get(candidate.chunk.messageId) || [];
    current.push(candidate);
    grouped.set(candidate.chunk.messageId, current);
  }
  const sources = Array.from(grouped.entries()).map(([messageId, items]): KnowledgeEvidenceSource => {
    const chunks = items.map((item) => item.chunk).sort((left, right) => left.ordinal - right.ordinal);
    const first = chunks[0]!;
    const content = chunks.map((chunk) => selectedChunkText(chunk, chunkCharacterLimit)).filter(Boolean).join("\n\n");
    return {
      id: messageId,
      title: first.title || "未命名资料",
      summary: first.summary,
      content,
      excerpt: cleanText(first.content, 500).replace(/\s+/g, " "),
      domains: first.domains,
      knowledgePoints: first.knowledgePoints,
      chunkOrdinals: chunks.map((chunk) => chunk.ordinal),
    };
  });
  const evidenceText = sources.map((source) => `${source.title}\n${source.content}`).join("\n");
  return {
    sources,
    diagnostics: {
      queries,
      candidateChunks: candidates.size,
      candidateDocuments: new Set(Array.from(candidates.values()).map((item) => item.chunk.messageId)).size,
      selectedChunks: selected.length,
      selectedSources: sources.length,
      usedCharacters: evidenceText.length,
      estimatedTokens: estimateEvidenceTokens(evidenceText),
      characterBudget,
      tokenBudget,
    },
  };
}

export function noKnowledgeEvidenceAnswer(scopeLabel: string): string {
  return `当前“${cleanText(scopeLabel || "全部知识库", 120)}”范围内没有找到足够依据回答这个问题。可以换用更明确的主题、人物或工具名称，扩大问答范围，或先把相关资料完成整理。`;
}

export function verifyKnowledgeAnswer(
  answer: string,
  sources: KnowledgeEvidenceSource[],
  modelCitedSourceIds: string[],
): { answer: string; citedSourceIds: string[]; grounded: boolean } {
  const sourceIds = new Set(sources.map((source) => source.id));
  const inlineIds = Array.from(answer.matchAll(/\[S(\d{1,3})\]/g))
    .map((match) => sources[Number(match[1]) - 1]?.id)
    .filter((id): id is string => Boolean(id));
  const citedSourceIds: string[] = [];
  for (const id of [...inlineIds, ...modelCitedSourceIds]) {
    if (!sourceIds.has(id) || citedSourceIds.includes(id)) continue;
    citedSourceIds.push(id);
    if (citedSourceIds.length >= MAX_PERSISTED_CITATIONS) break;
  }
  const retainedIds = new Set(citedSourceIds);
  const cleanedAnswer = answer.replace(/\[S(\d{1,3})\]/g, (marker, rawIndex: string) => {
    const source = sources[Number(rawIndex) - 1];
    return source && retainedIds.has(source.id) ? marker : "";
  }).replace(/[ \t]+\n/g, "\n").trim();
  const refusal = /(?:当前|现有).{0,12}(?:知识库|资料).{0,16}(?:没有|不足|无法找到|未找到).{0,12}(?:依据|证据|信息)/.test(cleanedAnswer);
  if (citedSourceIds.length || refusal) {
    return { answer: cleanedAnswer, citedSourceIds, grounded: citedSourceIds.length > 0 };
  }
  return {
    answer: "已找到可能相关的资料，但模型没有给出可验证的来源引用。为避免生成无依据结论，本次暂不输出答案；请重试或换一种更明确的问法。",
    citedSourceIds: [],
    grounded: false,
  };
}
