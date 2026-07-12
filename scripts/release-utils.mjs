import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const root = resolve(import.meta.dirname, "..");

export async function projectVersion() {
  return JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).version;
}

export async function sourceEpoch() {
  if (/^\d+$/.test(process.env.SOURCE_DATE_EPOCH || "")) return Number(process.env.SOURCE_DATE_EPOCH);
  const { stdout } = await exec("git", ["log", "-1", "--format=%ct"], { cwd: root });
  return Number(stdout.trim());
}

export async function filesBelow(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesBelow(resolve(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

export async function normalizeTree(directory, epoch) {
  const date = new Date(epoch * 1000);
  for (const relative of await filesBelow(directory)) await utimes(resolve(directory, relative), date, date);
}

export async function zipDirectory(directory, destination, epoch) {
  await normalizeTree(directory, epoch);
  const files = await filesBelow(directory);
  if (!files.length) throw new Error(`Cannot create an empty archive from ${directory}`);
  await exec("zip", ["-X", "-q", destination, ...files], { cwd: directory, maxBuffer: 20 * 1024 * 1024 });
}

export async function copyReleaseSource(destination, epoch) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const { stdout } = await exec("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 20 * 1024 * 1024
  });
  const paths = stdout.toString("utf8").split("\0").filter(Boolean).sort();
  for (const relative of paths) {
    const source = resolve(root, relative);
    if (!(await stat(source)).isFile()) continue;
    const target = resolve(destination, relative);
    await mkdir(resolve(target, ".."), { recursive: true });
    await cp(source, target);
  }
  await normalizeTree(destination, epoch);
}

export async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export async function changelogEntry(version) {
  const changelog = await readFile(resolve(root, "CHANGELOG.md"), "utf8");
  const escaped = version.replaceAll(".", "\\.");
  const heading = changelog.match(new RegExp(`^## \\[${escaped}\\] - (\\d{4}-\\d{2}-\\d{2})$`, "m"));
  if (!heading || heading.index === undefined) throw new Error(`CHANGELOG.md has no ${version} release heading.`);
  const start = heading.index + heading[0].length;
  const remainder = changelog.slice(start).replace(/^\n+/, "");
  const nextHeading = remainder.search(/^## \[/m);
  const body = (nextHeading >= 0 ? remainder.slice(0, nextHeading) : remainder).trim();
  if (!body) throw new Error(`CHANGELOG.md has no non-empty ${version} release entry.`);
  return { date: heading[1], body: `# StreamBridge ${version}\n\n${body}\n` };
}

export async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
