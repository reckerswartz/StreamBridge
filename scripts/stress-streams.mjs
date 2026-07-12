import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = Object.fromEntries(process.argv.slice(2).map((value, index, values) => value.startsWith("--") ? [value.slice(2), values[index + 1]?.startsWith("--") ? "true" : values[index + 1] || "true"] : null).filter(Boolean));
const suite = String(args.suite || process.env.STRESS_SUITE || "control");
const tabLimit = Number(args.tabs || process.env.STRESS_TABS || 15);
const cycles = Number(args.cycles || process.env.STRESS_CYCLES || 3);
const captureSeconds = Number(args.capture || process.env.STRESS_CAPTURE_SECONDS || 8);
const burstSeconds = Number(args.burst || process.env.STRESS_BURST_SECONDS || 60);
const liveSuite = suite === "missav" || suite === "supjav";
const headed = process.env.HEADED === "1" || liveSuite;
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
const reportDirectory = resolve(root, process.env.STRESS_REPORT_DIR || `.tmp/stress/${stamp}`);
const extension = resolve(root, "dist/chrome");
const MIB = 1024 * 1024;

if (!Number.isInteger(tabLimit) || tabLimit < 1 || tabLimit > 30) throw new Error("STRESS_TABS must be between 1 and 30.");
if (!Number.isInteger(cycles) || cycles < 1 || cycles > 10) throw new Error("STRESS_CYCLES must be between 1 and 10.");

function sleep(milliseconds) { return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)); }
function sanitizedUrl(value) { try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return "<invalid-url>"; } }
function sanitize(value) {
  return String(value)
    .replace(/https?:\/\/[^\s"']+/gi, (raw) => sanitizedUrl(raw))
    .replace(/(authorization|cookie|signature|token)=?[^\s&]*/gi, "$1=[redacted]");
}

class CdpClient {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); }
  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolveRequest, rejectRequest } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) rejectRequest(new Error(message.error.message));
      else resolveRequest(message.result);
    };
    await new Promise((resolveOpen, rejectOpen) => { this.socket.onopen = resolveOpen; this.socket.onerror = rejectOpen; });
  }
  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      this.pending.set(id, { resolveRequest, rejectRequest });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.socket?.close(); }
}

async function startFixtureServer() {
  try {
    const response = await fetch("http://127.0.0.1:8765/fixture");
    if (response.ok) return null;
  } catch { /* start below */ }
  const child = spawn(process.execPath, [resolve(root, "scripts/fixture-server.mjs")], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(250);
    try { if ((await fetch("http://127.0.0.1:8765/fixture")).ok) return child; } catch { /* retry */ }
  }
  child.kill("SIGTERM");
  throw new Error("Fixture server did not start.");
}

async function discoverLiveUrls(name) {
  const browser = await chromium.launch({ channel: "chromium", headless: false });
  const page = await browser.newPage();
  try {
    const listing = name === "missav" ? "https://missav.ws/dm265/en" : "https://supjav.com/";
    await page.goto(listing, { waitUntil: "domcontentloaded", timeout: 45_000 });
    for (let attempt = 0; attempt < 24 && /just a moment|checking/i.test(await page.title()); attempt += 1) await sleep(5000);
    const links = name === "missav"
      ? await page.locator("a[href]:has(img)").evaluateAll((items) => items.map((item) => item.href))
      : await page.locator("a[href$='.html']").evaluateAll((items) => items.map((item) => item.href));
    const unique = [];
    const seen = new Set();
    for (const value of links) {
      let url;
      try { url = new URL(value); } catch { continue; }
      const accepted = name === "missav"
        ? (/^\/en\/[a-z0-9-]+$/i.test(url.pathname) || /^\/dm\d+\/en\/[a-z0-9-]+$/i.test(url.pathname))
        : /^\/\d+\.html$/.test(url.pathname);
      if (!accepted || seen.has(url.pathname)) continue;
      seen.add(url.pathname);
      unique.push(url.href);
      if (unique.length === tabLimit) break;
    }
    if (unique.length < tabLimit) throw new Error(`${name} exposed only ${unique.length} usable page URLs.`);
    return unique;
  } finally {
    await browser.close();
  }
}

async function browserProcessMemory(port) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const client = new CdpClient(version.webSocketDebuggerUrl);
  await client.connect();
  try {
    const { processInfo } = await client.request("SystemInfo.getProcessInfo");
    const byType = {};
    for (const process of processInfo) {
      let text;
      try { text = await readFile(`/proc/${process.id}/smaps_rollup`, "utf8"); } catch { continue; }
      const rssKiB = Number(text.match(/^Rss:\s+(\d+)/m)?.[1] || 0);
      const pssKiB = Number(text.match(/^Pss:\s+(\d+)/m)?.[1] || 0);
      const bucket = byType[process.type] ||= { count: 0, rssKiB: 0, pssKiB: 0, cpuTime: 0 };
      bucket.count += 1;
      bucket.rssKiB += rssKiB;
      bucket.pssKiB += pssKiB;
      bucket.cpuTime += Number(process.cpuTime || 0);
    }
    return {
      byType,
      totalRssKiB: Object.values(byType).reduce((sum, item) => sum + item.rssKiB, 0),
      totalPssKiB: Object.values(byType).reduce((sum, item) => sum + item.pssKiB, 0)
    };
  } finally { client.close(); }
}

async function workerMetrics(port, context, extensionId) {
  let targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  let worker = targets.find((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${extensionId}/`));
  let wakePage;
  if (!worker) {
    wakePage = await context.newPage();
    await wakePage.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await sleep(250);
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    worker = targets.find((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${extensionId}/`));
  }
  if (!worker) { await wakePage?.close(); return { available: false }; }
  const client = new CdpClient(worker.webSocketDebuggerUrl);
  await client.connect();
  try {
    await client.request("HeapProfiler.collectGarbage");
    const heap = await client.request("Runtime.getHeapUsage");
    const evaluated = await client.request("Runtime.evaluate", {
      expression: `(async()=>{const all=await chrome.storage.session.get(null);const keys=Object.keys(all);const streamKeys=keys.filter(k=>k.startsWith('streams:'));const playerKeys=keys.filter(k=>k.startsWith('player:'));const candidates=streamKeys.map(k=>Array.isArray(all[k])?all[k].length:0);return {keys:keys.length,streamKeys:streamKeys.length,playerKeys:playerKeys.length,serializedBytes:new TextEncoder().encode(JSON.stringify(all)).length,candidateTotal:candidates.reduce((a,b)=>a+b,0),candidateMax:Math.max(0,...candidates)}})()`,
      awaitPromise: true,
      returnByValue: true
    });
    return { available: true, ...heap, storage: evaluated.result.value };
  } finally { client.close(); await wakePage?.close(); }
}

async function pageMetrics(pages) {
  const totals = { pages: pages.length, jsHeapUsed: 0, jsHeapTotal: 0, nodes: 0, documents: 0 };
  for (const page of pages) {
    if (page.isClosed()) continue;
    try {
      const session = await page.context().newCDPSession(page);
      await session.send("HeapProfiler.collectGarbage");
      await session.send("Performance.enable");
      const { metrics } = await session.send("Performance.getMetrics");
      const values = Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
      totals.jsHeapUsed += Number(values.JSHeapUsedSize || 0);
      totals.jsHeapTotal += Number(values.JSHeapTotalSize || 0);
      totals.nodes += Number(values.Nodes || 0);
      totals.documents += Number(values.Documents || 0);
      await session.detach();
    } catch { /* page may have closed */ }
  }
  return totals;
}

async function largestVideoAction(page, action) {
  return page.evaluate(async (requestedAction) => {
    if (window.streambridgeStress?.[requestedAction]) return window.streambridgeStress[requestedAction]();
    const videos = [...document.querySelectorAll("video")].filter((video) => {
      const rect = video.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).sort((left, right) => {
      const a = left.getBoundingClientRect(); const b = right.getBoundingClientRect();
      return b.width * b.height - a.width * a.height;
    });
    const video = videos[0];
    if (!video) return false;
    if (requestedAction === "start") { video.muted = true; await video.play().catch(() => undefined); }
    else video.pause();
    return true;
  }, action).catch(() => false);
}

async function snapshot(label, pages, port, context, extensionId) {
  const [worker, processes, pageData] = await Promise.all([
    workerMetrics(port, context, extensionId),
    browserProcessMemory(port),
    pageMetrics(pages)
  ]);
  return { label, at: new Date().toISOString(), worker, processes, pages: pageData };
}

function evaluateControlGates(report) {
  const failures = [];
  const baseline = report.snapshots.find((item) => item.label === "baseline");
  const paused = report.snapshots.filter((item) => item.label.endsWith("paused-15"));
  const cleanup = report.snapshots.filter((item) => item.label.endsWith("cleanup-60"));
  const workerPeaks = paused.map((item) => item.worker.usedSize || 0);
  if (Math.max(0, ...workerPeaks) > 12 * MIB) failures.push("Extension worker heap exceeded 12 MiB.");
  if (workerPeaks.length > 1 && workerPeaks.at(-1) - workerPeaks[0] > MIB) failures.push("Retained worker heap grew by more than 1 MiB across cycles.");
  for (const item of paused) if ((item.worker.storage?.serializedBytes || 0) > 2 * MIB) failures.push(`${item.label} session storage exceeded 2 MiB.`);
  for (const item of cleanup) {
    if ((item.worker.storage?.streamKeys || 0) !== 0) failures.push(`${item.label} retained stream session keys.`);
    if ((item.worker.usedSize || 0) > (baseline.worker.usedSize || 0) + 2 * MIB) failures.push(`${item.label} worker heap remained more than 2 MiB above baseline.`);
    const allowanceKiB = Math.max(100 * 1024, Math.round((baseline.processes.totalPssKiB || 0) * 0.2));
    if (item.processes.totalPssKiB > baseline.processes.totalPssKiB + allowanceKiB) failures.push(`${item.label} browser PSS did not recover within budget.`);
  }
  if (report.cycles.some((cycle) => cycle.opened !== tabLimit || cycle.overlayDuplicates > 0)) failures.push("Not all tabs opened cleanly or a duplicate overlay was detected.");
  return failures;
}

async function writeReport(report) {
  await mkdir(reportDirectory, { recursive: true });
  const jsonPath = resolve(reportDirectory, `${suite}.json`);
  const markdownPath = resolve(reportDirectory, `${suite}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = `# StreamBridge ${suite} stress report\n\n- Started: ${report.startedAt}\n- Tabs: ${tabLimit}\n- Cycles: ${cycles}\n- Burst: ${burstSeconds} seconds\n- Result: ${report.failures.length ? "FAIL" : "PASS"}\n\n## Cycle summary\n\n| Cycle | Opened | Verified overlays | Duplicate overlays | Errors |\n|---:|---:|---:|---:|---:|\n${report.cycles.map((cycle) => `| ${cycle.cycle} | ${cycle.opened} | ${cycle.verifiedOverlays} | ${cycle.overlayDuplicates} | ${cycle.errors.length} |`).join("\n")}\n\n## Gate failures\n\n${report.failures.length ? report.failures.map((failure) => `- ${failure}`).join("\n") : "None."}\n`;
  await writeFile(markdownPath, markdown);
  return { jsonPath, markdownPath };
}

let fixtureServer;
let context;
let profile;
try {
  if (suite === "control" || suite === "public") fixtureServer = await startFixtureServer();
  const urls = liveSuite
    ? await discoverLiveUrls(suite)
    : Array.from({ length: tabLimit }, (_, index) => `http://127.0.0.1:8765/stress/${suite}/${index + 1}`);
  profile = await mkdtemp(resolve(tmpdir(), `streambridge-stress-${suite}-`));
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: !headed,
    args: ["--remote-debugging-port=0", "--autoplay-policy=no-user-gesture-required", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 10_000 });
  const extensionId = new URL(worker.url()).host;
  const [port] = String(await readFile(resolve(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/);
  const controller = context.pages()[0] || await context.newPage();
  const report = { suite, startedAt: startedAt.toISOString(), configuration: { tabLimit, cycles, captureSeconds, burstSeconds, headed }, urls: urls.map(sanitizedUrl), snapshots: [], cycles: [], failures: [] };
  report.snapshots.push(await snapshot("baseline", [], port, context, extensionId));

  for (let cycleNumber = 1; cycleNumber <= cycles; cycleNumber += 1) {
    const pages = [];
    const errors = [];
    for (const stage of [1, 5, 10, tabLimit].filter((value, index, values) => value <= tabLimit && values.indexOf(value) === index)) {
      while (pages.length < stage) {
        const batch = urls.slice(pages.length, Math.min(stage, pages.length + 3));
        const opened = await Promise.all(batch.map(async (url) => {
          const page = await context.newPage();
          page.on("pageerror", (error) => errors.push(sanitize(error.message).slice(0, 240)));
          try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }); }
          catch (error) { errors.push(sanitize(error).slice(0, 240)); }
          return page;
        }));
        pages.push(...opened);
      }
      report.snapshots.push(await snapshot(`cycle-${cycleNumber}-open-${stage}`, pages, port, context, extensionId));
    }
    await Promise.all(pages.map((page) => largestVideoAction(page, "start")));
    await sleep(captureSeconds * 1000);
    await Promise.all(pages.map((page) => largestVideoAction(page, "pause")));
    const overlayStates = await Promise.all(pages.map((page) => page.locator("#streambridge-host").evaluateAll((hosts) => ({ hosts: hosts.length, count: Number(hosts[0]?.shadowRoot?.querySelector("#count")?.textContent || 0) })).catch(() => ({ hosts: 0, count: 0 }))));
    report.snapshots.push(await snapshot(`cycle-${cycleNumber}-paused-15`, pages, port, context, extensionId));

    if (cycleNumber === cycles && burstSeconds > 0) {
      await Promise.all(pages.map((page) => largestVideoAction(page, "start")));
      for (let second = 5; second <= burstSeconds; second += 5) {
        await sleep(5000);
        report.snapshots.push(await snapshot(`cycle-${cycleNumber}-burst-${second}`, pages, port, context, extensionId));
      }
      await Promise.all(pages.map((page) => largestVideoAction(page, "pause")));
    }

    report.cycles.push({
      cycle: cycleNumber,
      opened: pages.filter((page) => !page.isClosed()).length,
      verifiedOverlays: overlayStates.filter((state) => state.count > 0).length,
      overlayDuplicates: overlayStates.filter((state) => state.hosts > 1).length,
      errors
    });
    await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
    await sleep(10_000);
    report.snapshots.push(await snapshot(`cycle-${cycleNumber}-cleanup-10`, [], port, context, extensionId));
    await sleep(20_000);
    report.snapshots.push(await snapshot(`cycle-${cycleNumber}-cleanup-30`, [], port, context, extensionId));
    await sleep(30_000);
    report.snapshots.push(await snapshot(`cycle-${cycleNumber}-cleanup-60`, [], port, context, extensionId));
  }
  await controller.close().catch(() => undefined);
  if (suite === "control") report.failures = evaluateControlGates(report);
  const paths = await writeReport(report);
  console.log(JSON.stringify({ suite, result: report.failures.length ? "fail" : "pass", failures: report.failures, reports: paths }));
  if (report.failures.length) process.exitCode = 1;
} finally {
  await context?.close().catch(() => undefined);
  if (profile) await rm(profile, { recursive: true, force: true });
  fixtureServer?.kill("SIGTERM");
}
