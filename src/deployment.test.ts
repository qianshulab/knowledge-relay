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

  it("supports Docker hosts that require sudo without changing project file ownership", () => {
    const deployer = read("scripts/deploy-docker.sh");
    expect(deployer).toContain("sudo docker info");
    expect(deployer).toContain("run_docker compose pull");
    expect(deployer).toContain("run_docker compose up -d --no-build");
    expect(deployer).not.toContain("sudo cp .env.example");
  });

  it("documents a configurable Docker bind address", () => {
    expect(read(".env.example")).toContain("KNOWLEDGE_RELAY_BIND_ADDRESS=0.0.0.0");
    expect(read("README.md")).toContain("### 网络绑定");
  });

  it("provides a persistent, health-checked Docker update path", () => {
    const updater = read("scripts/update-docker.sh");
    expect(read(".env.example")).toContain("KNOWLEDGE_RELAY_IMAGE_TAG=latest");
    expect(updater).toContain('KNOWLEDGE_RELAY_IMAGE_TAG=" image_tag');
    expect(updater).toContain("sudo docker info");
    expect(updater).toContain("run_docker compose pull");
    expect(updater).toContain("run_docker compose up -d --no-build --remove-orphans");
    expect(updater).toContain("http://127.0.0.1:8787/health");
    expect(updater).toContain("http://127.0.0.1:8900/health");
    expect(updater).toContain('"$project_dir/scripts/backup-docker.sh"');
    expect(read("README.md")).toContain("./scripts/update-docker.sh <目标版本号>");
  });

  it("provides consistent backups and a read-only deployment doctor", () => {
    const backup = read("scripts/backup-docker.sh");
    const restore = read("scripts/restore-docker.sh");
    const doctor = read("scripts/doctor-docker.sh");
    expect(backup).toContain("compose stop knowledge-relay nanobot");
    expect(backup).toContain('tar -czf "$target/data.tar.gz" -C /app/data .');
    expect(backup).toContain('tar -czf "$target/nanobot.tar.gz" -C /nanobot .');
    expect(backup).toContain("SHA256SUMS");
    expect(backup).toContain("restart_previous_services");
    expect(restore).toContain("--confirm");
    expect(restore).toContain("sha256sum -c SHA256SUMS");
    expect(restore).toContain("data.before-restore");
    expect(restore).toContain('rm -rf -- "$item"');
    expect(doctor).toContain("compose config --quiet");
    expect(doctor).toContain("http://127.0.0.1:8787/health");
    expect(doctor).toContain("http://127.0.0.1:8902/health");
    expect(doctor).not.toContain("DEEPSEEK_API_KEY");
    expect(read(".gitignore")).toContain("backups/");
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
    expect(supervisor).toContain("expectedStops.add(entry.child)");
    expect(supervisor).toContain("expectedStops.has(child)");
    expect(supervisor).toContain('isolation: "dedicated-runtime-per-tenant"');
    expect(supervisor).toContain('"--workspace", tenantWorkspace');
    expect(supervisor).toContain("const tenantSearchRuntimes = new Map()");
    expect(supervisor).toContain("ensureTenantSearchRuntime");
    expect(supervisor).toContain("searchBrokerServer");
  });

  it("allows long Skill tasks without overstating the basic connection check", () => {
    expect(read(".env.example")).toContain("NANOBOT_PROCESS_IDLE_TIMEOUT_MS=900000");
    expect(read(".env.example")).toContain("NANOBOT_PROCESS_MAX_TIMEOUT_MS=21600000");
    expect(read("nanobot/entrypoint.sh")).toContain('NANOBOT_SERVE_TIMEOUT:-28800');
    expect(read("src/ui.ts")).toContain("检查基础连接");
    expect(read("src/nanobot.ts")).toContain("智能整理任务无进展超时");
  });

  it("packages the pinned original visual Skills in local and Docker runtimes", () => {
    const modules = read(".gitmodules");
    const setup = read("scripts/setup-nanobot.mjs");
    const dockerfile = read("Dockerfile.nanobot");
    const entrypoint = read("nanobot/entrypoint.sh");
    expect(modules).toContain("external-skills/axton-obsidian-visual-skills");
    expect(modules).toContain("https://github.com/axtonliu/axton-obsidian-visual-skills.git");
    expect(setup).toContain("1265976d9746a84858b4b7b42fb86a215aa93de9");
    for (const skill of ["mermaid-visualizer", "obsidian-canvas-creator", "excalidraw-diagram"]) {
      expect(setup).toContain(skill);
      expect(dockerfile).toContain(`skills/${skill}`);
      expect(entrypoint).toContain(skill);
      expect(read(`external-skills/axton-obsidian-visual-skills/${skill}/SKILL.md`).length).toBeGreaterThan(500);
    }
    expect(read("external-skills/axton-obsidian-visual-skills/LICENSE")).toContain("MIT License");
  });
});
