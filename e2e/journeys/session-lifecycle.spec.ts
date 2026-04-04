/**
 * Session Lifecycle Tests
 *
 * Verifies the full recording lifecycle:
 * - Start recording creates a session
 * - Events are captured during recording
 * - Stop recording flushes remaining events
 * - No events are captured after stopping
 */
import { test, expect } from "../fixtures/mock-backend";

test.describe("Session Lifecycle", () => {
  test.beforeEach(async ({ resetBackend }) => {
    await resetBackend();
  });

  test("start recording creates a session on the backend", async ({
    context,
    extensionId,
    startRecording,
    getRecordedData,
  }) => {
    await startRecording(context, extensionId);

    // Give it a moment to POST /session/start
    await new Promise((r) => setTimeout(r, 3000));

    const data = await getRecordedData();
    const sessionIds = Object.keys(data.sessions);
    expect(sessionIds.length).toBeGreaterThanOrEqual(1);

    const session = data.sessions[sessionIds[0]];
    expect(session.started_at).toBeGreaterThan(0);
    expect(session.ended).toBe(false);
  });

  test("events flow during recording, stop at end", async ({
    context,
    extensionId,
    startRecording,
    stopRecording,
    getRecordedData,
    resetBackend,
    waitForFlush,
  }) => {
    await startRecording(context, extensionId);

    const page = await context.newPage();
    await page.goto("http://localhost:4000/sales-nav/search");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    // Generate some events
    await page.click('button:has-text("Industry: Financial Technology")');
    await page.waitForTimeout(300);
    await page.click('button:has-text("Company size: 51-200 employees")');
    await page.waitForTimeout(300);

    // Wait for at least one flush
    await waitForFlush();

    const dataDuring = await getRecordedData();
    const eventsDuring = dataDuring.events.length;
    expect(eventsDuring).toBeGreaterThanOrEqual(2);

    // Stop recording
    await stopRecording(context, extensionId);
    await new Promise((r) => setTimeout(r, 3000));

    // Reset to count only new events
    await resetBackend();

    // Click more things after stopping
    await page.click('button:has-text("Department: Engineering")');
    await page.waitForTimeout(300);

    // Wait for what would be a flush cycle
    await waitForFlush();

    const dataAfter = await getRecordedData();
    // No new events should appear (recording is stopped)
    expect(dataAfter.events.length).toBe(0);
  });

  test("stop recording triggers final flush", async ({
    context,
    extensionId,
    startRecording,
    stopRecording,
    getRecordedData,
  }) => {
    await startRecording(context, extensionId);

    const page = await context.newPage();
    await page.goto("http://localhost:4000/clay/tables");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    await page.click("#table-heyreach");
    await page.waitForTimeout(500);

    // Stop immediately (before the 10s flush timer fires)
    await stopRecording(context, extensionId);
    await new Promise((r) => setTimeout(r, 3000));

    const data = await getRecordedData();
    // The final flush on stop should have sent buffered events
    expect(data.events.length).toBeGreaterThanOrEqual(1);

    // Session should be ended
    const sessionIds = Object.keys(data.sessions);
    expect(sessionIds.length).toBeGreaterThanOrEqual(1);
    const session = data.sessions[sessionIds[0]];
    expect(session.ended).toBe(true);
  });

  test("side panel shows recording state", async ({
    context,
    extensionId,
  }) => {
    const sidepanel = await context.newPage();
    await sidepanel.goto(
      `chrome-extension://${extensionId}/sidepanel.html`,
    );
    await sidepanel.waitForLoadState("domcontentloaded");

    // Initially shows "Press Record to start a session."
    await expect(
      sidepanel.getByText(/press record/i),
    ).toBeVisible({ timeout: 5000 });

    // Click Record
    await sidepanel.getByRole("button", { name: /record/i }).click();
    await sidepanel.waitForTimeout(5000);

    // Should now show "Stop" button (session started successfully)
    await expect(
      sidepanel.getByRole("button", { name: /stop/i }),
    ).toBeVisible({ timeout: 10000 });
  });
});
