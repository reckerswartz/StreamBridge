import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { changelogEntry, projectVersion, root } from "./release-utils.mjs";

const version = await projectVersion();
if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error(`Version ${version} is not store-compatible numeric semver.`);

const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
if (lock.version !== version || lock.packages?.[""]?.version !== version) throw new Error("package-lock.json version does not match package.json.");

const manifest = JSON.parse(await readFile(resolve(root, "manifests/base.json"), "utf8"));
if ("version" in manifest) throw new Error("manifests/base.json must receive its version from package.json at build time.");
if (manifest.description.length > 132) throw new Error("Manifest description exceeds the Chrome Web Store 132-character limit.");
if (manifest.permissions.includes("activeTab")) throw new Error("activeTab is redundant when required host access is present.");
for (const size of [16, 32, 48, 64, 96, 128]) {
  if (manifest.icons[String(size)] !== `icons/streambridge-${size}.png`) throw new Error(`Missing ${size}px PNG manifest icon.`);
  await readFile(resolve(root, `icons/streambridge-${size}.png`));
}

await changelogEntry(version);
const explicitTag = process.argv.find((argument) => argument.startsWith("--tag="))?.split("=")[1]
  || (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : "");
if (explicitTag && explicitTag !== `v${version}`) throw new Error(`Release tag ${explicitTag} must equal v${version}.`);

const privacy = await readFile(resolve(root, "PRIVACY.md"), "utf8");
for (const phrase of ["browsing activity", "session", "cookies", "analytics"]) {
  if (!privacy.toLowerCase().includes(phrase)) throw new Error(`PRIVACY.md must explain ${phrase}.`);
}
console.log(`Release metadata is consistent for v${version}.`);
