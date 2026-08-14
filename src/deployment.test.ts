import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("Docker deployment contract", () => {
  it("publishes the admin service to host interfaces by default", () => {
    const compose = read("compose.yaml");
    expect(compose).toContain('"${KNOWLEDGE_RELAY_BIND_ADDRESS:-0.0.0.0}:${PORT:-8787}:8787"');
    expect(compose).toContain("HOST: 0.0.0.0");
    expect(compose).toContain("PORT: 8787");
  });

  it("documents a configurable Docker bind address", () => {
    expect(read(".env.example")).toContain("KNOWLEDGE_RELAY_BIND_ADDRESS=0.0.0.0");
    expect(read("README.md")).toContain("### 网络绑定");
  });

  it("starts published images before creating a release", () => {
    const workflow = read(".github/workflows/release.yml");
    expect(workflow).toContain("smoke-test:");
    expect(workflow).toContain("http://127.0.0.1:8787/api/bootstrap");
    expect(workflow).toContain("needs: smoke-test");
  });

  it("keeps a fresh runtime healthy before model credentials are configured", () => {
    const hardening = read("scripts/harden-nanobot-config.mjs");
    expect(hardening).toContain("__KNOWLEDGE_RELAY_PROVIDER_NOT_CONFIGURED__");
    expect(read("src/nanobot-config.ts")).toContain("UNCONFIGURED_PROVIDER_KEY");
    expect(read("nanobot/model-catalog.py")).toContain('"not_configured"');
  });

  it("initializes a bind-mounted data directory then runs the app unprivileged", () => {
    const dockerfile = read("Dockerfile");
    const entrypoint = read("scripts/docker-entrypoint.sh");
    expect(dockerfile).toContain('ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]');
    expect(dockerfile).toContain("su-exec");
    expect(entrypoint).toContain('chown -R node:node "$data_dir"');
    expect(entrypoint).toContain('exec su-exec node "$@"');
  });

  it("does not mistake an expected forced Runtime reload for a process crash", () => {
    const supervisor = read("scripts/run-nanobot-runtime.mjs");
    expect(supervisor).toContain("const expectedStops = new WeakSet()");
    expect(supervisor).toContain("expectedStops.add(child)");
    expect(supervisor).toContain("expectedStops.has(child)");
    expect(supervisor).toContain("child.signalCode === null");
  });
});
