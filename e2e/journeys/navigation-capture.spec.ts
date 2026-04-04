/**
 * Navigation Capture Tests
 *
 * Verifies that page navigations produce events with correct URLs.
 *
 * Note: The content script reinjects on each full page load (document_idle),
 * so full-navigation events are captured as clicks on links that trigger
 * navigation, or via the MutationObserver for SPA-style URL changes.
 * For full page navigations, we verify events exist WITH the correct URL
 * on each page visited (e.g. click events that occurred on that page).
 */
import { test, expect } from "../fixtures/mock-backend";

test.describe("Navigation Event Capture", () => {
  test.beforeEach(async ({ resetBackend }) => {
    await resetBackend();
  });

  test("captures events from multiple pages visited in sequence", async ({
    context,
    extensionId,
    startRecording,
    getRecordedData,
    waitForFlush,
  }) => {
    await startRecording(context, extensionId);

    const page = await context.newPage();

    // Visit page 1 and interact
    await page.goto("http://localhost:4000/sales-nav/search");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);
    await page.click('button:has-text("Industry: Financial Technology")');
    await page.waitForTimeout(300);

    // Visit page 2 and interact
    await page.goto("http://localhost:4000/crunchbase/finflow");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);
    await page.click('div:has-text("Series B: $45M")');
    await page.waitForTimeout(300);

    // Visit page 3 and interact
    await page.goto("http://localhost:4000/gmail/compose");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);
    await page.click('button:has-text("Send")');
    await page.waitForTimeout(300);

    await waitForFlush();

    const data = await getRecordedData();

    // Events should exist from each page
    const allUrls = data.events.map((e) => e.url);
    expect(allUrls.some((u) => u?.includes("/sales-nav/search"))).toBe(
      true,
    );
    expect(allUrls.some((u) => u?.includes("/crunchbase/finflow"))).toBe(
      true,
    );
    expect(allUrls.some((u) => u?.includes("/gmail/compose"))).toBe(
      true,
    );
  });

  test("captures events from Clay page navigations with interactions", async ({
    context,
    extensionId,
    startRecording,
    getRecordedData,
    waitForFlush,
  }) => {
    await startRecording(context, extensionId);

    const page = await context.newPage();

    await page.goto("http://localhost:4000/clay/tables");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);
    await page.click("#create-table-btn");
    await page.waitForTimeout(300);

    // Link click navigates to /clay/tables/new, but content script on
    // /clay/tables captured the click event with that page's URL
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    await page.goto(
      "http://localhost:4000/clay/tables/t_heyreach_experts",
    );
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);
    await page.click("#add-row-btn");
    await page.waitForTimeout(300);

    await waitForFlush();

    const data = await getRecordedData();
    const allUrls = data.events.map((e) => e.url);

    expect(allUrls.some((u) => u?.includes("/clay/tables"))).toBe(true);
    expect(
      allUrls.some((u) => u?.includes("/clay/tables/t_heyreach")),
    ).toBe(true);
  });

  test("all events have correct domain", async ({
    context,
    extensionId,
    startRecording,
    getRecordedData,
    waitForFlush,
  }) => {
    await startRecording(context, extensionId);

    const page = await context.newPage();
    await page.goto("http://localhost:4000/sales-nav/search");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);
    await page.click('button:has-text("Industry: Financial Technology")');
    await page.waitForTimeout(300);

    await page.goto("http://localhost:4000/clay/tables");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);
    await page.click("#table-heyreach");
    await page.waitForTimeout(300);

    await waitForFlush();

    const data = await getRecordedData();
    expect(data.events.length).toBeGreaterThanOrEqual(1);
    for (const ev of data.events) {
      expect(ev.domain).toBe("localhost");
    }
  });
});
