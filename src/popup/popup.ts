import browser from "webextension-polyfill";
import { MESSAGE } from "../shared/types";

const count = document.querySelector<HTMLElement>("#count")!;
const countLabel = document.querySelector<HTMLElement>("#count-label")!;
const clear = document.querySelector<HTMLButtonElement>("#clear")!;
const status = document.querySelector<HTMLElement>("#status")!;

async function activeTab(): Promise<browser.Tabs.Tab | undefined> {
  return (await browser.tabs.query({ active: true, currentWindow: true }))[0];
}

async function refresh(): Promise<void> {
  const tab = await activeTab();
  if (!tab?.id) {
    count.textContent = "0";
    countLabel.textContent = "verified streams on this tab";
    clear.disabled = true;
    status.textContent = "Open a web page and start its video to detect a stream.";
    return;
  }
  const response: any = await browser.runtime.sendMessage({ type: MESSAGE.LIST, tabId: tab.id });
  const total = response?.streams?.length || 0;
  count.textContent = String(total);
  countLabel.textContent = total === 1 ? "verified stream on this tab" : "verified streams on this tab";
  clear.disabled = total === 0;
  status.textContent = total === 0 ? "No verified stream yet. Start the video, then check the bottom control." : "Use the bottom control on the page to play, copy, share, or send a stream.";
}

clear.addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab?.id) return;
  await browser.runtime.sendMessage({ type: MESSAGE.CLEAR, tabId: tab.id });
  status.textContent = "Streams cleared for this tab.";
  await refresh();
});

void refresh();
