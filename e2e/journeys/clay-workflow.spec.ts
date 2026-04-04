/**
 * Clay Workflow E2E Test
 *
 * Simulates a full Clay GTM workflow:
 *   Table list → Table detail → Add row → Run column → Create new table
 *
 * Verifies the extension captures the complete event sequence with
 * correct event types, URLs, and DOM context.
 */
import { test, expect } from "../fixtures/mock-backend";

test.describe("Clay Table Workflow", () => {
  test.beforeEach(async ({ resetBackend }) => {
    await resetBackend();
  });

  test("full Clay workflow: browse tables → edit → create", async ({
    context,
    extensionId,
    startRecording,
    stopRecording,
    getRecordedData,
    waitForFlush,
  }) => {
    await startRecording(context, extensionId);

    const page = await context.newPage();

    // ── Step 1: Browse table list ───────────────────────────────────
    await page.goto("http://localhost:4000/clay/tables");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    // Click into the HeyReach Experts table
    await page.click("#table-heyreach");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    // ── Step 2: Interact with table detail ──────────────────────────
    await page.click("#add-row-btn");
    await page.waitForTimeout(500);

    // Fill the inline edit field that appears
    const nameInput = page.locator("#new-row-name");
    if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await nameInput.fill("Test User");
      await page.waitForTimeout(300);
    }

    await page.click("#run-column-btn");
    await page.waitForTimeout(500);

    // Click a column header
    await page.click("#col-email");
    await page.waitForTimeout(300);

    // ── Step 3: Navigate to create table ────────────────────────────
    await page.goto("http://localhost:4000/clay/tables/new");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    // Fill the create table form
    await page.fill("#table-name", "Outbound Prospects Q2");
    await page.selectOption("#row-unit", "company");
    await page.fill("#description", "Series A/B fintech companies");

    // Add a column
    await page.click("#add-column-btn");
    await page.waitForTimeout(300);

    // Submit the form
    await page.click("#submit-table-btn");
    await page.waitForTimeout(500);

    // ── Flush & Collect ─────────────────────────────────────────────
    await waitForFlush();

    // Stop recording to trigger final flush
    await stopRecording(context, extensionId);
    await new Promise((r) => setTimeout(r, 3000));

    const data = await getRecordedData();

    // ── Assertions ──────────────────────────────────────────────────

    // Must have captured a meaningful number of events
    expect(data.events.length).toBeGreaterThanOrEqual(5);

    const eventTypes = new Set(data.events.map((e) => e.event_type));

    // Must have click events (buttons, links)
    expect(eventTypes.has("click")).toBe(true);

    // Must have form_submit from the create table form
    expect(eventTypes.has("form_submit")).toBe(true);

    // Verify URLs span the Clay pages we visited
    const allUrls = data.events.map((e) => e.url);
    expect(allUrls.some((u) => u?.includes("/clay/tables"))).toBe(true);
    expect(
      allUrls.some((u) => u?.includes("/clay/tables/t_heyreach")),
    ).toBe(true);
    expect(allUrls.some((u) => u?.includes("/clay/tables/new"))).toBe(
      true,
    );

    // Verify key interactions were captured
    const clicks = data.events.filter((e) => e.event_type === "click");

    const addRowClick = clicks.find(
      (e) =>
        e.dom_context?.element_text?.includes("Add Row") ||
        e.dom_context?.element_id === "add-row-btn",
    );
    expect(addRowClick).toBeTruthy();

    const runColumnClick = clicks.find(
      (e) =>
        e.dom_context?.element_text?.includes("Run Column") ||
        e.dom_context?.element_id === "run-column-btn",
    );
    expect(runColumnClick).toBeTruthy();

    // Verify form submission captured the table name field
    const formSubmits = data.events.filter(
      (e) => e.event_type === "form_submit",
    );
    expect(formSubmits.length).toBeGreaterThanOrEqual(1);
    const createTableSubmit = formSubmits.find((e) =>
      e.url?.includes("/clay/tables/new"),
    );
    expect(createTableSubmit).toBeTruthy();
    expect(
      createTableSubmit!.dom_context!.visible_text_nearby,
    ).toContain("table_name");

    // All events should have localhost domain
    for (const ev of data.events) {
      expect(ev.domain).toBe("localhost");
    }

    // Session should be created and ended
    const sessionIds = Object.keys(data.sessions);
    expect(sessionIds.length).toBeGreaterThanOrEqual(1);
    expect(data.sessions[sessionIds[0]].ended).toBe(true);

    console.log(
      `\n[Clay Workflow] Captured ${data.events.length} events across ${new Set(allUrls).size} URLs`,
    );
    console.log(
      `  Event types: ${[...eventTypes].join(", ")}`,
    );
    console.log(
      `  Screenshots: ${data.screenshots.length}`,
    );
  });

  test("Clay table interactions have accurate element IDs", async ({
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
    await page.click("#filter-btn");
    await page.waitForTimeout(300);
    await page.click("#sort-btn");
    await page.waitForTimeout(300);

    await waitForFlush();

    const data = await getRecordedData();
    const clicks = data.events.filter(
      (e) =>
        e.event_type === "click" &&
        e.url?.includes("/clay/tables/t_heyreach"),
    );

    // Each button has a unique ID that should be captured
    const capturedIds = clicks
      .map((e) => e.dom_context?.element_id)
      .filter(Boolean);

    expect(capturedIds).toContain("add-row-btn");
    expect(capturedIds).toContain("run-column-btn");
    expect(capturedIds).toContain("filter-btn");
    expect(capturedIds).toContain("sort-btn");
  });
});
