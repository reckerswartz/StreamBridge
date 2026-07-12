import { chromium } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { root } from "./release-utils.mjs";

const exec = promisify(execFile);
const check = process.argv.includes("--check");
const temporary = await mkdtemp(resolve(tmpdir(), "streambridge-assets-"));
const generatedIcons = resolve(temporary, "icons");
const generatedStore = resolve(temporary, "store");
await mkdir(generatedIcons, { recursive: true });
await mkdir(generatedStore, { recursive: true });

async function rasterize(input, size, output) {
  await exec("magick", ["-background", "none", input, "-resize", `${size}x${size}`, "-strip", "-define", "png:exclude-chunk=time,date", `PNG32:${output}`]);
}

for (const size of [16, 32, 48, 64, 96, 128]) {
  await rasterize(resolve(root, "icons/streambridge.svg"), size, resolve(generatedIcons, `streambridge-${size}.png`));
}
await cp(resolve(generatedIcons, "streambridge-128.png"), resolve(generatedStore, "icon-128.png"));

const promoSvg = resolve(temporary, "promo.svg");
await writeFile(promoSvg, `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="280" viewBox="0 0 440 280">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="440" y2="280" gradientUnits="userSpaceOnUse"><stop stop-color="#17132a"/><stop offset="1" stop-color="#30236b"/></linearGradient><linearGradient id="g" x1="10" y1="10" x2="118" y2="118" gradientUnits="userSpaceOnUse"><stop stop-color="#8138ef"/><stop offset="1" stop-color="#1f72ef"/></linearGradient></defs>
  <rect width="440" height="280" rx="28" fill="url(#bg)"/><circle cx="390" cy="35" r="115" fill="#8138ef" opacity=".18"/><circle cx="45" cy="270" r="100" fill="#1f72ef" opacity=".16"/>
  <g transform="translate(32 76)"><rect width="128" height="128" rx="30" fill="url(#g)"/><path d="M53 37v54l44-27-44-27Z" fill="#fff"/><path d="M32 43c-13 12-13 30 0 42M20 31C0 50 0 78 20 97" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" opacity=".9"/></g>
  <text x="184" y="125" fill="#fff" font-family="DejaVu Sans, sans-serif" font-size="36" font-weight="700">StreamBridge</text><text x="186" y="160" fill="#d9d2ff" font-family="DejaVu Sans, sans-serif" font-size="17">Find, verify, and play media URLs</text><text x="186" y="188" fill="#a99de4" font-family="DejaVu Sans, sans-serif" font-size="14">Private by design · No analytics</text>
</svg>`);
await exec("magick", [promoSvg, "-strip", "-define", "png:exclude-chunk=time,date", `PNG32:${resolve(generatedStore, "promo-small-440x280.png")}`]);

if (check) {
  for (const size of [16, 32, 48, 64, 96, 128]) {
    const { stdout } = await exec("magick", ["identify", "-format", "%wx%h", resolve(root, `icons/streambridge-${size}.png`)]);
    if (stdout !== `${size}x${size}`) throw new Error(`streambridge-${size}.png must be ${size}x${size}, got ${stdout}.`);
  }
  for (const [name, dimensions] of [["icon-128.png", "128x128"], ["promo-small-440x280.png", "440x280"], ["screenshot-detection-1280x800.png", "1280x800"]]) {
    const { stdout } = await exec("magick", ["identify", "-format", "%wx%h", resolve(root, "store/assets", name)]);
    if (stdout !== dimensions) throw new Error(`${name} must be ${dimensions}, got ${stdout}.`);
  }
  await rm(temporary, { recursive: true, force: true });
  console.log("Store icons, promotional image, and screenshot dimensions are current.");
  process.exit(0);
}

await mkdir(resolve(root, "icons"), { recursive: true });
await mkdir(resolve(root, "store/assets"), { recursive: true });
for (const size of [16, 32, 48, 64, 96, 128]) await cp(resolve(generatedIcons, `streambridge-${size}.png`), resolve(root, `icons/streambridge-${size}.png`));
for (const name of ["icon-128.png", "promo-small-440x280.png"]) await cp(resolve(generatedStore, name), resolve(root, "store/assets", name));

await exec(process.execPath, ["scripts/generate-fixtures.mjs"], { cwd: root });
await exec(process.execPath, ["scripts/build.mjs"], { cwd: root });
const server = spawn(process.execPath, [resolve(root, "scripts/fixture-server.mjs")], { cwd: root, stdio: "ignore" });
const profile = await mkdtemp(resolve(tmpdir(), "streambridge-assets-profile-"));
let context;
try {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { if ((await fetch("http://127.0.0.1:8765/fixture")).ok) break; } catch { /* retry */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  const extension = resolve(root, "dist/chrome");
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  if (!context.serviceWorkers().length) await context.waitForEvent("serviceworker", { timeout: 10_000 });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:8765/fixture");
  await page.locator("#request-hls").click();
  const host = page.locator("#streambridge-host");
  await host.waitFor({ state: "attached", timeout: 12_000 });
  await host.evaluate((element) => element.shadowRoot.querySelector("#toggle").click());
  await page.screenshot({ path: resolve(root, "store/assets/screenshot-detection-1280x800.png") });
} finally {
  await context?.close();
  server.kill("SIGTERM");
  await rm(profile, { recursive: true, force: true });
  await rm(temporary, { recursive: true, force: true });
}
console.log("Generated manifest icons and clean store listing assets.");
