import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { projectVersion, root, sha256 } from "./release-utils.mjs";

const exec = promisify(execFile);
const version = await projectVersion();
const sourceArchive = resolve(root, "artifacts", `streambridge-v${version}-source.zip`);
const originalArchives = ["chrome-store", "firefox-store"].map((kind) => ({
  kind,
  path: resolve(root, "artifacts", `streambridge-v${version}-${kind}.zip`)
}));
const originalHashes = Object.fromEntries(await Promise.all(originalArchives.map(async ({ kind, path }) => [kind, await sha256(path)])));
const temporary = await mkdtemp(resolve(tmpdir(), "streambridge-reviewer-source-"));
const source = resolve(temporary, "source");

try {
  await exec("unzip", ["-q", sourceArchive, "-d", source]);
  await exec("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: source, maxBuffer: 30 * 1024 * 1024 });
  await exec("npm", ["run", "release:check"], { cwd: source, maxBuffer: 30 * 1024 * 1024 });
  await exec("npm", ["run", "package"], { cwd: source, maxBuffer: 30 * 1024 * 1024 });
  const rebuiltHashes = Object.fromEntries(await Promise.all(originalArchives.map(async ({ kind }) => [
    kind,
    await sha256(resolve(source, "artifacts", `streambridge-v${version}-${kind}.zip`))
  ])));
  if (JSON.stringify(originalHashes) !== JSON.stringify(rebuiltHashes)) {
    throw new Error(`Reviewer source did not reproduce the store archives:\n${JSON.stringify({ originalHashes, rebuiltHashes }, null, 2)}`);
  }
  const metadata = JSON.parse(await readFile(resolve(source, ".streambridge-build.json"), "utf8"));
  console.log(`Reviewer source rebuild verified at commit ${metadata.commit}:\n${JSON.stringify(rebuiltHashes, null, 2)}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
