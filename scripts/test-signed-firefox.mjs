import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const xpi = resolve(process.argv[2] || process.env.FIREFOX_XPI || "");
if (!process.argv[2] && !process.env.FIREFOX_XPI) throw new Error("Pass a signed XPI path or set FIREFOX_XPI.");
await access(xpi);
const profile = await mkdtemp(resolve(tmpdir(), "streambridge-signed-profile-"));
const port = Number(process.env.GECKODRIVER_PORT || 4447);
const geckodriver = process.env.GECKODRIVER_BIN || "geckodriver";
const driver = spawn(geckodriver, ["--port", String(port), "--log", "error"], { stdio: ["ignore", "pipe", "pipe"] });
let driverLog = "";
driver.stdout.on("data", (chunk) => { driverLog += chunk; });
driver.stderr.on("data", (chunk) => { driverLog += chunk; });
const endpoint = `http://127.0.0.1:${port}`;

async function request(path, method = "GET", body) {
  const response = await fetch(`${endpoint}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.value?.error) throw new Error(`WebDriver ${method} ${path} failed: ${JSON.stringify(data)}`);
  return data.value;
}

async function session() {
  const value = await request("/session", "POST", { capabilities: { alwaysMatch: {
    browserName: "firefox",
    "moz:firefoxOptions": { args: ["-headless", "-profile", profile] }
  } } });
  return value.sessionId;
}

async function addonState(sessionId) {
  await request(`/session/${sessionId}/moz/context`, "POST", { context: "chrome" });
  return request(`/session/${sessionId}/execute/async`, "POST", {
    script: `const done=arguments[arguments.length-1];ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs').AddonManager.getAddonByID('streambridge@reckerswartz.github.io').then(addon=>done(addon?{id:addon.id,active:addon.isActive,temporary:addon.temporarilyInstalled}:null),error=>done({error:String(error)}));`,
    args: []
  });
}

try {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { if ((await fetch(`${endpoint}/status`)).ok) break; } catch { /* retry */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  const first = await session();
  const installedId = await request(`/session/${first}/moz/addon/install`, "POST", { path: xpi, temporary: false });
  if (installedId !== "streambridge@reckerswartz.github.io") throw new Error(`Unexpected installed add-on ID: ${installedId}`);
  const firstState = await addonState(first);
  if (!firstState?.active || firstState.temporary) throw new Error(`Signed add-on is not persistently active: ${JSON.stringify(firstState)}`);
  await request(`/session/${first}`, "DELETE");

  const second = await session();
  const secondState = await addonState(second);
  if (!secondState?.active || secondState.temporary) throw new Error(`Signed add-on did not survive restart: ${JSON.stringify(secondState)}`);
  await request(`/session/${second}`, "DELETE");
  console.log(JSON.stringify({ installedId, persistentAfterRestart: true }));
} finally {
  driver.kill("SIGTERM");
  await rm(profile, { recursive: true, force: true });
  if (driver.exitCode && !driver.killed) console.error(driverLog.slice(-2000));
}
