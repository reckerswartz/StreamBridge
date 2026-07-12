import browser from "webextension-polyfill";
import { MESSAGE } from "../shared/types";

const count = document.querySelector<HTMLElement>("#count")!;
const clear = document.querySelector<HTMLButtonElement>("#clear")!;

async function activeTab(): Promise<browser.Tabs.Tab | undefined> {
  return (await browser.tabs.query({ active: true, currentWindow: true }))[0];
}

async function refresh(): Promise<void> {
  const tab = await activeTab();
  if (!tab?.id) return;
  const response: any = await browser.runtime.sendMessage({ type: MESSAGE.LIST, tabId: tab.id });
  count.textContent = String(response?.streams?.length || 0);
}

clear.addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab?.id) return;
  await browser.runtime.sendMessage({ type: MESSAGE.CLEAR, tabId: tab.id });
  await refresh();
});

void refresh();
