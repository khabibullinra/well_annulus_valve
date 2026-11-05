// Сборка: bundle.js + копия index.html в dist/ для удобства запуска.
import { build } from "esbuild";
import { mkdirSync, copyFileSync } from "node:fs";

mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/ui/main.ts"],
  bundle: true,
  outfile: "dist/bundle.js",
  format: "iife",
  target: "es2022",
  minify: false,
  sourcemap: false,
  logLevel: "info",
});

copyFileSync("index.html", "dist/index.html");
console.log("build ok: dist/index.html + dist/bundle.js");
