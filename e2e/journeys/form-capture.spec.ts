/**
 * Form Capture Tests
 *
 * Verifies that form submissions are captured with field names
 * in dom_context.visible_text_nearby.
 */
import { test, expect } from "../fixtures/mock-backend";

test.describe("Form Submission Capture", () => {
  test.beforeEach(async ({ resetBackend }) => {
    await resetBackend();
  });

  test("captures Gmail compose form submission with field names", async ({
    context,
    extensionId,
    startRecording,
    getRecordedData,
    waitForFlush,
  }) => {
    await startRecording(context, extensionId);

    const page = await context.newPage();
    await page.goto("http://localhost:4000/gmail/compose");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    await page.fill('input[name="to"]', "sarah@finflow.com");
    await page.fill('input[name="subject"]', "Quick intro");
    await page.fill('textarea[name="body"]', "Hello there...");
    await page.click('button:has-text("Send")');
    await page.waitForTimeout(500);

    await waitForFlush();

    const data = await getRecordedData();
    const formEvents = data.events.filter(
      (e) => e.event_type === "form_submit",
    );

    expect(formEvents.length).toBeGreaterThanOrEqual(1);

    const gmailSubmit = formEvents[0];
    expect(gmailSubmit.dom_context!.element_type).toBe("form");
    expect(gmailSubmit.url).toContain("/gmail/compose");

    // The content script captures field names (name/id) in visible_text_nearby
    const nearby = gmailSubmit.dom_context!.visible_text_nearby;
    expect(nearby).toContain("to");
    expect(nearby).toContain("subject");
    expect(nearby).toContain("body");
  });

  test("captures Clay create-table form submission", async ({
    context,
    extensionId,
    startRecording,
    getRecordedData,
    waitForFlush,
  }) => {
    await startRecording(context, extensionId);

    const page = await context.newPage();
    await page.goto("http://localhost:4000/clay/tables/new");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    await page.fill("#table-name", "ICP Companies - Series B");
    await page.selectOption("#row-unit", "company");
    await page.fill("#description", "Target fintech companies");

    // Submit the form
    await page.click("#submit-table-btn");
    await page.waitForTimeout(500);

    await waitForFlush();

    const data = await getRecordedData();
    const formEvents = data.events.filter(
      (e) => e.event_type === "form_submit",
    );

    expect(formEvents.length).toBeGreaterThanOrEqual(1);

    const tableSubmit = formEvents[0];
    expect(tableSubmit.dom_context!.element_type).toBe("form");
    expect(tableSubmit.url).toContain("/clay/tables/new");

    // Should capture the field names
    const nearby = tableSubmit.dom_context!.visible_text_nearby;
    expect(nearby).toContain("table_name");
  });
});
