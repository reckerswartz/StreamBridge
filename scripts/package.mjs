import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import {
  changelogEntry,
  copyReleaseSource,
  projectVersion,
  root,
  sha256,
  sourceEpoch,
  writeJson,
  zipDirectory
} from "./release-utils.mjs";

const exec = promisify(execFile);
const artifacts = resolve(root, "artifacts");
const staging = resolve(root, ".tmp/release-source");
const version = await projectVersion();
const tag = `v${version}`;
const epoch = await sourceEpoch();
const builtAt = new Date(epoch * 1000).toISOString();

await import("./build.mjs");
await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });

const outputs = [
  { file: `streambridge-${tag}-chrome-store.zip`, browser: "chrome", purpose: "Chrome Web Store upload and developer-mode installation", signed: false },
  { file: `streambridge-${tag}-firefox-store.zip`, browser: "firefox", purpose: "Mozilla Add-ons submission", signed: false }
];

await zipDirectory(resolve(root, "dist/chrome"), resolve(artifacts, outputs[0].file), epoch);
await zipDirectory(resolve(root, "dist/firefox"), resolve(artifacts, outputs[1].file), epoch);

await copyReleaseSource(staging, epoch);
const sourceName = `streambridge-${tag}-source.zip`;
await zipDirectory(staging, resolve(artifacts, sourceName), epoch);
outputs.push({ file: sourceName, browser: "source", purpose: "Mozilla reviewer source and reproducible build input", signed: false });

const storeAssetsName = `streambridge-${tag}-store-assets.zip`;
await zipDirectory(resolve(root, "store/assets"), resolve(artifacts, storeAssetsName), epoch);
outputs.push({ file: storeAssetsName, browser: "stores", purpose: "Store listing icons, screenshots, and promotional images", signed: false });

if (process.env.ANDROID_BRIDGE_RELEASE === "1") {
  for (const name of ["ANDROID_BRIDGE_KEYSTORE", "ANDROID_BRIDGE_KEY_ALIAS", "ANDROID_BRIDGE_KEYSTORE_PASSWORD", "ANDROID_BRIDGE_KEY_PASSWORD"]) {
    if (!process.env[name]) throw new Error(`${name} is required for a signed VLC Bridge release.`);
  }
  await import("./build-android-bridge.mjs");
  const bridgeName = `streambridge-${tag}-vlc-bridge.apk`;
  outputs.push({ file: bridgeName, browser: "android", purpose: "Optional signed Android loopback bridge for site-context playback in official VLC", signed: true });
}

const releaseNotes = await changelogEntry(version);
await writeFile(resolve(artifacts, "RELEASE_NOTES.md"), releaseNotes.body);

const { stdout: sbom } = await exec("npm", ["sbom", "--sbom-format", "spdx"], { cwd: root, maxBuffer: 30 * 1024 * 1024 });
const sbomName = `streambridge-${tag}-sbom.spdx.json`;
await writeFile(resolve(artifacts, sbomName), sbom);
outputs.push({ file: sbomName, browser: "all", purpose: "SPDX dependency inventory", signed: false });

for (const output of outputs) {
  const file = resolve(artifacts, output.file);
  output.sha256 = await sha256(file);
  output.size = (await readFile(file)).byteLength;
}

const { stdout: commit } = await exec("git", ["rev-parse", "HEAD"], { cwd: root });
await writeJson(resolve(artifacts, "release-manifest.json"), {
  schemaVersion: 1,
  name: "StreamBridge",
  version,
  tag,
  commit: commit.trim(),
  builtAt,
  sourceDateEpoch: epoch,
  artifacts: outputs
});

const checksumFiles = [...outputs.map((output) => output.file), "RELEASE_NOTES.md", "release-manifest.json"];
const checksumLines = [];
for (const name of checksumFiles.sort()) checksumLines.push(`${await sha256(resolve(artifacts, name))}  ${basename(name)}`);
await writeFile(resolve(artifacts, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);
await rm(staging, { recursive: true, force: true });
console.log(`Created reproducible ${tag} release assets in artifacts/`);
