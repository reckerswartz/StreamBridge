import { GoogleAuth } from "google-auth-library";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { projectVersion, root } from "./release-utils.mjs";

const publisherId = process.env.CWS_PUBLISHER_ID;
const extensionId = process.env.CWS_EXTENSION_ID;
const credentialsJson = process.env.CWS_SERVICE_ACCOUNT_JSON;
if (!publisherId || !extensionId || !credentialsJson) throw new Error("CWS_PUBLISHER_ID, CWS_EXTENSION_ID, and CWS_SERVICE_ACCOUNT_JSON are required.");

const version = await projectVersion();
const packageFile = resolve(root, process.env.CWS_PACKAGE || `artifacts/streambridge-v${version}-chrome-store.zip`);
const credentials = JSON.parse(credentialsJson);
const auth = new GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/chromewebstore"] });
const client = await auth.getClient();
const tokenResult = await client.getAccessToken();
const token = typeof tokenResult === "string" ? tokenResult : tokenResult?.token;
if (!token) throw new Error("Chrome Web Store service account did not return an access token.");

const base = `https://chromewebstore.googleapis.com/v2/publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}`;
const upload = await fetch(`https://chromewebstore.googleapis.com/upload/v2/publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}:upload`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/zip" },
  body: await readFile(packageFile)
});
const uploadData = await upload.json().catch(() => ({}));
if (!upload.ok) throw new Error(`Chrome Web Store upload failed with HTTP ${upload.status}: ${JSON.stringify(uploadData)}`);

let statusData = uploadData;
for (let attempt = 0; attempt < 30 && /IN_PROGRESS/i.test(String(statusData.uploadState || statusData.state || "")); attempt += 1) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 10_000));
  const status = await fetch(`${base}:fetchStatus`, { headers: { Authorization: `Bearer ${token}` } });
  statusData = await status.json().catch(() => ({}));
  if (!status.ok) throw new Error(`Chrome Web Store status check failed with HTTP ${status.status}.`);
}
if (/FAIL|ERROR/i.test(String(statusData.uploadState || statusData.state || ""))) throw new Error(`Chrome Web Store rejected the upload: ${JSON.stringify(statusData)}`);

const publish = await fetch(`${base}:publish`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
const publishData = await publish.json().catch(() => ({}));
if (!publish.ok) throw new Error(`Chrome Web Store publish request failed with HTTP ${publish.status}: ${JSON.stringify(publishData)}`);
console.log(JSON.stringify({ extensionId, version, uploadState: statusData.uploadState || statusData.state, publishState: publishData.state || "submitted" }));
