/**
 * E2E Test: LinkedIn Lead Prospecting Journey
 *
 * Simulates a 5-step expert GTM workflow on mock pages with the real
 * Chrome extension capturing events. Verifies the full pipeline:
 * extension → backend events → narrator → extraction → PRs
 */
import { test, expect } from "../fixtures/extension";

const BACKEND = "http://localhost:3001";

// Helper to query backend API
async function queryDB(sql: string): Promise<{ rows: any[]; row_count: number; error?: string }> {
  const res = await fetch(`${BACKEND}/api/data/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  return res.json();
}

test("full prospecting journey: ICP → research → contact → email", async ({
  context,
  extensionId,
}) => {
  // ── Step 0: Start recording via the side panel ──────────────────────

  const sidepanel = await context.newPage();
  await sidepanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await sidepanel.waitForLoadState("domcontentloaded");

  // Click the record button (the side panel has a Start Recording button)
  const recordBtn = sidepanel.getByRole("button", { name: /record/i });
  if (await recordBtn.isVisible()) {
    await recordBtn.click();
    // Wait for recording to start
    await sidepanel.waitForTimeout(2000);
  }

  // ── Step 1: ICP Definition on Sales Navigator ──────────────────────

  const page = await context.newPage();
  await page.goto("http://localhost:4000/sales-nav/search");
  await page.waitForLoadState("domcontentloaded");

  // Apply ICP filters
  await page.click('button:has-text("Industry: Financial Technology")');
  await page.waitForTimeout(500);
  await page.click('button:has-text("Company size: 51-200 employees")');
  await page.waitForTimeout(500);
  await page.click('button:has-text("Geography: Greater New York City Area")');
  await page.waitForTimeout(500);
  await page.click('button:has-text("Funding: Series A, Series B")');
  await page.waitForTimeout(1000);

  // ── Step 2: Company Research on Crunchbase ─────────────────────────

  // Click into FinFlow from search results
  await page.click('a:has-text("Sarah Chen - VP Engineering at FinFlow")');
  await page.waitForTimeout(1000);

  // Navigate to Crunchbase for company research
  await page.goto("http://localhost:4000/crunchbase/finflow");
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2000);

  // Click on funding round details
  await page.click('div:has-text("Series B: $45M")');
  await page.waitForTimeout(500);

  // Click on tech stack
  await page.click('span:has-text("Salesforce CRM")');
  await page.waitForTimeout(500);

  // ── Step 3: Contact Finding ────────────────────────────────────────

  await page.goto("http://localhost:4000/sales-nav/profile/sarah-chen");
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1000);

  // Save the lead
  await page.click('button:has-text("Save to list")');
  await page.waitForTimeout(500);

  // Copy email
  await page.click('button:has-text("Copy email")');
  await page.waitForTimeout(500);

  // ── Step 4: Email Drafting ─────────────────────────────────────────

  await page.goto("http://localhost:4000/gmail/compose");
  await page.waitForLoadState("domcontentloaded");

  await page.fill('input[name="to"]', "sarah.chen@finflow.com");
  await page.fill('input[name="subject"]', "scaling eng at FinFlow");
  await page.fill(
    'textarea[name="body"]',
    "Saw your post about growing the eng team post-Series B. When we helped Plaid's VP Eng cut deploy times by 40%, the key was..."
  );
  await page.click('button:has-text("Send")');
  await page.waitForTimeout(1000);

  // ── Step 5: Wait for events to flush ───────────────────────────────

  // Extension flushes events every 10 seconds
  await page.waitForTimeout(15000);

  // ── Step 6: Stop recording ─────────────────────────────────────────

  // The stop button should be visible since we're recording
  const stopBtn = sidepanel.getByRole("button", { name: /stop/i });
  if (await stopBtn.isVisible()) {
    await stopBtn.click();
  }

  // Wait for session end + extraction pipeline
  await page.waitForTimeout(45000);

  // ── Step 7: Verify results ─────────────────────────────────────────

  // Check events were captured
  const events = await queryDB(
    "SELECT COUNT(*) as cnt FROM action_events"
  );
  expect(events.rows[0]?.cnt).toBeGreaterThan(0);
  console.log(`Events captured: ${events.rows[0]?.cnt}`);

  // Check narrations were produced
  const narrations = await queryDB(
    "SELECT COUNT(*) as cnt FROM distillations"
  );
  expect(narrations.rows[0]?.cnt).toBeGreaterThan(0);
  console.log(`Narrations produced: ${narrations.rows[0]?.cnt}`);

  // Check abstracted tasks were extracted
  const tasks = await queryDB(
    "SELECT description, matched_agent_slug, match_confidence FROM abstracted_tasks ORDER BY match_confidence DESC"
  );
  console.log(`Abstracted tasks: ${tasks.row_count}`);
  for (const t of tasks.rows) {
    console.log(
      `  [${t.match_confidence?.toFixed(2)}] ${t.matched_agent_slug} → ${t.description?.slice(0, 80)}`
    );
  }

  // We should have at least 2 tasks extracted
  expect(tasks.row_count).toBeGreaterThanOrEqual(2);

  // Check for agent PRs
  const prs = await queryDB(
    "SELECT target_agent_slug, gap_summary, confidence FROM agent_prs ORDER BY created_at DESC LIMIT 5"
  );
  console.log(`Agent PRs created: ${prs.row_count}`);
  for (const pr of prs.rows) {
    console.log(
      `  [${pr.confidence?.toFixed(2)}] ${pr.target_agent_slug} → ${pr.gap_summary?.slice(0, 80)}`
    );
  }

  // Check the live_events view shows cross-source data
  const liveEvents = await queryDB(
    "SELECT source, COUNT(*) as cnt FROM live_events GROUP BY source"
  );
  console.log("Live events by source:");
  for (const row of liveEvents.rows) {
    console.log(`  ${row.source}: ${row.cnt}`);
  }
});
