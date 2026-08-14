import { describe, expect, it } from "vitest";

import { compactKnowledgePoint } from "./semantic-labels.js";

describe("knowledge point labels", () => {
  it("从模型返回的解释句中保留可复用概念名", () => {
    expect(compactKnowledgePoint("6 阶段侦察方法论：按子域、端口和参数逐层展开攻击面。"))
      .toBe("6 阶段侦察方法论");
    expect(compactKnowledgePoint("Agentic Red Teaming(自主红队): 由 AI 智能体自动执行攻击链。"))
      .toBe("Agentic Red Teaming(自主红队)");
    expect(compactKnowledgePoint("Neo4j 知识图谱用于攻击面建模并支持自然语言查询"))
      .toBe("Neo4j 知识图谱");
  });
});
