import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.join(workspaceRoot, "agy-background-wake");
const stagingApp = path.join(workspaceRoot, ".work", "staging", "agy-background-wake-app");
const liveApp =
  process.env.CODEXHOST_LIVE_APP_DIR ??
  "C:\\Users\\cyt4b\\AppData\\Local\\nvm\\v22.22.2\\node_modules\\@codexhost\\cli\\node_modules\\@codexhost\\cli-win32-x64\\app";
const installRecordPath = path.join(workspaceRoot, ".work", "agy-background-wake-install.json");

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function walkRelativeFiles(rootDir, currentDir = rootDir, acc = []) {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkRelativeFiles(rootDir, full, acc);
    } else if (entry.isFile()) {
      acc.push(path.relative(rootDir, full).replaceAll("\\", "/"));
    }
  }
  return acc.sort();
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const stageOnly = args.has("--stage-only");
  const applyOnly = args.has("--apply-only");

  const commit = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();

  if (!applyOnly) {
    console.log(`[1/5] Preparing clean staging directory: ${stagingApp}`);
    rmSync(stagingApp, { recursive: true, force: true });
    mkdirSync(stagingApp, { recursive: true });

    const { buildReleaseHostBundle } = await import(
      pathToFileURL(path.join(repoRoot, "packages/host-runtime/scripts/build-release.mjs")).href
    );
    const { buildPreinstalledHarnessPlugins, preinstalledHarnessPluginPaths } = await import(
      pathToFileURL(path.join(repoRoot, "scripts/release/harness-plugins.mjs")).href
    );
    const { buildDesktopControllerBundle } = await import(
      pathToFileURL(path.join(repoRoot, "packages/desktop-control/scripts/build-release.mjs")).href
    );
    const { buildConsoleServerBundle } = await import(
      pathToFileURL(path.join(repoRoot, "packages/console-server/scripts/build-release.mjs")).href
    );
    const { expectedWebPaths } = await import(
      pathToFileURL(path.join(repoRoot, "scripts/release/web-resources.mjs")).href
    );
    const { writeDistributionMetadata } = await import(
      pathToFileURL(path.join(repoRoot, "scripts/release/distribution-metadata.mjs")).href
    );
    const rootManifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));

    console.log(
      "[2/5] Building release Host, Plugins, Desktop Controller, Console Server & Renderer...",
    );
    await writeDistributionMetadata(path.join(stagingApp, "codexhost-distribution.json"), {
      version: rootManifest.version,
      distribution: "npm",
      target: "windows-x64",
    });
    await buildReleaseHostBundle({
      repositoryRoot: repoRoot,
      outputPath: path.join(stagingApp, "host-runtime.mjs"),
    });
    await buildPreinstalledHarnessPlugins({
      repositoryRoot: repoRoot,
      outputDirectory: path.join(stagingApp, "plugins"),
    });
    await buildDesktopControllerBundle({
      repositoryRoot: repoRoot,
      outputPath: path.join(stagingApp, "desktop-controller.mjs"),
    });
    await buildConsoleServerBundle({
      repositoryRoot: repoRoot,
      outputPath: path.join(stagingApp, "console-server.mjs"),
    });

    const prodRenderer = path.join(repoRoot, "packages/renderer-extension/dist/production.js");
    const consoleRenderer = path.join(repoRoot, "packages/renderer-extension/dist/console.js");
    if (!existsSync(prodRenderer) || !existsSync(consoleRenderer)) {
      throw new Error(
        "Missing built renderer-extension dist files; run npm run build:renderer first",
      );
    }
    cpSync(prodRenderer, path.join(stagingApp, "renderer-extension.js"));
    cpSync(consoleRenderer, path.join(stagingApp, "console-web.js"));

    console.log("[3/5] Building release Web UI + Web Server bundle...");
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "packages/web-server/scripts/build-release.ts",
        "--output",
        stagingApp,
        "--platform",
        "win32",
        "--architecture",
        "x64",
      ],
      { cwd: repoRoot, stdio: "inherit" },
    );

    console.log("[4/5] Validating staged bundle layout...");
    const requiredPaths = [
      "codexhost-distribution.json",
      "host-runtime.mjs",
      "desktop-controller.mjs",
      "console-server.mjs",
      "renderer-extension.js",
      "console-web.js",
      ...preinstalledHarnessPluginPaths("plugins"),
      ...expectedWebPaths({ hostPlatform: "win32", installerArchitecture: "x64" }).map((rel) =>
        rel.replace(/^app\//u, ""),
      ),
    ];
    for (const rel of requiredPaths) {
      const full = path.join(stagingApp, rel);
      if (!existsSync(full)) {
        throw new Error(`Missing required staged release file: ${rel}`);
      }
    }
  }

  if (stageOnly) {
    console.log(`Staging complete for commit ${commit}.`);
    return;
  }

  console.log(`[5/5] Applying staged bundles to live installation: ${liveApp}`);
  if (!existsSync(liveApp)) {
    throw new Error(`Live CodexHost app directory not found: ${liveApp}`);
  }

  const topFiles = [
    "codexhost-distribution.json",
    "host-runtime.mjs",
    "desktop-controller.mjs",
    "console-server.mjs",
    "renderer-extension.js",
    "console-web.js",
    "web-server.mjs",
  ];
  for (const file of topFiles) {
    cpSync(path.join(stagingApp, file), path.join(liveApp, file));
  }

  for (const dir of ["plugins", "web"]) {
    const dest = path.join(liveApp, dir);
    rmSync(dest, { recursive: true, force: true });
    cpSync(path.join(stagingApp, dir), dest, { recursive: true });
  }

  // Sync web-modules file-by-file, skipping identical .node native addons that may be
  // memory-mapped by a running Web server process on Windows.
  const webModulesFiles = walkRelativeFiles(path.join(stagingApp, "web-modules"));
  let skippedIdenticalNativeAddons = 0;
  for (const rel of webModulesFiles) {
    const src = path.join(stagingApp, "web-modules", rel);
    const dst = path.join(liveApp, "web-modules", rel);
    if (rel.endsWith(".node") && existsSync(dst) && sha256File(src) === sha256File(dst)) {
      skippedIdenticalNativeAddons += 1;
      continue;
    }
    mkdirSync(path.dirname(dst), { recursive: true });
    try {
      cpSync(src, dst);
    } catch (error) {
      if (rel.endsWith(".node") && existsSync(dst)) {
        renameSync(dst, `${dst}.old-${Date.now()}`);
        cpSync(src, dst);
      } else {
        throw error;
      }
    }
  }

  // Verify byte-for-byte SHA-256 parity across all staged files vs liveApp
  const stagedAll = walkRelativeFiles(stagingApp);
  for (const rel of stagedAll) {
    const sHash = sha256File(path.join(stagingApp, rel));
    const lHash = sha256File(path.join(liveApp, rel));
    if (sHash !== lHash) {
      throw new Error(`SHA-256 mismatch after apply for ${rel}: ${sHash} !== ${lHash}`);
    }
  }

  const summaryFiles = [
    "codexhost-distribution.json",
    "host-runtime.mjs",
    "desktop-controller.mjs",
    "console-server.mjs",
    "renderer-extension.js",
    "console-web.js",
    "web-server.mjs",
    "plugins/antigravity/plugin.mjs",
    "web-modules/server.mjs",
    "web/index.html",
    "web/plugins.json",
  ];
  const hashes = {};
  for (const rel of summaryFiles) {
    const full = path.join(liveApp, rel);
    hashes[rel] = {
      bytes: statSync(full).size,
      sha256: sha256File(full),
    };
  }

  const record = {
    installedAt: new Date().toISOString(),
    branch: "fork/codex-biground-ver",
    commit,
    liveApp,
    stagingApp,
    totalSyncedFiles: stagedAll.length,
    skippedIdenticalNativeAddons,
    hashes,
  };
  writeFileSync(installRecordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  console.log(
    `Successfully applied and verified ${stagedAll.length} files (commit ${commit}) -> ${liveApp}`,
  );
}

await main();
