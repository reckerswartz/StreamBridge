import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { projectVersion, root } from "./release-utils.mjs";

const exec = promisify(execFile);
const version = await projectVersion();
const archive = resolve(root, `artifacts/streambridge-v${version}-chrome-store.zip`);
const extension = await mkdtemp(resolve(tmpdir(), "streambridge-packaged-chrome-"));
try {
  await exec("unzip", ["-q", archive, "-d", extension]);
  await exec(process.execPath, ["scripts/generate-fixtures.mjs"], { cwd: root });
  const { stdout, stderr } = await exec("npx", ["playwright", "test"], {
    cwd: root,
    env: { ...process.env, STREAMBRIDGE_EXTENSION_DIR: extension },
    maxBuffer: 30 * 1024 * 1024
  });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  console.log("Chrome store ZIP passed the packaged extension E2E flow.");
} finally {
  await rm(extension, { recursive: true, force: true });
}
