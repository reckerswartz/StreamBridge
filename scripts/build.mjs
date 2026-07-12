import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const targets = ["chrome", "firefox"];
await rm(dist, { recursive: true, force: true });

const baseManifest = JSON.parse(await readFile(resolve(root, "manifests/base.json"), "utf8"));

for (const target of targets) {
  const output = resolve(dist, target);
  await mkdir(resolve(output, "popup"), { recursive: true });
  await mkdir(resolve(output, "player"), { recursive: true });
  await mkdir(resolve(output, "icons"), { recursive: true });
  await Promise.all([
    cp(resolve(root, "src/popup/index.html"), resolve(output, "popup/index.html")),
    cp(resolve(root, "src/popup/popup.css"), resolve(output, "popup/popup.css")),
    cp(resolve(root, "src/player/index.html"), resolve(output, "player/index.html")),
    cp(resolve(root, "src/player/player.css"), resolve(output, "player/player.css")),
    cp(resolve(root, "icons/streambridge.svg"), resolve(output, "icons/streambridge.svg")),
    cp(resolve(root, "LICENSE"), resolve(output, "LICENSE"))
  ]);
  await build({
    entryPoints: {
      background: resolve(root, "src/background.ts"),
      "content-overlay": resolve(root, "src/content/overlay.ts"),
      "popup/popup": resolve(root, "src/popup/popup.ts"),
      "player/player": resolve(root, "src/player/player.ts")
    },
    outdir: output,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: target === "chrome" ? "chrome120" : "firefox140",
    minify: false,
    sourcemap: false,
    legalComments: "none"
  });
  const manifest = structuredClone(baseManifest);
  if (target === "chrome") {
    manifest.background = { service_worker: "background.js" };
  } else {
    manifest.background = { scripts: ["background.js"] };
    manifest.browser_specific_settings = {
      gecko: {
        id: "streambridge@reckerswartz.github.io",
        strict_min_version: "140.0",
        data_collection_permissions: { required: ["none"] }
      },
      gecko_android: { strict_min_version: "142.0" }
    };
  }
  await writeFile(resolve(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log("Built dist/chrome and dist/firefox");
