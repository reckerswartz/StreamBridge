import browser from "webextension-polyfill";
import { createVlcBridgeUrl, createVlcPlaylist, vlcPlaylistFilename } from "../core/vlc";
import { MESSAGE, type StreamAdapter, type StreamCandidate, type StreamVariant } from "../shared/types";

declare global {
  interface Window {
    __streamBridgeOverlay?: boolean;
  }
}

if (!window.__streamBridgeOverlay) {
  window.__streamBridgeOverlay = true;
  const host = document.createElement("div");
  host.id = "streambridge-host";
  const shadow = host.attachShadow({ mode: "open" });
  document.documentElement.append(host);
  let streams: StreamCandidate[] = [];

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    #root { position: fixed; right: 18px; bottom: max(18px, env(safe-area-inset-bottom)); z-index: 2147483647; font: 14px/1.4 system-ui, sans-serif; color: #f8f7ff; }
    #toggle { width: 58px; height: 58px; margin-left: auto; display: grid; place-items: center; border: 0; border-radius: 50%; background: linear-gradient(135deg,#7337ef,#2469ef); box-shadow: 0 12px 30px #0008; cursor: pointer; }
    #toggle img { width: 34px; height: 34px; }
    #count { position: absolute; right: -4px; top: -4px; min-width: 22px; height: 22px; padding: 2px 6px; border-radius: 12px; background: #ff4f61; color: white; font-weight: 700; font-size: 12px; }
    #panel { display: none; width: min(390px, calc(100vw - 24px)); max-height: min(560px, calc(100vh - 100px)); overflow: auto; margin-bottom: 12px; border: 1px solid #ffffff22; border-radius: 18px; background: #0b1227f7; box-shadow: 0 18px 60px #000a; }
    #panel.open { display: block; }
    header { position: sticky; top: 0; display: flex; justify-content: space-between; align-items: center; padding: 15px 16px; background: #111a36; border-bottom: 1px solid #ffffff18; }
    h2 { margin: 0; font-size: 16px; }
    #close { display: grid; width: 44px; height: 44px; place-items: center; border: 0; border-radius: 10px; background: transparent; color: white; font-size: 24px; cursor: pointer; }
    #close:hover { background: #ffffff12; }
    #list { padding: 10px; }
    .card { padding: 12px; margin-bottom: 9px; border: 1px solid #ffffff1c; border-radius: 13px; background: #152040; }
    .title { font-weight: 700; overflow-wrap: anywhere; }
    .meta { margin: 5px 0 9px; color: #b9c5ee; font-size: 12px; }
    .access { display: inline-block; margin: 0 0 8px; padding: 3px 7px; border-radius: 999px; background: #214b3d; color: #baf7dc; font-size: 11px; font-weight: 800; letter-spacing: .03em; }
    .access.context { background: #59431d; color: #ffe0a3; }
    .access.adapter { background: #283c67; color: #c8d9ff; }
    .warning { margin: 0 0 9px; padding: 8px 9px; border-radius: 9px; background: #ffb02018; color: #ffe0a3; font-size: 12px; }
    .variant { margin-top: 9px; padding-top: 9px; border-top: 1px solid #ffffff18; }
    .actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 7px; }
    .actions button { min-height: 44px; border: 1px solid #7185c9; border-radius: 9px; padding: 9px 12px; background: #263867; color: white; cursor: pointer; font-weight: 600; }
    .actions button.primary { border-color: transparent; background: linear-gradient(135deg,#6c38ed,#2864ed); }
    #status { min-height: 18px; padding: 0 14px 12px; color: #c9d3f8; font-size: 12px; }
    button:focus-visible { outline: 3px solid #cdbdff; outline-offset: 2px; }
    @media (max-width: 520px) { #root { right: 12px; bottom: max(12px, env(safe-area-inset-bottom)); } #toggle { width: 54px; height: 54px; } }
  `;
  shadow.append(style);
  const root = document.createElement("div");
  root.id = "root";
  const panelElement = document.createElement("section");
  panelElement.id = "panel";
  panelElement.setAttribute("aria-labelledby", "streambridge-heading");
  const headerElement = document.createElement("header");
  const heading = document.createElement("h2");
  heading.id = "streambridge-heading";
  heading.textContent = "Verified streams";
  const closeElement = document.createElement("button");
  closeElement.id = "close";
  closeElement.setAttribute("aria-label", "Close");
  closeElement.textContent = "×";
  headerElement.append(heading, closeElement);
  const listElement = document.createElement("div");
  listElement.id = "list";
  const statusElement = document.createElement("div");
  statusElement.id = "status";
  statusElement.setAttribute("role", "status");
  panelElement.append(headerElement, listElement, statusElement);
  const toggleElement = document.createElement("button");
  toggleElement.id = "toggle";
  toggleElement.setAttribute("aria-label", "Open verified streams");
  toggleElement.setAttribute("aria-controls", "panel");
  toggleElement.setAttribute("aria-expanded", "false");
  const iconElement = document.createElement("img");
  iconElement.alt = "";
  iconElement.src = browser.runtime.getURL("icons/streambridge-32.png");
  const countElement = document.createElement("span");
  countElement.id = "count";
  countElement.textContent = "0";
  toggleElement.append(iconElement, countElement);
  root.append(panelElement, toggleElement);
  shadow.append(root);
  const panel = shadow.querySelector<HTMLElement>("#panel")!;
  const list = shadow.querySelector<HTMLElement>("#list")!;
  const count = shadow.querySelector<HTMLElement>("#count")!;
  const status = shadow.querySelector<HTMLElement>("#status")!;

  function bytes(value?: number): string {
    if (!value) return "";
    const units = ["B", "KiB", "MiB", "GiB"];
    let amount = value;
    let index = 0;
    while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
    return `${amount.toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  function setStatus(value: string): void {
    status.textContent = value;
  }

  async function copy(url: string, siteContext = false, adapter?: StreamAdapter): Promise<void> {
    await navigator.clipboard.writeText(url);
    setStatus(adapter ? "Source manifest copied. It requires StreamBridge's browser adapter." : siteContext ? "URL copied. It may require the source website to play." : "Exact portable stream URL copied.");
  }

  async function share(url: string, siteContext = false): Promise<void> {
    if (typeof navigator.share === "function") {
      await navigator.share({ title: "Open stream", url });
      setStatus(siteContext ? "Stream shared with a warning: external playback may require the source site." : "Stream shared.");
      return;
    }
    await copy(url, siteContext);
    setStatus("Sharing is unavailable; URL copied instead.");
  }

  async function resumeSitePlayer(streamId: string): Promise<void> {
    await browser.runtime.sendMessage({ type: MESSAGE.RESUME_SITE_PLAYER, streamId });
    setStatus("The source website player is active.");
  }

  function downloadPlaylist(playlist: string, filename: string, siteContext = false): void {
    const objectUrl = URL.createObjectURL(new Blob([playlist], { type: "application/x-mpegURL" }));
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.hidden = true;
    document.documentElement.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    setStatus(siteContext
      ? "Player playlist downloaded with the source-site header. Open it with StreamBridge VLC Bridge or another compatible player."
      : "Player playlist downloaded. Open it with VLC or another M3U-compatible player.");
  }

  async function shareVlcPlaylist(url: string, label: string, referrerUrl: string): Promise<void> {
    const playlist = createVlcPlaylist({ streamUrl: url, referrerUrl, userAgent: navigator.userAgent, title: label });
    const filename = vlcPlaylistFilename(label);
    if (/Android/i.test(navigator.userAgent)) {
      setStatus("Opening StreamBridge VLC Bridge. Install its APK if Firefox reports no handler.");
      location.assign(createVlcBridgeUrl(playlist));
      return;
    }
    if (typeof navigator.share === "function") {
      for (const type of ["application/x-mpegURL", "text/plain"]) {
        const file = new File([playlist], filename, { type });
        if (typeof navigator.canShare === "function" && !navigator.canShare({ files: [file] })) continue;
        try {
          setStatus("Choose StreamBridge VLC Bridge from the Android share sheet.");
          await navigator.share({ title: "Open StreamBridge stream through VLC Bridge", files: [file] });
          setStatus("Playlist sent. VLC Bridge will open VLC automatically.");
          return;
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") throw error;
        }
      }
      try {
        setStatus("Choose StreamBridge VLC Bridge from the Android share sheet.");
        await navigator.share({ title: "Open StreamBridge stream through VLC Bridge", text: playlist });
        setStatus("Playlist sent. VLC Bridge will open VLC automatically.");
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
      }
    }
    downloadPlaylist(playlist, filename, true);
  }

  async function sendToPlayer(url: string, label: string, siteContext: boolean, referrerUrl: string): Promise<void> {
    if (siteContext) return shareVlcPlaylist(url, label, referrerUrl);
    if (/Android/i.test(navigator.userAgent) && typeof navigator.share === "function") {
      setStatus("Choose a media player from the Android share sheet.");
      await navigator.share({ title: "Open StreamBridge stream", url });
      setStatus("Stream sent to the selected app.");
      return;
    }
    const playlist = createVlcPlaylist({ streamUrl: url, userAgent: navigator.userAgent, title: label });
    downloadPlaylist(playlist, vlcPlaylistFilename(label));
  }

  function actions(url: string, siteContext: boolean, adapter: StreamAdapter | undefined, label: string, streamId: string, referrerUrl: string): HTMLElement {
    const container = document.createElement("div");
    container.className = "actions";
    const primary: [string, string, () => Promise<unknown>] =
      siteContext
        ? ["Resume site player", "primary", () => resumeSitePlayer(streamId)]
        : ["Play in Browser", "primary", () => browser.runtime.sendMessage({ type: MESSAGE.OPEN_PLAYER, url })];
    const definitions: Array<[string, string, () => Promise<unknown>]> = adapter
      ? [primary, ["Copy source URL", "", () => copy(url, siteContext, adapter)]]
      : [
          primary,
          ["Send to player", "", () => sendToPlayer(url, label, siteContext, referrerUrl)],
          ["Copy URL", "", () => copy(url, siteContext)],
          ["Share", "", () => share(url, siteContext)]
        ];
    for (const [label, className, handler] of definitions) {
      const button = document.createElement("button");
      button.textContent = label;
      button.className = className;
      button.addEventListener("click", () => void handler().catch((error) => setStatus(error instanceof Error ? error.message : "Action failed.")));
      container.append(button);
    }
    return container;
  }

  function renderVariant(variant: StreamVariant, stream: StreamCandidate, siteContext: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "variant";
    const dimensions = variant.width && variant.height ? `${variant.width}×${variant.height}` : "";
    const resolution = [variant.quality, dimensions].filter((value, index, values) => value && values.indexOf(value) === index).join(" · ") || "Variant";
    const bitrate = variant.bandwidth ? `${(variant.bandwidth / 1_000_000).toFixed(1)} Mbps` : "";
    const variantTitle = document.createElement("div");
    variantTitle.className = "title";
    variantTitle.textContent = resolution;
    const variantMeta = document.createElement("div");
    variantMeta.className = "meta";
    variantMeta.textContent = [bitrate, variant.estimatedBytes ? `~${bytes(variant.estimatedBytes)}` : ""].filter(Boolean).join(" · ");
    row.append(variantTitle, variantMeta, actions(variant.url, siteContext, stream.adapter, resolution, stream.id, stream.sourceDocumentUrl || location.href));
    return row;
  }

  function render(): void {
    count.textContent = String(streams.length);
    list.replaceChildren();
    for (const stream of streams) {
      const card = document.createElement("article");
      card.className = "card";
      const meta = [stream.kind.toUpperCase(), stream.container, stream.exactBytes ? bytes(stream.exactBytes) : "", stream.durationSeconds ? `${Math.round(stream.durationSeconds)} sec` : ""].filter(Boolean).join(" · ");
      const cardTitle = document.createElement("div");
      cardTitle.className = "title";
      cardTitle.textContent = stream.displayUrl;
      const cardMeta = document.createElement("div");
      cardMeta.className = "meta";
      cardMeta.textContent = meta;
      const siteContext = stream.accessMode === "site-context";
      const access = document.createElement("div");
      access.className = `access${siteContext ? " context" : stream.adapter ? " adapter" : ""}`;
      access.textContent = siteContext ? "Site-context" : stream.adapter ? "Browser adapter" : "Portable";
      card.append(cardTitle, cardMeta, access);
      if (siteContext) {
        const warning = document.createElement("p");
        warning.className = "warning";
        warning.textContent = "This stream needs the source website's request context. A copied or shared URL may fail in another player or browser.";
        card.append(warning);
      } else if (stream.adapter) {
        const warning = document.createElement("p");
        warning.className = "warning";
        warning.textContent = "This source uses transformed segments. Play it in StreamBridge; the copied manifest is not independently playable.";
        card.append(warning);
      }
      card.append(actions(stream.url, siteContext, stream.adapter, stream.displayUrl, stream.id, stream.sourceDocumentUrl || location.href));
      for (const variant of stream.variants) card.append(renderVariant(variant, stream, siteContext));
      list.append(card);
    }
  }

  async function refreshStreams(): Promise<void> {
    const response = await browser.runtime.sendMessage({ type: MESSAGE.LIST }) as { streams?: StreamCandidate[] } | undefined;
    streams = response?.streams || [];
    render();
  }

  function setPanelOpen(open: boolean): void {
    panel.classList.toggle("open", open);
    toggleElement.setAttribute("aria-expanded", String(open));
    toggleElement.setAttribute("aria-label", open ? "Close verified streams" : "Open verified streams");
    if (open) {
      void refreshStreams().catch(() => undefined);
      closeElement.focus();
    } else {
      toggleElement.focus();
    }
  }

  toggleElement.addEventListener("click", () => setPanelOpen(!panel.classList.contains("open")));
  closeElement.addEventListener("click", () => setPanelOpen(false));
  shadow.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Escape" && panel.classList.contains("open")) setPanelOpen(false);
  });
  browser.runtime.onMessage.addListener((message: any) => {
    if (message?.type !== MESSAGE.OVERLAY_UPDATE) return;
    streams = message.streams || [];
    render();
  });
  void refreshStreams().catch(() => undefined);
}
