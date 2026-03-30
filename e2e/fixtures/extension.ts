import { test as base, chromium, type BrowserContext } from "@playwright/test";
import path from "path";

const EXTENSION_PATH = path.join(__dirname, "../../extension");
const BACKEND_URL = "http://localhost:3001";

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  backendUrl: string;
}>({
  // Launch Chromium with the lele extension loaded
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });
    await use(context);
    await context.close();
  },

  // Extract the extension ID from its service worker URL
  extensionId: async ({ context }, use) => {
    let sw = context.serviceWorkers()[0];
    if (!sw) {
      [sw] = await Promise.all([
        context.waitForEvent("serviceworker"),
      ]);
    }
    const id = sw.url().split("/")[2];
    await use(id);
  },

  backendUrl: async ({}, use) => {
    await use(BACKEND_URL);
  },
});

export { expect } from "@playwright/test";
