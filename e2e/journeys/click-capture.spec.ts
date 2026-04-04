/**
 * Click Capture Tests
 *
 * Verifies that clicks on various elements are captured with correct
 * event_type, dom_context (element_type, element_text, element_id), and url.
 */
import { test, expect } from "../fixtures/mock-backend";

test.describe("Click Event Capture", () => {
  test.beforeEach(async ({ resetBackend }) => {
    await resetBackend();
  });

  test("captures button clicks with correct DOM context", async ({
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

    // Click filter buttons
    await page.click('button:has-text("Industry: Financial Technology")');
    await page.waitForTimeout(300);
    await page.click(
      'button:has-text("Company size: 51-200 employees")',
    );
    await page.waitForTimeout(300);

    await waitForFlush();

    const data = await getRecordedData();
    const clickEvents = data.events.filter(
      (e) => e.event_type === "click",
    );

    expect(clickEvents.length).toBeGreaterThanOrEqual(2);

    const industryClick = clickEvents.find((e) =>
      e.dom_context?.element_text?.includes("Financial Technology"),
    );
    expect(industryClick).toBeTruthy();
    expect(industryClick!.dom_context!.element_type).toBe("button");
    expect(industryClick!.url).toContain("/sales-nav/search");

    const sizeClick = clickEvents.find((e) =>
      e.dom_context?.element_text?.includes("51-200"),
    );
    expect(sizeClick).toBeTruthy();
    expect(sizeClick!.dom_context!.element_type).toBe("button");
  });

  test("captures link clicks with element_type 'a'", async ({
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

    await page.click(
      'a:has-text("Sarah Chen - VP Engineering at FinFlow")',
    );
    await page.waitForTimeout(500);

    await waitForFlush();

    const data = await getRecordedData();
    const clickEvents = data.events.filter(
      (e) => e.event_type === "click",
    );

    const linkClick = clickEvents.find(
      (e) =>
        e.dom_context?.element_text?.includes("Sarah Chen") ||
        e.dom_context?.element_type === "a",
    );
    expect(linkClick).toBeTruthy();
  });

  test("captures Clay table button clicks", async ({
    context,
    extensionId,
    startRecording,
    getRecordedData,
    waitForFlush,
  }) => {
    await startRecording(context, extensionId);

    const page = await context.newPage();
    await page.goto("http://localhost:4000/clay/tables/t_heyreach");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    await page.click("#add-row-btn");
    await page.waitForTimeout(300);
    await page.click("#run-column-btn");
    await page.waitForTimeout(300);

    await waitForFlush();

    const data = await getRecordedData();
    const clickEvents = data.events.filter(
      (e) => e.event_type === "click",
    );

    const addRowClick = clickEvents.find(
      (e) =>
        e.dom_context?.element_text?.includes("Add Row") ||
        e.dom_context?.element_id === "add-row-btn",
    );
    expect(addRowClick).toBeTruthy();
    expect(addRowClick!.dom_context!.element_type).toBe("button");

    const runColClick = clickEvents.find(
      (e) =>
        e.dom_context?.element_text?.includes("Run Column") ||
        e.dom_context?.element_id === "run-column-btn",
    );
    expect(runColClick).toBeTruthy();
  });

  test("click events include correct url and domain", async ({
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

    await page.click("#table-heyreach");
    await page.waitForTimeout(300);

    await waitForFlush();

    const data = await getRecordedData();
    const clickEvents = data.events.filter(
      (e) => e.event_type === "click",
    );

    expect(clickEvents.length).toBeGreaterThanOrEqual(1);
    for (const ev of clickEvents) {
      expect(ev.url).toBeTruthy();
      expect(ev.domain).toBe("localhost");
      expect(ev.timestamp).toBeGreaterThan(0);
    }
  });
});
