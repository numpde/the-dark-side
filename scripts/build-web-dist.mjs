import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const webDir = path.join(repoRoot, "web");
const distDir = path.join(repoRoot, "dist");
const assetsDir = path.join(distDir, "assets");

function rmrf(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function mkdirp(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function copyTree(sourcePath, targetPath) {
  fs.cpSync(sourcePath, targetPath, { recursive: true });
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function writeText(filePath, text) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, text);
}

function relativeAssetPath(fromFilePath, toFilePath) {
  return path.relative(path.dirname(fromFilePath), toFilePath).split(path.sep).join("/");
}

function extractOutputPath(metafile, entryPointPath) {
  const normalizedEntry = path.resolve(entryPointPath);
  for (const [outputPath, outputMeta] of Object.entries(metafile.outputs)) {
    if (outputMeta.entryPoint && path.resolve(outputMeta.entryPoint) === normalizedEntry) {
      return outputPath;
    }
  }
  throw new Error(`No build output found for entry point: ${entryPointPath}`);
}

function replaceModuleScript(html, sourceScriptPath, builtScriptRelativePath) {
  const pattern = new RegExp(
    `<script\\s+type="module"\\s+src="${sourceScriptPath.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}"\\s*><\\/script>`
  );
  if (!pattern.test(html)) {
    throw new Error(`Expected to find module script ${sourceScriptPath} in HTML template`);
  }
  return html.replace(
    pattern,
    `<script type="module" src="${builtScriptRelativePath}"></script>`
  );
}

function assetUrlsPlugin(assetUrlsPath) {
  return {
    name: "asset-urls-alias",
    setup(buildContext) {
      buildContext.onResolve({ filter: /^\.\/asset-urls\.mjs$/ }, (args) => ({
        path: assetUrlsPath,
      }));
    },
  };
}

async function bundleWorker() {
  const result = await build({
    entryPoints: [path.join(webDir, "route-worker.js")],
    outdir: assetsDir,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    entryNames: "[name]-[hash]",
    write: true,
    metafile: true,
    logLevel: "silent",
  });
  return extractOutputPath(result.metafile, path.join(webDir, "route-worker.js"));
}

async function bundleEntry(entryFileName, assetUrlsPath) {
  const result = await build({
    entryPoints: [path.join(webDir, entryFileName)],
    outdir: assetsDir,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    entryNames: "[name]-[hash]",
    write: true,
    metafile: true,
    logLevel: "silent",
    plugins: [assetUrlsPlugin(assetUrlsPath)],
  });
  return extractOutputPath(result.metafile, path.join(webDir, entryFileName));
}

async function main() {
  rmrf(distDir);
  mkdirp(assetsDir);

  const workerOutputPath = await bundleWorker();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "the-dark-side-build-"));
  try {
    const assetUrlsPath = path.join(tempDir, "asset-urls.mjs");
    writeText(
      assetUrlsPath,
      `export const ROUTE_WORKER_URL = ${JSON.stringify(path.basename(workerOutputPath))};\n`
    );

    const appOutputPath = await bundleEntry("app.js", assetUrlsPath);
    const editorOutputPath = await bundleEntry("editor.js", assetUrlsPath);

    copyTree(path.join(webDir, "generated"), path.join(distDir, "generated"));
    copyTree(path.join(webDir, "source"), path.join(distDir, "source"));
    copyTree(path.join(webDir, "styles.css"), path.join(distDir, "styles.css"));
    copyTree(path.join(webDir, "editor.css"), path.join(distDir, "editor.css"));

    const indexHtml = replaceModuleScript(
      readText(path.join(webDir, "index.html")),
      "./app.js",
      relativeAssetPath(path.join(distDir, "index.html"), appOutputPath)
    );
    const editorHtml = replaceModuleScript(
      readText(path.join(webDir, "editor.html")),
      "./editor.js",
      relativeAssetPath(path.join(distDir, "editor.html"), editorOutputPath)
    );
    writeText(path.join(distDir, "index.html"), indexHtml);
    writeText(path.join(distDir, "editor.html"), editorHtml);
  } finally {
    rmrf(tempDir);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
