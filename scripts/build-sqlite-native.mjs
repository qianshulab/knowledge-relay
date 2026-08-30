import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(projectRoot, "node_modules", "better-sqlite3");
const nodeAddonApiRoot = join(projectRoot, "node_modules", "node-addon-api");
const nodeGyp = join(projectRoot, "node_modules", "node-gyp", "bin", "node-gyp.js");

if (!existsSync(packageRoot) || !existsSync(nodeAddonApiRoot) || !existsSync(nodeGyp)) {
  throw new Error("缺少 better-sqlite3、node-addon-api 或 node-gyp，请先运行 npm ci");
}

// node-gyp-generated makefiles do not consistently quote dependency paths.
// Build in an isolated path so source deployments also work from directories
// that contain spaces or non-ASCII characters.
const stagingRoot = mkdtempSync(join(tmpdir(), "knowledge-relay-sqlite-"));
const stagingModules = join(stagingRoot, "node_modules");
const stagingPackage = join(stagingModules, "better-sqlite3");

try {
  mkdirSync(stagingModules, { recursive: true });
  cpSync(packageRoot, stagingPackage, { recursive: true });
  cpSync(nodeAddonApiRoot, join(stagingModules, "node-addon-api"), { recursive: true });

  for (const args of [["clean"], ["rebuild", "--release", "--force_build=1"]]) {
    const result = spawnSync(process.execPath, [nodeGyp, ...args], {
      cwd: stagingPackage,
      stdio: "inherit",
    });

    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }

  rmSync(join(packageRoot, "build"), { recursive: true, force: true });
  cpSync(join(stagingPackage, "build"), join(packageRoot, "build"), { recursive: true });

  // better-sqlite3 defaults to bundled prebuilds before build/Release. Removing
  // them guarantees that verification and production load the just-built addon.
  rmSync(join(packageRoot, "prebuilds"), { recursive: true, force: true });
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}
