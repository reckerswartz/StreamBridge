import { chromium } from "@playwright/test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

if (process.env.STREAMBRIDGE_LIVE_SITES !== "1") {
  console.log("Live playback checks are disabled. Set STREAMBRIDGE_LIVE_SITES=1 explicitly.");
  process.exit(0);
}

const root = resolve(import.meta.dirname, "..");
const catalogPath = resolve(root, process.env.STREAMBRIDGE_SITE_FILE || "test/sites.local.json");
await access(catalogPath);
const sites = JSON.parse(await readFile(catalogPath, "utf8")).filter((site) => site.livePlayback === true);
if (!sites.length) throw new Error("No livePlayback entries were found in the local site catalog.");

const generatedAt = new Date().toISOString();
const outputDirectory = resolve(root, ".tmp/live-playback", generatedAt.replaceAll(":", "-"));
const profile = await mkdtemp(resolve(tmpdir(), "streambridge-live-playback-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: process.env.HEADED !== "1",
  args: [
    `--disable-extensions-except=${resolve(root, "dist/chrome")}`,
    `--load-extension=${resolve(root, "dist/chrome")}`,
    "--disable-blink-features=AutomationControlled"
  ]
});
const results = [];
await mkdir(outputDirectory, { recursive: true });

function safeLocation(value) {
  try {
    const url = new URL(value);
    const marker = url.pathname.match(/\/(?:hls|media|streams?|videos?)\//i);
    const path = marker?.index !== undefined ? url.pathname.slice(marker.index) : url.pathname;
    return `${url.host}${path.length > 120 ? `…${path.slice(-119)}` : path}`;
  } catch { return "unavailable"; }
}

function safeError(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/https?:\/\/[^\s"']+/gi, (value) => safeLocation(value))
    .replace(/(authorization|cookie|signature|token)=?[^\s&]*/gi, "$1=[redacted]")
    .slice(0, 220);
}

async function largestVideo(page) {
  let selected = null;
  let selectedArea = 0;
  for (const frame of page.frames()) {
    const choice = await frame.locator("video").evaluateAll((videos) => {
      let best = -1;
      let area = 0;
      videos.forEach((video, candidate) => {
        const rect = video.getBoundingClientRect();
        const ratio = rect.height > 0 ? rect.width / rect.height : 0;
        if (rect.width >= 300 && rect.height >= 168 && ratio >= 1.3 && ratio <= 2.5 && rect.width * rect.height > area) {
          best = candidate;
          area = rect.width * rect.height;
        }
      });
      return { index: best, area };
    }).catch(() => ({ index: -1, area: 0 }));
    if (choice.index >= 0 && choice.area > selectedArea) {
      selectedArea = choice.area;
      selected = { frame, locator: frame.locator("video").nth(choice.index) };
    }
  }
  return selected;
}

async function storedCandidates(worker, pageUrl) {
  return worker.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((item) => item.url === url);
    if (!tab?.id) return [];
    const key = `streams:${tab.id}`;
    const stored = await chrome.storage.session.get(key);
    const streams = Array.isArray(stored[key]) ? stored[key] : [];
    const variants = new Set(streams.flatMap((stream) => (stream.variants || []).map((variant) => variant.url)));
    return streams.filter((stream) => stream.validationStatus === "playable" && !variants.has(stream.url)).map((stream) => ({
      id: stream.id,
      url: stream.url,
      displayUrl: stream.displayUrl,
      kind: stream.kind,
      accessMode: stream.accessMode,
      observedVia: stream.observedVia,
      qualities: (stream.variants || []).map((variant) => variant.quality).filter(Boolean)
    }));
  }, pageUrl);
}

async function applyPreActions(page, actions = []) {
  for (const action of actions) {
    const locator = action.selector
      ? page.locator(action.selector).first()
      : page.getByRole(action.role || "button", { name: new RegExp(action.name, "i") }).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible && action.optional) continue;
    await locator.click({ timeout: 8_000 });
    await page.waitForTimeout(Number(action.waitAfterMs) || 500);
  }
}

try {
  if (!context.serviceWorkers().length) await context.waitForEvent("serviceworker", { timeout: 10_000 });
  const worker = context.serviceWorkers()[0];
  context.on("page", (popup) => {
    void popup.opener().then((opener) => {
      if (!opener) return;
      setTimeout(() => { if (!popup.isClosed() && !popup.url().includes("/player/index.html")) void popup.close(); }, 1_000);
    });
  });

  for (const site of sites) {
    const page = await context.newPage();
    const result = { name: site.name, page: safeLocation(site.url), outcome: "failure", sourceAdvance: 0, resumeAdvance: 0, candidates: [], failures: [] };
    try {
      await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 35_000 });
      await applyPreActions(page, site.preActions);
      await page.waitForTimeout(Number(site.waitBeforePlayMs) || 2_000);
      if (site.playSelector) await page.locator(site.playSelector).first().click({ timeout: 10_000 });
      else {
        const video = await largestVideo(page);
        if (!video) throw new Error("No visible landscape video was found.");
        await video.locator.click({ position: { x: 24, y: 24 } });
      }
      await page.waitForTimeout(Number(site.waitAfterPlayMs) || 15_000);
      const expected = site.expected || {};
      let candidates = await storedCandidates(worker, page.url());
      const expectedCandidates = (values) => values.filter((candidate) => {
        const url = new URL(candidate.url);
        return candidate.kind === (expected.kind || "hls")
          && candidate.accessMode === (expected.accessMode || "site-context")
          && (!expected.candidateHostSuffix || url.hostname.endsWith(expected.candidateHostSuffix))
          && (!expected.candidatePathIncludes || url.pathname.includes(expected.candidatePathIncludes));
      });
      let desired = expectedCandidates(candidates);
      for (let retry = 0; retry < 2 && desired.length < Number(expected.minCandidates || 1); retry += 1) {
        await page.evaluate(() => {
          const button = document.createElement("button");
          button.id = "streambridge-live-rescan";
          button.textContent = "Rescan";
          button.style.cssText = "position:fixed;left:1px;bottom:1px;width:2px;height:2px;opacity:.01;z-index:2147483647";
          document.documentElement.append(button);
        });
        await page.locator("#streambridge-live-rescan").click();
        await page.locator("#streambridge-live-rescan").evaluate((button) => button.remove()).catch(() => undefined);
        await page.waitForTimeout(10_000);
        candidates = await storedCandidates(worker, page.url());
        desired = expectedCandidates(candidates);
      }
      result.candidates = desired.map((candidate) => ({
        kind: candidate.kind,
        accessMode: candidate.accessMode,
        observedVia: candidate.observedVia,
        displayUrl: safeLocation(candidate.url),
        qualities: candidate.qualities
      }));
      if (desired.length < Number(expected.minCandidates || 1)) throw new Error(`Only ${desired.length} expected stream candidates were verified.`);
      const qualities = new Set(desired.flatMap((candidate) => candidate.qualities));
      for (const quality of expected.qualities || []) if (!qualities.has(quality)) throw new Error(`The ${quality} stream quality was not verified.`);
      for (const pattern of expected.forbiddenHostPatterns || []) {
        if (candidates.some((candidate) => new URL(candidate.url).hostname.includes(pattern))) throw new Error(`A forbidden transient host remained: ${pattern}`);
      }
      const video = await largestVideo(page);
      if (!video) throw new Error("The source player was unavailable after capture.");
      await video.locator.evaluate(async (item) => {
        if (item.paused) await item.play();
      });
      await page.waitForTimeout(500);
      const sourceStart = await video.locator.evaluate((item) => item.currentTime);
      await page.waitForTimeout(2_500);
      const sourceEnd = await video.locator.evaluate((item) => item.currentTime);
      result.sourceAdvance = Number((sourceEnd - sourceStart).toFixed(2));
      if (result.sourceAdvance < 1) throw new Error("The source video did not advance.");
      const host = page.locator("#streambridge-host");
      if (!await host.count()) throw new Error("The StreamBridge overlay was not injected.");
      await host.evaluate((element) => element.shadowRoot?.querySelector("#toggle")?.click());
      let overlayText = "";
      for (let attempt = 0; attempt < 20; attempt += 1) {
        overlayText = await host.evaluate((element) => element.shadowRoot?.textContent || "");
        if ((expected.qualities || []).every((quality) => overlayText.includes(quality))) break;
        await page.waitForTimeout(500);
      }
      for (const quality of expected.qualities || []) if (!overlayText.includes(quality)) throw new Error(`The overlay did not show ${quality}.`);
      await video.locator.evaluate((item) => item.pause());
      const pausedAt = await video.locator.evaluate((item) => item.currentTime);
      await host.evaluate((element, quality) => {
        const cards = [...element.shadowRoot.querySelectorAll(".card")];
        const card = cards.find((item) => item.textContent?.toLowerCase().includes(String(quality).toLowerCase())) || cards[0];
        const button = [...card.querySelectorAll("button")].find((item) => item.textContent === "Resume site player");
        button?.click();
      }, expected.resumeQuality || "720p");
      await page.waitForTimeout(2_500);
      result.resumeAdvance = Number(((await video.locator.evaluate((item) => item.currentTime)) - pausedAt).toFixed(2));
      if (result.resumeAdvance < 1) throw new Error("Resume site player did not advance playback.");
      result.outcome = "pass";
    } catch (error) {
      result.failures.push(safeError(error));
    } finally {
      results.push(result);
      await page.close();
    }
    console.log(JSON.stringify({ name: result.name, outcome: result.outcome, candidates: result.candidates.length, sourceAdvance: result.sourceAdvance, resumeAdvance: result.resumeAdvance }));
  }
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}

const reportPath = resolve(outputDirectory, "report.json");
await writeFile(reportPath, `${JSON.stringify({ generatedAt, browser: "Chromium", results }, null, 2)}\n`);
console.log(`Sanitized live playback report: ${reportPath}`);
if (results.some((result) => result.outcome !== "pass")) process.exitCode = 1;
