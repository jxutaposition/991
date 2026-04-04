import { test as extensionTest } from "./extension";

const MOCK_BACKEND_URL = "http://localhost:3001";

export interface RecordedData {
  events: Array<{
    event_type: string;
    url: string;
    domain: string;
    sequence_number: number;
    timestamp: number;
    dom_context: {
      element_type: string;
      element_text: string;
      element_id: string | null;
      visible_text_nearby: string;
    } | null;
    screenshot_b64: string | null;
  }>;
  screenshots: Array<{
    timestamp: number;
    base64: string;
    base64_length: number;
    session_id: string;
  }>;
  sessions: Record<
    string,
    {
      expert_id: string;
      started_at: number;
      ended: boolean;
      events: any[];
      screenshots: any[];
    }
  >;
  flushLog: Array<{
    session_id: string;
    event_count: number;
    screenshot_count: number;
    timestamp: number;
  }>;
}

const EMPTY_DATA: RecordedData = {
  events: [],
  screenshots: [],
  sessions: {},
  flushLog: [],
};

async function fetchJson(
  path: string,
  init?: RequestInit,
  retries = 3,
): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${MOCK_BACKEND_URL}${path}`, init);
      const text = await res.text();
      if (!text) return { ...EMPTY_DATA };
      return JSON.parse(text);
    } catch (err) {
      if (i === retries - 1) {
        console.error(
          `[mock-backend] fetchJson failed after ${retries} retries: ${path}`,
          err,
        );
        return { ...EMPTY_DATA };
      }
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return { ...EMPTY_DATA };
}

export const test = extensionTest.extend<{
  getRecordedData: () => Promise<RecordedData>;
  resetBackend: () => Promise<void>;
  startRecording: (
    context: import("@playwright/test").BrowserContext,
    extensionId: string,
  ) => Promise<string>;
  stopRecording: (
    context: import("@playwright/test").BrowserContext,
    extensionId: string,
  ) => Promise<void>;
  waitForFlush: (ms?: number) => Promise<void>;
}>({
  getRecordedData: async ({}, use) => {
    await use(async () => {
      return (await fetchJson("/api/test/events")) as RecordedData;
    });
  },

  resetBackend: async ({}, use) => {
    await use(async () => {
      await fetchJson("/api/test/reset", { method: "POST" });
    });
  },

  startRecording: async ({}, use) => {
    await use(async (context, extensionId) => {
      const sidepanel = await context.newPage();
      await sidepanel.goto(
        `chrome-extension://${extensionId}/sidepanel.html`,
      );
      await sidepanel.waitForLoadState("domcontentloaded");

      const recordBtn = sidepanel.getByRole("button", { name: /record/i });
      await recordBtn.waitFor({ state: "visible", timeout: 5000 });
      await recordBtn.click();
      await sidepanel.waitForTimeout(2000);

      return sidepanel.url();
    });
  },

  stopRecording: async ({}, use) => {
    await use(async (context, extensionId) => {
      const pages = context.pages();
      let sidepanel = pages.find((p) =>
        p.url().includes("sidepanel.html"),
      );
      if (!sidepanel) {
        sidepanel = await context.newPage();
        await sidepanel.goto(
          `chrome-extension://${extensionId}/sidepanel.html`,
        );
        await sidepanel.waitForLoadState("domcontentloaded");
      }
      const stopBtn = sidepanel.getByRole("button", { name: /stop/i });
      if (
        await stopBtn
          .isVisible({ timeout: 3000 })
          .catch(() => false)
      ) {
        await stopBtn.click();
        await sidepanel.waitForTimeout(2000);
      }
    });
  },

  waitForFlush: async ({}, use) => {
    await use(async (ms = 12000) => {
      await new Promise((r) => setTimeout(r, ms));
    });
  },
});

export { expect } from "@playwright/test";
