import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { JwtApiAuth } from "../node_modules/web-ext/lib/util/submit-addon.js";
import { projectVersion, root } from "./release-utils.mjs";

const issuer = process.env.AMO_JWT_ISSUER;
const secret = process.env.AMO_JWT_SECRET;
if (!issuer || !secret) throw new Error("AMO_JWT_ISSUER and AMO_JWT_SECRET are required.");

const addonId = process.env.AMO_ADDON_ID || "streambridge@reckerswartz.github.io";
const version = process.env.STREAMBRIDGE_VERSION || await projectVersion();
const output = resolve(root, process.env.AMO_XPI_OUTPUT || `artifacts/streambridge-v${version}-firefox.xpi`);
const auth = new JwtApiAuth({ apiKey: issuer, apiSecret: secret });
const apiUrl = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(addonId)}/versions/${encodeURIComponent(version)}/`;
const response = await fetch(apiUrl, { headers: { Authorization: await auth.getAuthHeader(), Accept: "application/json" } });
if (!response.ok) throw new Error(`AMO version lookup failed with HTTP ${response.status}.`);
const versionData = await response.json();
if (!versionData.file?.url || versionData.file.status !== "public") throw new Error(`AMO version ${version} is not public yet (status: ${versionData.file?.status || "missing"}).`);
const download = await fetch(versionData.file.url, { headers: { Authorization: await auth.getAuthHeader() } });
if (!download.ok) throw new Error(`Signed XPI download failed with HTTP ${download.status}.`);
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(output, Buffer.from(await download.arrayBuffer()));
console.log(JSON.stringify({ addonId, version, status: "public", output }));
