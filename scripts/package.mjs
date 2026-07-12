import { mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const artifacts = resolve(root, "artifacts");
await import("./build.mjs");
await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });

async function command(program, args, cwd) {
  await new Promise((resolveCommand, reject) => {
    const child = spawn(program, args, { cwd, stdio: "inherit" });
    child.on("exit", (code) => code === 0 ? resolveCommand() : reject(new Error(`${program} exited ${code}`)));
    child.on("error", reject);
  });
}

await command("zip", ["-qr", resolve(artifacts, "streambridge-0.1.0-chrome.zip"), "."], resolve(root, "dist/chrome"));
await command("zip", ["-qr", resolve(artifacts, "streambridge-0.1.0-firefox.zip"), "."], resolve(root, "dist/firefox"));
console.log("Created Chrome and Firefox packages in artifacts/");
