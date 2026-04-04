/**
 * Sensitive Field Filter Tests
 *
 * Verifies that clicks on sensitive elements (password, CC, data-sensitive)
 * are NOT captured, while normal elements are captured correctly.
 */
import { test, expect } from "../fixtures/mock-backend";

test.describe("Sensitive Field Filtering", () => {
  test.beforeEach(async ({ resetBackend }) => {
    await resetBackend();
  });

  test("does not capture clicks on password fields", async ({
    context,
    extensionId,
    startRecording,
    getRecordedData,
    waitForFlush,
  }) => {
    await startRecording(context, extensionId);

    const page = await context.newPage();
    await page.goto("http://localhost:4000/test/sensitive");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    // Click sensitive fields
    await page.click("#password-field");
    await page.waitForTimeout(200);
    await page.click("#cc-field");
    await page.waitForTimeout(200);
    await page.click("#cc-auto-field");
    await page.waitForTimeout(200);
    await page.click("#sensitive-div");
    await page.waitForTimeout(200);
    await page.click("#aria-password");
    await page.waitForTimeout(200);

    // Click the normal button (control)
    await page.click("#normal-button");
    await page.waitForTimeout(200);

    await waitForFlush();

    const data = await getRecordedData();
    const clickEvents = data.events.filter(
      (e) =>
        e.event_type === "click" &&
        e.url?.includes("/test/sensitive"),
    );

    // The normal button should be captured
    const normalClick = clickEvents.find(
      (e) =>
        e.dom_context?.element_id === "normal-button" ||
        e.dom_context?.element_text?.includes("Normal Button"),
    );
    expect(normalClick).toBeTruthy();

    // Sensitive fields should NOT be captured
    const passwordClick = clickEvents.find(
      (e) => e.dom_context?.element_id === "password-field",
    );
    expect(passwordClick).toBeUndefined();

    const ccClick = clickEvents.find(
      (e) => e.dom_context?.element_id === "cc-field",
    );
    expect(ccClick).toBeUndefined();

    const sensitiveClick = clickEvents.find(
      (e) => e.dom_context?.element_id === "sensitive-div",
    );
    expect(sensitiveClick).toBeUndefined();
  });

  test("captures normal input clicks on the same page", async ({
    context,
    extensionId,
    startRecording,
    getRecordedData,
    waitForFlush,
  }) => {
    await startRecording(context, extensionId);

    const page = await context.newPage();
    await page.goto("http://localhost:4000/test/sensitive");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    await page.click("#normal-input");
    await page.waitForTimeout(200);
    await page.click("#normal-button");
    await page.waitForTimeout(200);

    await waitForFlush();

    const data = await getRecordedData();
    const clickEvents = data.events.filter(
      (e) =>
        e.event_type === "click" &&
        e.url?.includes("/test/sensitive"),
    );

    // Both normal elements should be captured
    expect(clickEvents.length).toBeGreaterThanOrEqual(2);
  });
});
