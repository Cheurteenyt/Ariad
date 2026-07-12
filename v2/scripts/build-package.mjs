#!/usr/bin/env node
//
// scripts/build-package.mjs
//
// R168.3: Builds the complete npm package including graph-ui assets.
//
// Pipeline:
//   1. Build graph-ui (npm ci + npm run build)
//   2. Build v2 backend (npm run clean + tsc)
//   3. Copy graph-ui/dist → v2/dist/ui
//   4. Verify dist/ui/index.html exists
//   5. Verify all referenced assets exist
//
// This script is called by `npm run build:package` and `npm run prepack`.
// It ensures that `npm pack` produces a tarball with the UI embedded.
//

import { execSync } from "node:child_process";
import { existsSync, readdirSync, copyFileSync, mkdirSync, statSync, readdir } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GRAPH_UI_DIR = join(REPO_ROOT, "graph-ui");
const V2_DIR = join(REPO_ROOT, "v2");
const GRAPH_UI_DIST = join(GRAPH_UI_DIR, "dist");
const V2_DIST_UI = join(V2_DIR, "dist", "ui");

function run(cmd, cwd, label) {
  console.log(`\n=== ${label} ===`);
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

function copyDirRecursive(src, dest) {
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true });
  }
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

// ── Step 1: Build graph-ui ──────────────────────────────────────────
console.log("\n╔══════════════════════════════════════════════════════════╗");
console.log("║  R168.3 build-package: building complete npm package    ║");
console.log("╚══════════════════════════════════════════════════════════╝");

if (!existsSync(join(GRAPH_UI_DIR, "package.json"))) {
  console.error("ERROR: graph-ui/package.json not found. Run from repo root.");
  process.exit(1);
}

run("npm ci", GRAPH_UI_DIR, "Step 1a: Install graph-ui dependencies (npm ci)");
run("npm run build", GRAPH_UI_DIR, "Step 1b: Build graph-ui");

if (!existsSync(join(GRAPH_UI_DIST, "index.html"))) {
  console.error("ERROR: graph-ui/dist/index.html not found after build.");
  process.exit(1);
}
console.log(`\n✓ graph-ui/dist/index.html exists`);

// ── Step 2: Build v2 backend ────────────────────────────────────────
run("npm run clean", V2_DIR, "Step 2a: Clean v2/dist");
run("npx tsc -p tsconfig.json", V2_DIR, "Step 2b: Compile v2 TypeScript");

if (!existsSync(join(V2_DIR, "dist", "cli", "index.js"))) {
  console.error("ERROR: v2/dist/cli/index.js not found after build.");
  process.exit(1);
}
console.log(`\n✓ v2/dist/cli/index.js exists`);

// ── Step 3: Copy graph-ui/dist → v2/dist/ui ────────────────────────
console.log("\n=== Step 3: Copy graph-ui/dist → v2/dist/ui ===");
copyDirRecursive(GRAPH_UI_DIST, V2_DIST_UI);
console.log(`✓ Copied graph-ui/dist → v2/dist/ui`);

// ── Step 4: Verify dist/ui/index.html ───────────────────────────────
console.log("\n=== Step 4: Verify dist/ui/index.html ===");
if (!existsSync(join(V2_DIST_UI, "index.html"))) {
  console.error("ERROR: v2/dist/ui/index.html not found after copy.");
  process.exit(1);
}
console.log("✓ v2/dist/ui/index.html exists");

// ── Step 5: Verify referenced assets ────────────────────────────────
console.log("\n=== Step 5: Verify assets ===");
const indexHtml = await import("node:fs").then(m => m.readFileSync(join(V2_DIST_UI, "index.html"), "utf-8"));
const assetRefs = indexHtml.match(/src="([^"]+)"/g) ?? [];
const cssRefs = indexHtml.match(/href="([^"]+\.css)"/g) ?? [];
const allRefs = [...assetRefs, ...cssRefs];
let missingAssets = 0;
for (const ref of allRefs) {
  const assetPath = ref.replace(/src="|"|href="/g, "");
  if (assetPath.startsWith("http") || assetPath.startsWith("//")) continue;
  const fullPath = join(V2_DIST_UI, assetPath);
  if (!existsSync(fullPath)) {
    console.error(`  ✗ MISSING: ${assetPath}`);
    missingAssets++;
  } else {
    console.log(`  ✓ ${assetPath}`);
  }
}
if (missingAssets > 0) {
  console.error(`\nERROR: ${missingAssets} asset(s) missing from dist/ui/`);
  process.exit(1);
}

// ── Step 6: List dist/ui contents ───────────────────────────────────
console.log("\n=== Step 6: dist/ui contents ===");
function listDir(dir, prefix = "") {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const isDir = entry.isDirectory();
    console.log(`  ${prefix}${entry.name}${isDir ? "/" : ""}`);
    if (isDir && prefix.length < 2) {
      listDir(join(dir, entry.name), prefix + "  ");
    }
  }
}
listDir(V2_DIST_UI);

console.log("\n╔══════════════════════════════════════════════════════════╗");
console.log("║  build-package complete — package ready for npm pack     ║");
console.log("╚══════════════════════════════════════════════════════════╝");
