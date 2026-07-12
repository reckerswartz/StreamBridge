export interface VlcPlaylistOptions {
  streamUrl: string;
  referrerUrl: string;
  userAgent: string;
  title?: string;
}

function singleLine(value: string, maximum: number): string {
  const printable = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
  return printable.replace(/\s+/g, " ").trim().slice(0, maximum);
}

function httpUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("VLC handoff supports only HTTP and HTTPS streams.");
  if (url.username || url.password) throw new Error("VLC handoff does not include URL credentials.");
  return url;
}

export function createVlcPlaylist(options: VlcPlaylistOptions): string {
  const stream = httpUrl(options.streamUrl);
  const referrer = httpUrl(options.referrerUrl);
  const userAgent = singleLine(options.userAgent, 512);
  const title = singleLine(options.title || "StreamBridge stream", 160) || "StreamBridge stream";
  const lines = [
    "#EXTM3U",
    `#EXTVLCOPT:http-referrer=${referrer.origin}/`
  ];
  if (userAgent) lines.push(`#EXTVLCOPT:http-user-agent=${userAgent}`);
  lines.push(`#EXTINF:-1,${title}`, stream.href, "");
  return lines.join("\n");
}

export function vlcPlaylistFilename(label = "stream"): string {
  const safe = singleLine(label, 48).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `streambridge-${safe || "stream"}.m3u`;
}

export function createVlcBridgeUrl(playlist: string): string {
  const bytes = new TextEncoder().encode(playlist);
  if (bytes.length > 65_536) throw new Error("The VLC playlist is too large for the Android bridge link.");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
  return `streambridge-vlc://play?m3u=${encoded}`;
}
