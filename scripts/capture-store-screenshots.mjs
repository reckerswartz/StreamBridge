import { chromium } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { root } from "./release-utils.mjs";

const exec = promisify(execFile);
const profile = await mkdtemp(resolve(tmpdir(), "streambridge-safe-screenshots-"));
const assets = resolve(root, "store/assets");
const extension = resolve(root, "dist/chrome");
const sourceUrl = process.env.STREAMBRIDGE_SCREENSHOT_URL || "http://127.0.0.1:8765/demo";
const headed = process.env.HEADED !== "0";
let context;
let fixtureServer;

async function startFixtureServer() {
  if (!sourceUrl.startsWith("http://127.0.0.1:8765/")) return;
  fixtureServer = spawn(process.execPath, ["scripts/fixture-server.mjs"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let diagnostics = "";
  fixtureServer.stdout.on("data", (chunk) => { diagnostics += chunk; });
  fixtureServer.stderr.on("data", (chunk) => { diagnostics += chunk; });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (fixtureServer.exitCode !== null) throw new Error(`Fixture server exited early.\n${diagnostics}`);
    if (await fetch(sourceUrl).then((response) => response.ok, () => false)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  fixtureServer.kill("SIGTERM");
  throw new Error(`Fixture server did not become ready.\n${diagnostics}`);
}

async function waitForOverlay(page) {
  const host = page.locator("#streambridge-host");
  await host.waitFor({ state: "attached", timeout: 45_000 });
  await host.evaluate((element) => element.shadowRoot?.querySelector("#toggle")?.click());
  await page.waitForFunction(() => document.querySelector("#streambridge-host")?.shadowRoot?.querySelector("#panel")?.classList.contains("open"));
  await page.waitForFunction(() => (document.querySelector("#streambridge-host")?.shadowRoot?.querySelector("#count")?.textContent || "0") !== "0");
  return host;
}

try {
  await mkdir(assets, { recursive: true });
  await startFixtureServer();
  await exec(process.execPath, ["scripts/build.mjs"], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: !headed,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  if (!context.serviceWorkers().length) await context.waitForEvent("serviceworker", { timeout: 10_000 });
  const page = context.pages()[0] || await context.newPage();
  await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByRole("button", { name: "Play sample video", exact: true }).click();
  await page.locator("video").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return Boolean(video && video.currentSrc && video.readyState >= 2);
  }, undefined, { timeout: 45_000 });
  const host = await waitForOverlay(page);
  await page.waitForFunction(() => (document.querySelector("video")?.currentTime || 0) > 2, undefined, { timeout: 15_000 });
  await page.screenshot({ path: resolve(assets, "screenshot-detection-1280x800.png") });

  const playerPromise = context.waitForEvent("page", { predicate: (candidate) => candidate.url().includes("/player/index.html") });
  await host.evaluate((element) => {
    const button = [...element.shadowRoot.querySelectorAll("button")].find((item) => item.textContent === "Play in Browser");
    button?.click();
  });
  const player = await playerPromise;
  await player.waitForLoadState("domcontentloaded");
  const start = player.locator("#start-playback");
  if (await start.isVisible({ timeout: 2_000 }).catch(() => false)) await start.click();
  await player.waitForFunction(() => {
    const video = document.querySelector("video");
    return Boolean(video && video.currentTime > 0.25 && video.readyState >= 2);
  }, undefined, { timeout: 30_000 });
  await player.locator("video").evaluate((video) => { video.currentTime = 3; });
  await player.waitForFunction(() => {
    const video = document.querySelector("video");
    return Boolean(video && video.currentTime >= 3 && video.readyState >= 2);
  }, undefined, { timeout: 30_000 });
  await player.waitForTimeout(500);
  await player.screenshot({ path: resolve(assets, "screenshot-browser-player-1280x800.png") });

  await page.setViewportSize({ width: 720, height: 1280 });
  await page.bringToFront();
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(assets, "screenshot-android-720x1280.png") });
  console.log(`Captured safe ${headed ? "headed" : "headless"} listing screenshots from ${sourceUrl}`);
} finally {
  await context?.close();
  fixtureServer?.kill("SIGTERM");
  await rm(profile, { recursive: true, force: true });
}
