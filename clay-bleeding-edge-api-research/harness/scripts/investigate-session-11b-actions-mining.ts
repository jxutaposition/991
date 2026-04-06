/**
 * Session 11B: Actions Catalog Mining + Internal Actions Discovery
 *
 * TODO-050: Mine all 1191 actions for patterns
 * TODO-051: Find Clay-internal actions (no auth, no external API)
 *
 * CREDIT COST: 0 (read-only catalog analysis)
 *
 * Usage:
 *   CLAY_WORKSPACE="1080480" npx tsx investigate-session-11b-actions-mining.ts
 */

import * as fs from "fs";
import * as path from "path";

const API_BASE = "https://api.clay.com";
const WORKSPACE = process.env.CLAY_WORKSPACE || "1080480";

function loadCookie(): string {
  const f = path.join(__dirname, "..", "results", ".session-cookies.json");
  return "claysession=" + JSON.parse(fs.readFileSync(f, "utf-8")).find((c: any) => c.name === "claysession").value;
}
const COOKIE = loadCookie();

async function hit(urlPath: string): Promise<any> {
  const url = `${API_BASE}${urlPath}`;
  const resp = await fetch(url, { headers: { Cookie: COOKIE, Accept: "application/json" } });
  return resp.json();
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Session 11B: Actions Catalog Mining                            ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  const actions = (await hit(`/v3/actions?workspaceId=${WORKSPACE}`))?.actions || [];
  console.log(`Total actions: ${actions.length}\n`);

  // ══════════════════════════════════════════════════════════════════
  // 1. Actions with NO auth required
  // ══════════════════════════════════════════════════════════════════
  console.log(">>> 1. Actions with NO AUTH required (immediately usable)\n");
  const noAuth = actions.filter((a: any) => !a.auth?.providerType);
  console.log(`  ${noAuth.length} actions need no auth\n`);
  for (const a of noAuth.sort((x: any, y: any) => (x.key || "").localeCompare(y.key || ""))) {
    const inputs = a.inputParameterSchema?.properties
      ? Object.keys(a.inputParameterSchema.properties)
      : (a.inputParameterSchema || []).map((p: any) => p.name);
    console.log(`  ${a.key}: "${a.displayName}" [${a.actionLabels?.categories?.join(",")}] inputs=${JSON.stringify(inputs)}`);
  }

  // ══════════════════════════════════════════════════════════════════
  // 2. Clay-internal actions (package key patterns)
  // ══════════════════════════════════════════════════════════════════
  console.log("\n\n>>> 2. Clay-internal actions (clay-* package keys)\n");
  const clayActions = actions.filter((a: any) =>
    a.key?.startsWith("clay-") || a.key?.startsWith("claygpt") ||
    a.package?.key?.startsWith("clay") ||
    a.key?.includes("lookup") || a.key?.includes("route-row")
  );
  console.log(`  ${clayActions.length} Clay-internal actions\n`);
  for (const a of clayActions) {
    console.log(`  ${a.key}: "${a.displayName}" pkg=${a.package?.key} auth=${a.auth?.providerType || "none"}`);
    const inputs = (a.inputParameterSchema || []).map?.((p: any) => `${p.name}(${p.type})`) || Object.keys(a.inputParameterSchema?.properties || {});
    console.log(`    inputs: ${JSON.stringify(inputs).substring(0, 200)}`);
  }

  // ══════════════════════════════════════════════════════════════════
  // 3. AI/LLM actions
  // ══════════════════════════════════════════════════════════════════
  console.log("\n\n>>> 3. AI/LLM actions\n");
  const aiActions = actions.filter((a: any) =>
    a.key?.includes("gpt") || a.key?.includes("openai") || a.key?.includes("claude") ||
    a.key?.includes("ai") || a.key?.includes("llm") || a.key?.includes("generate") ||
    a.displayName?.toLowerCase().includes("ai") || a.displayName?.toLowerCase().includes("gpt") ||
    a.actionLabels?.tags?.some((t: string) => t.toLowerCase().includes("ai"))
  );
  console.log(`  ${aiActions.length} AI/LLM actions\n`);
  for (const a of aiActions) {
    console.log(`  ${a.key}: "${a.displayName}" auth=${a.auth?.providerType || "none"} tags=${a.actionLabels?.tags?.join(",")}`);
  }

  // ══════════════════════════════════════════════════════════════════
  // 4. Actions that WRITE to external systems
  // ══════════════════════════════════════════════════════════════════
  console.log("\n\n>>> 4. Write/Send/Push actions (outbound)\n");
  const writeActions = actions.filter((a: any) =>
    a.key?.includes("send") || a.key?.includes("create") || a.key?.includes("add") ||
    a.key?.includes("push") || a.key?.includes("update") || a.key?.includes("write") ||
    a.key?.includes("post") || a.key?.includes("export") ||
    a.displayName?.toLowerCase().includes("send") || a.displayName?.toLowerCase().includes("add to") ||
    a.displayName?.toLowerCase().includes("create")
  );
  console.log(`  ${writeActions.length} write/send actions\n`);
  // Group by provider
  const byProvider = new Map<string, any[]>();
  for (const a of writeActions) {
    const provider = a.auth?.providerType || a.package?.key || "unknown";
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider)!.push(a);
  }
  for (const [provider, acts] of [...byProvider.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 20)) {
    console.log(`  ${provider} (${acts.length}): ${acts.map((a: any) => a.key).join(", ")}`);
  }

  // ══════════════════════════════════════════════════════════════════
  // 5. Category/tag analysis
  // ══════════════════════════════════════════════════════════════════
  console.log("\n\n>>> 5. Category and Tag Analysis\n");
  const categories = new Map<string, number>();
  const tags = new Map<string, number>();
  for (const a of actions) {
    for (const c of a.actionLabels?.categories || []) categories.set(c, (categories.get(c) || 0) + 1);
    for (const t of a.actionLabels?.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
  }
  console.log("  Categories:");
  for (const [k, v] of [...categories.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${k}: ${v}`);
  console.log("\n  Tags:");
  for (const [k, v] of [...tags.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${k}: ${v}`);

  // ══════════════════════════════════════════════════════════════════
  // 6. Unique provider types
  // ══════════════════════════════════════════════════════════════════
  console.log("\n\n>>> 6. Provider Types\n");
  const providers = new Map<string, number>();
  for (const a of actions) {
    const p = a.auth?.providerType || "NO_AUTH";
    providers.set(p, (providers.get(p) || 0) + 1);
  }
  for (const [k, v] of [...providers.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v} actions`);

  // ══════════════════════════════════════════════════════════════════
  // 7. Rich output schemas (most data returned)
  // ══════════════════════════════════════════════════════════════════
  console.log("\n\n>>> 7. Actions with richest output schemas\n");
  const withOutputs = actions.filter((a: any) => a.outputParameterSchema?.length > 0)
    .sort((a: any, b: any) => (b.outputParameterSchema?.length || 0) - (a.outputParameterSchema?.length || 0));
  for (const a of withOutputs.slice(0, 15)) {
    const outFields = (a.outputParameterSchema || []).map((o: any) => o.name || o.outputPath);
    console.log(`  ${a.key} (${outFields.length} outputs): ${outFields.join(", ").substring(0, 150)}`);
  }

  // ══════════════════════════════════════════════════════════════════
  // 8. Billing/enablement patterns
  // ══════════════════════════════════════════════════════════════════
  console.log("\n\n>>> 8. Billing & Enablement Patterns\n");
  const billingCats = new Map<string, number>();
  const statusReasons = new Map<string, number>();
  for (const a of actions) {
    const bc = a.actionEnablementInfo?.billingFeatureCategory || "null";
    const sr = a.actionEnablementInfo?.enabledStatusReason || "unknown";
    billingCats.set(bc, (billingCats.get(bc) || 0) + 1);
    statusReasons.set(sr, (statusReasons.get(sr) || 0) + 1);
  }
  console.log("  Billing feature categories:");
  for (const [k, v] of [...billingCats.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${k}: ${v}`);
  console.log("\n  Enablement status reasons:");
  for (const [k, v] of [...statusReasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${k}: ${v}`);

  // ══════════════════════════════════════════════════════════════════
  // 9. Rate limit patterns
  // ══════════════════════════════════════════════════════════════════
  console.log("\n\n>>> 9. Rate Limit Patterns\n");
  const rateLimitBuckets = new Map<string, number>();
  let withRateLimits = 0;
  for (const a of actions) {
    if (a.rateLimitRules?.timeWindow?.length > 0) {
      withRateLimits++;
      for (const tw of a.rateLimitRules.timeWindow) {
        const bucket = (tw.bucket || []).join("+") || "default";
        rateLimitBuckets.set(bucket, (rateLimitBuckets.get(bucket) || 0) + 1);
      }
    }
  }
  console.log(`  ${withRateLimits}/${actions.length} actions have rate limits`);
  console.log("  Bucket types:");
  for (const [k, v] of [...rateLimitBuckets.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${k}: ${v}`);

  // Save full catalog for offline analysis
  const out = path.join(__dirname, "..", "results", `actions-catalog-full-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(actions, null, 2));
  console.log(`\nFull catalog saved to ${out}`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
