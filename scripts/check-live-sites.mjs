import { chromium } from "@playwright/test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

if (process.env.STREAMBRIDGE_LIVE_SITES !== "1") {
  console.log("Live-site checks are disabled. Set STREAMBRIDGE_LIVE_SITES=1 explicitly.");
  process.exit(0);
}

const root = resolve(import.meta.dirname, "..");
const catalog = resolve(root, process.env.STREAMBRIDGE_SITE_FILE || "test/sites.local.json");
await access(catalog);
const sites = JSON.parse(await readFile(catalog, "utf8"));
const profile = await mkdtemp(resolve(tmpdir(), "streambridge-live-"));
const extension = resolve(root, "dist/chrome");
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: process.env.HEADED !== "1",
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
});

function sanitized(value) {
  return String(value)
    .replace(/https?:\/\/[^\s"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        return `${url.origin}${url.pathname}`;
      } catch {
        return "<url-redacted>";
      }
    })
    .replace(/(authorization|cookie|signature|token)=?[^\s&]*/gi, "$1=[redacted]");
}

try {
  if (!context.serviceWorkers().length) await context.waitForEvent("serviceworker", { timeout: 10_000 });
  for (const site of sites) {
    const page = await context.newPage();
    const errors = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(sanitized(message.text()).slice(0, 200)); });
    await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (site.playSelector) {
      await page.locator(site.playSelector).first().click({ timeout: 15_000 });
    } else {
      const video = page.locator("video").first();
      if (await video.count()) await video.click({ position: { x: 20, y: 20 } }).catch(() => undefined);
    }
    await page.waitForTimeout(Number(site.waitAfterPlayMs) || 5000);
    const result = await page.locator("#streambridge-host").evaluate((host) => ({
      count: host.shadowRoot?.querySelector("#count")?.textContent || "0",
      text: (host.shadowRoot?.querySelector("#list")?.textContent || "").slice(0, 500)
    })).catch(() => ({ count: "0", text: "" }));
    const target = new URL(site.url);
    console.log(JSON.stringify({
      name: site.name,
      page: `${target.host}${target.pathname}`,
      verifiedCount: Number(result.count),
      overlaySummary: sanitized(result.text),
      consoleErrors: errors
    }));
    await page.close();
  }
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
