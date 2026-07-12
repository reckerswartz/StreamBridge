import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { root, sha256 } from "./release-utils.mjs";

const exec = promisify(execFile);
const selected = (name) => /-(?:chrome-store|firefox-store|source|store-assets)\.zip$/.test(name);

async function buildHashes() {
  await exec("node", ["scripts/package.mjs"], { cwd: root, maxBuffer: 30 * 1024 * 1024 });
  const names = (await readdir(resolve(root, "artifacts"))).filter(selected).sort();
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await sha256(resolve(root, "artifacts", name))])));
}

const first = await buildHashes();
const second = await buildHashes();
if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error(`Release archives are not reproducible:\n${JSON.stringify({ first, second }, null, 2)}`);
console.log(`Reproducible release archives verified:\n${JSON.stringify(second, null, 2)}`);
