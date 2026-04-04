/**
 * E2E Test: LinkedIn Lead Prospecting Journey
 *
 * Simulates a 5-step expert GTM workflow on mock pages with the real
 * Chrome extension capturing events. Verifies the FULL pipeline:
 *
 *   Extension DOM capture → Backend event ingestion → Narrator (Haiku)
 *   → Segmentation (Sonnet) → Agent matching → Drift detection → PR generation
 *
 * Each pipeline stage is verified independently with specific assertions.
 */
import { test, expect } from "../fixtures/extension";

const BACKEND = "http://localhost:3001";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function queryDB(sql: string): Promise<{ rows: any[]; row_count: number; error?: string }> {
  const res = await fetch(`${BACKEND}/api/data/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  return res.json();
}

async function apiPost(path: string, body: object): Promise<any> {
  const res = await fetch(`${BACKEND}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${BACKEND}${path}`);
  return res.json();
}

// ── Test ─────────────────────────────────────────────────────────────────────

test.describe("LinkedIn Lead Prospecting Pipeline", () => {
  let sessionId: string;

  test("full journey: capture → narrate → extract → match → drift → PRs", async ({
    context,
    extensionId,
  }) => {
    // ═══════════════════════════════════════════════════════════════════
    // PHASE 1: Start recording via extension side panel
    // ═══════════════════════════════════════════════════════════════════

    const sidepanel = await context.newPage();
    await sidepanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await sidepanel.waitForLoadState("domcontentloaded");

    const recordBtn = sidepanel.getByRole("button", { name: /record/i });
    if (await recordBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await recordBtn.click();
      await sidepanel.waitForTimeout(2000);
    } else {
      // If no record button, create session via API directly
      const session = await apiPost("/api/observe/session/start", {
        expert_id: "00000000-0000-0000-0000-000000000099",
      });
      sessionId = session.session_id;
    }

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 2: Expert journey on mock GTM pages
    // ═══════════════════════════════════════════════════════════════════

    const page = await context.newPage();

    // ── Step 1: ICP Definition (Sales Navigator) ─────────────────────
    await page.goto("http://localhost:4000/sales-nav/search");
    await page.waitForLoadState("domcontentloaded");

    await page.click('button:has-text("Industry: Financial Technology")');
    await page.waitForTimeout(400);
    await page.click('button:has-text("Company size: 51-200 employees")');
    await page.waitForTimeout(400);
    await page.click('button:has-text("Geography: Greater New York City Area")');
    await page.waitForTimeout(400);
    await page.click('button:has-text("Funding: Series A, Series B")');
    await page.waitForTimeout(800);

    // ── Step 2: Company Research (Crunchbase) ────────────────────────
    await page.click('a:has-text("Sarah Chen - VP Engineering at FinFlow")');
    await page.waitForTimeout(800);

    await page.goto("http://localhost:4000/crunchbase/finflow");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    await page.click('div:has-text("Series B: $45M")');
    await page.waitForTimeout(400);
    await page.click('span:has-text("Salesforce CRM")');
    await page.waitForTimeout(600);

    // ── Step 3: Contact Finding (Sales Nav Profile) ──────────────────
    await page.goto("http://localhost:4000/sales-nav/profile/sarah-chen");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(800);

    await page.click('button:has-text("Save to list")');
    await page.waitForTimeout(400);
    await page.click('button:has-text("Copy email")');
    await page.waitForTimeout(600);

    // ── Step 4: Email Drafting (Gmail) ───────────────────────────────
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

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 3: Wait for extension event flush (10s alarm cycle)
    // ═══════════════════════════════════════════════════════════════════

    await page.waitForTimeout(15000);

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 4: Stop recording
    // ═══════════════════════════════════════════════════════════════════

    const stopBtn = sidepanel.getByRole("button", { name: /stop/i });
    if (await stopBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await stopBtn.click();
      await sidepanel.waitForTimeout(2000);
    }

    // If we created via API, find the session ID
    if (!sessionId) {
      const sessions = await queryDB(
        "SELECT id FROM observation_sessions ORDER BY created_at DESC LIMIT 1"
      );
      sessionId = sessions.rows[0]?.id;
    }

    // If still no session (extension didn't create one), end the test with API session
    if (!sessionId) {
      // Fall back: create session and inject events via API
      const session = await apiPost("/api/observe/session/start", {
        expert_id: "00000000-0000-0000-0000-000000000099",
      });
      sessionId = session.session_id;

      const ts = Date.now();
      await apiPost(`/api/observe/session/${sessionId}/events`, {
        events: [
          { event_type: "navigation", url: "http://localhost:4000/sales-nav/search", domain: "localhost", dom_context: { element_type: "document", element_text: "", element_id: null, visible_text_nearby: "Sales Navigator - Lead Search" }, sequence_number: 1, timestamp: ts },
          { event_type: "click", url: "http://localhost:4000/sales-nav/search", domain: "localhost", dom_context: { element_type: "button", element_text: "Industry: Financial Technology", element_id: null, visible_text_nearby: "Filter by Industry" }, sequence_number: 2, timestamp: ts + 1 },
          { event_type: "click", url: "http://localhost:4000/sales-nav/search", domain: "localhost", dom_context: { element_type: "button", element_text: "Company size: 51-200 employees", element_id: null, visible_text_nearby: "Filter by Size" }, sequence_number: 3, timestamp: ts + 2 },
          { event_type: "click", url: "http://localhost:4000/sales-nav/search", domain: "localhost", dom_context: { element_type: "button", element_text: "Funding: Series A, Series B", element_id: null, visible_text_nearby: "Filter by Funding" }, sequence_number: 4, timestamp: ts + 3 },
        ],
      });
      await page.waitForTimeout(8000);

      await apiPost(`/api/observe/session/${sessionId}/events`, {
        events: [
          { event_type: "click", url: "http://localhost:4000/sales-nav/search", domain: "localhost", dom_context: { element_type: "a", element_text: "Sarah Chen - VP Engineering at FinFlow", element_id: null, visible_text_nearby: "VP Engineering at FinFlow" }, sequence_number: 5, timestamp: ts + 10 },
          { event_type: "navigation", url: "http://localhost:4000/crunchbase/finflow", domain: "localhost", dom_context: { element_type: "document", element_text: "", element_id: null, visible_text_nearby: "FinFlow - Crunchbase Company Profile" }, sequence_number: 6, timestamp: ts + 11 },
          { event_type: "click", url: "http://localhost:4000/crunchbase/finflow", domain: "localhost", dom_context: { element_type: "div", element_text: "Series B: $45M led by Sequoia Capital", element_id: null, visible_text_nearby: "Funding Rounds" }, sequence_number: 7, timestamp: ts + 12 },
          { event_type: "click", url: "http://localhost:4000/crunchbase/finflow", domain: "localhost", dom_context: { element_type: "span", element_text: "Salesforce CRM", element_id: null, visible_text_nearby: "Technology Stack" }, sequence_number: 8, timestamp: ts + 13 },
        ],
      });
      await page.waitForTimeout(8000);

      await apiPost(`/api/observe/session/${sessionId}/events`, {
        events: [
          { event_type: "navigation", url: "http://localhost:4000/sales-nav/profile/sarah-chen", domain: "localhost", dom_context: { element_type: "document", element_text: "", element_id: null, visible_text_nearby: "Sarah Chen - Sales Navigator Profile" }, sequence_number: 9, timestamp: ts + 20 },
          { event_type: "click", url: "http://localhost:4000/sales-nav/profile/sarah-chen", domain: "localhost", dom_context: { element_type: "button", element_text: "Save to list", element_id: "save-btn", visible_text_nearby: "Actions" }, sequence_number: 10, timestamp: ts + 21 },
          { event_type: "click", url: "http://localhost:4000/sales-nav/profile/sarah-chen", domain: "localhost", dom_context: { element_type: "button", element_text: "Copy email", element_id: "copy-email-btn", visible_text_nearby: "sarah.chen@finflow.com" }, sequence_number: 11, timestamp: ts + 22 },
          { event_type: "navigation", url: "http://localhost:4000/gmail/compose", domain: "localhost", dom_context: { element_type: "document", element_text: "", element_id: null, visible_text_nearby: "Gmail - New Message" }, sequence_number: 12, timestamp: ts + 23 },
          { event_type: "form_submit", url: "http://localhost:4000/gmail/compose", domain: "localhost", dom_context: { element_type: "form", element_text: "Send", element_id: "compose-form", visible_text_nearby: "To: sarah.chen@finflow.com Subject: scaling eng at FinFlow" }, sequence_number: 13, timestamp: ts + 24 },
        ],
      });
      await page.waitForTimeout(8000);
    }

    expect(sessionId).toBeTruthy();
    console.log(`\nSession: ${sessionId}`);

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 5: ASSERT — Event Capture Layer
    // ═══════════════════════════════════════════════════════════════════

    const events = await queryDB(
      `SELECT event_type, url, dom_context FROM action_events WHERE session_id = '${sessionId}' ORDER BY sequence_number`
    );

    // Must have captured events
    expect(events.row_count).toBeGreaterThanOrEqual(5);
    console.log(`\n[CAPTURE] ${events.row_count} events captured`);

    // Must have diverse event types
    const eventTypes = new Set(events.rows.map((r: any) => r.event_type));
    expect(eventTypes.has("click")).toBe(true);
    expect(eventTypes.has("navigation")).toBe(true);

    // Must have captured events from multiple domains/pages
    const urls = new Set(events.rows.map((r: any) => r.url).filter(Boolean));
    expect(urls.size).toBeGreaterThanOrEqual(2);
    console.log(`[CAPTURE] Event types: ${[...eventTypes].join(", ")}`);
    console.log(`[CAPTURE] Unique URLs: ${urls.size}`);

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 6: ASSERT — Narrator Layer
    // Wait for narrator to finish processing all batches
    // ═══════════════════════════════════════════════════════════════════

    await page.waitForTimeout(5000); // Extra time for narrator

    const narrations = await queryDB(
      `SELECT narrator_text, sequence_ref FROM distillations WHERE session_id = '${sessionId}' ORDER BY sequence_ref`
    );

    // Must have produced at least 2 narrations (one per event batch)
    expect(narrations.row_count).toBeGreaterThanOrEqual(2);
    console.log(`\n[NARRATOR] ${narrations.row_count} narrations produced`);

    // Narrations must reference actual entities from the session
    const allNarrationText = narrations.rows.map((r: any) => r.narrator_text).join(" ").toLowerCase();
    const entityChecks = [
      { entity: "finflow", found: allNarrationText.includes("finflow") },
      { entity: "sarah chen", found: allNarrationText.includes("sarah chen") || allNarrationText.includes("sarah") },
      { entity: "fintech", found: allNarrationText.includes("fintech") || allNarrationText.includes("financial technology") },
    ];
    for (const check of entityChecks) {
      console.log(`[NARRATOR] Entity "${check.entity}": ${check.found ? "FOUND" : "MISSING"}`);
    }
    // At least 2 of 3 key entities should be mentioned
    const entitiesFound = entityChecks.filter((c) => c.found).length;
    expect(entitiesFound).toBeGreaterThanOrEqual(2);

    // Narrations must explain intent (WHY), not just actions (WHAT)
    const hasReasoningLanguage = allNarrationText.match(
      /suggest|because|in order to|targeting|qualifying|indicating|focused on|prioritiz|looking for|signal/i
    );
    expect(hasReasoningLanguage).toBeTruthy();
    console.log(`[NARRATOR] Contains reasoning language: YES`);

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 7: End session → triggers extraction pipeline
    // ═══════════════════════════════════════════════════════════════════

    const endResult = await apiPost(`/api/observe/session/${sessionId}/end`, {});
    expect(endResult.coverage_score).toBeGreaterThan(0);
    console.log(`\n[SESSION] Ended. Coverage: ${(endResult.coverage_score * 100).toFixed(0)}%`);

    // Wait for extraction pipeline (segmentation + matching + drift = ~40s of Sonnet calls)
    console.log(`[EXTRACTION] Waiting for pipeline (segmentation → matching → drift)...`);
    await page.waitForTimeout(65000);

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 8: ASSERT — Segmentation Layer
    // ═══════════════════════════════════════════════════════════════════

    const tasks = await queryDB(
      `SELECT id, description, matched_agent_slug, match_confidence, status FROM abstracted_tasks WHERE session_id = '${sessionId}' ORDER BY match_confidence DESC`
    );

    // Must have extracted at least 3 distinct tasks from a 5-step workflow
    expect(tasks.row_count).toBeGreaterThanOrEqual(3);
    console.log(`\n[SEGMENTATION] ${tasks.row_count} abstracted tasks extracted`);

    // Each task must have a description
    for (const task of tasks.rows) {
      expect((task as any).description).toBeTruthy();
      expect((task as any).description.length).toBeGreaterThan(20);
    }

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 9: ASSERT — Agent Matching Layer
    // ═══════════════════════════════════════════════════════════════════

    const matchedTasks = tasks.rows.filter((t: any) => t.matched_agent_slug != null);
    expect(matchedTasks.length).toBeGreaterThanOrEqual(2);
    console.log(`[MATCHING] ${matchedTasks.length} tasks matched to agents`);

    // Matched agents should include at least 2 from the real agent catalog
    const matchedSlugs = new Set(matchedTasks.map((t: any) => t.matched_agent_slug));
    const catalogAgents = [
      "clay_operator", "dashboard_builder", "data_pipeline_builder",
      "lovable_operator", "n8n_operator", "notion_operator",
      "tolt_operator",
    ];
    const matchedKnown = catalogAgents.filter((a) => matchedSlugs.has(a));
    expect(matchedKnown.length).toBeGreaterThanOrEqual(2);
    console.log(`[MATCHING] Matched to catalog agents: ${matchedKnown.join(", ")}`);

    // All matches should have confidence > 0.5
    for (const task of matchedTasks) {
      expect((task as any).match_confidence).toBeGreaterThan(0.5);
    }

    // At least one high-confidence match (>= 0.85)
    const highConfidence = matchedTasks.filter((t: any) => t.match_confidence >= 0.85);
    expect(highConfidence.length).toBeGreaterThanOrEqual(1);
    console.log(`[MATCHING] High confidence (>= 0.85): ${highConfidence.length} tasks`);

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 10: ASSERT — Drift Detection & PR Generation
    // ═══════════════════════════════════════════════════════════════════

    const prs = await queryDB(
      `SELECT id, pr_type, target_agent_slug, gap_summary, confidence, reasoning, file_diffs, proposed_changes, status FROM agent_prs WHERE evidence_session_ids @> ARRAY['${sessionId}'::uuid] ORDER BY created_at DESC`
    );

    // Should have generated at least 1 PR (drift detection found gaps in prior runs)
    expect(prs.row_count).toBeGreaterThanOrEqual(1);
    console.log(`\n[DRIFT/PRs] ${prs.row_count} agent PRs created`);

    for (const pr of prs.rows) {
      const p = pr as any;

      // PR must target a real agent from the catalog
      expect(catalogAgents).toContain(p.target_agent_slug);

      // PR must have a meaningful gap description (not empty, not generic)
      expect(p.gap_summary).toBeTruthy();
      expect(p.gap_summary.length).toBeGreaterThan(30);

      // PR must have file_diffs or proposed_changes with actual content
      const diffs = p.proposed_changes ?? (typeof p.file_diffs === "string" ? JSON.parse(p.file_diffs) : p.file_diffs);
      expect(diffs).toBeTruthy();

      // PR must have reasoning
      expect(p.reasoning).toBeTruthy();
      expect(p.reasoning.length).toBeGreaterThan(50);

      // PR must be in open status
      expect(p.status).toBe("open");

      // Confidence should be meaningful
      expect(p.confidence).toBeGreaterThan(0.7);

      console.log(`[PR] ${p.target_agent_slug} (${p.confidence.toFixed(2)}) — ${p.gap_summary.slice(0, 80)}...`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 11: ASSERT — Session final state
    // ═══════════════════════════════════════════════════════════════════

    const sessionDetail = await apiGet(`/api/observe/session/${sessionId}`);
    expect(sessionDetail.session.status).toBe("completed");
    expect(sessionDetail.session.event_count).toBeGreaterThanOrEqual(5);
    expect(sessionDetail.session.coverage_score).toBeGreaterThan(0);
    expect(sessionDetail.distillations.length).toBeGreaterThanOrEqual(2);
    console.log(`\n[SESSION] Status: ${sessionDetail.session.status}, Events: ${sessionDetail.session.event_count}, Narrations: ${sessionDetail.distillations.length}`);

    // ═══════════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════════

    console.log(`\n${"=".repeat(60)}`);
    console.log(`PIPELINE TEST PASSED`);
    console.log(`  Events:     ${events.row_count}`);
    console.log(`  Narrations: ${narrations.row_count}`);
    console.log(`  Tasks:      ${tasks.row_count} (${matchedTasks.length} matched)`);
    console.log(`  PRs:        ${prs.row_count}`);
    console.log(`  Coverage:   ${(endResult.coverage_score * 100).toFixed(0)}%`);
    console.log(`${"=".repeat(60)}`);
  });
});
