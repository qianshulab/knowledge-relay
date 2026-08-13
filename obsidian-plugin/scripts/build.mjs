import { build } from "esbuild";

await build({
  entryPoints: ["src/main.js"],
  outfile: "main.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2018",
  external: ["obsidian"],
  sourcemap: false,
  minify: false,
  legalComments: "none",
  logLevel: "info",
});
