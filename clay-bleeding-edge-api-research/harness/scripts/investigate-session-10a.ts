/**
 * Session 10A: Import, Tags, Workbook Re-Parenting, Attributes Deep Dive
 *
 * ALL CREDIT-FREE — only CRUD and schema probing.
 *
 * TODO-044: Table workbook re-parenting
 * TODO-045: Import payload reverse-engineering
 * TODO-046: Tag-to-table association
 * TODO-023: Attributes catalog deep dive
 * TODO-047: Single field read + new endpoints
 *
 * Usage:
 *   CLAY_WORKSPACE="1080480" npx tsx investigate-session-10a.ts
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
const results: any[] = [];

async function hit(probe: string, method: string, urlPath: string, body?: any): Promise<any> {
  const url = `${API_BASE}${urlPath}`;
  const opts: RequestInit = { method, headers: { Cookie: COOKIE, Accept: "application/json", "Content-Type": "application/json" } };
  if (body && method !== "GET") opts.body = JSON.stringify(body);
  const start = Date.now();
  try {
    const resp = await fetch(url, opts);
    const b = await resp.json().catch(() => resp.text());
    const r = { probe, method, url: urlPath, status: resp.status, latencyMs: Date.now() - start, body: b };
    results.push(r);
    return r;
  } catch (err: any) {
    const r = { probe, method, url: urlPath, status: 0, body: null, error: err.message };
    results.push(r);
    return r;
  }
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const mark = (s: number) => s === 200 || s === 201 ? "✅" : s === 400 ? "⚠️" : s === 404 ? "❌" : `[${s}]`;

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Session 10A: Import, Tags, Re-Parenting, Attributes           ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  const me = await hit("0", "GET", "/v3/me");
  if (me.status === 401) { console.error("Session expired."); process.exit(1); }
  console.log(`Session OK: ${me.body?.email}\n`);

  const tablesToClean: string[] = [];
  const tagsToclean: string[] = [];

  try {
    // ══════════════════════════════════════════════════════════════════
    // EXP 1: Import Payload Reverse-Engineering (TODO-045)
    // ══════════════════════════════════════════════════════════════════
    console.log(">>> EXP 1: Import Payload Reverse-Engineering\n");

    // Read existing imports to learn the structure
    const imports = await hit("1a", "GET", `/v3/imports?workspaceId=${WORKSPACE}`);
    const importList = imports.body || [];
    console.log(`  ${Array.isArray(importList) ? importList.length : 0} existing imports`);
    if (Array.isArray(importList) && importList[0]) {
      console.log(`  First import FULL: ${JSON.stringify(importList[0], null, 2).substring(0, 800)}`);
    }

    // Create a test table for import target
    const impTable = await hit("1b", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-import-test"
    });
    const impTableId = impTable.body?.table?.id;
    tablesToClean.push(impTableId);
    await delay(500);

    const impSchema = await hit("1c", "GET", `/v3/tables/${impTableId}`);
    const impView = ((impSchema.body?.table || impSchema.body)?.gridViews || [])[0]?.id;
    const impCol = await hit("1d", "POST", `/v3/tables/${impTableId}/fields`, {
      name: "Name", type: "text", typeSettings: { dataTypeSettings: { type: "text" } }, activeViewId: impView
    });
    const impFieldId = impCol.body?.field?.id;

    // Try various POST /v3/imports payloads (using Zod errors to discover format)
    const importPayloads = [
      { name: "minimal", body: { workspaceId: parseInt(WORKSPACE), tableId: impTableId } },
      { name: "with-type", body: { workspaceId: parseInt(WORKSPACE), tableId: impTableId, type: "csv" } },
      { name: "with-source", body: { workspaceId: parseInt(WORKSPACE), tableId: impTableId, source: "csv" } },
      { name: "with-config", body: { workspaceId: parseInt(WORKSPACE), tableId: impTableId, config: { columnMapping: {} } } },
      { name: "with-data", body: { workspaceId: parseInt(WORKSPACE), tableId: impTableId, data: [{ Name: "Test" }] } },
      { name: "with-rows", body: { workspaceId: parseInt(WORKSPACE), tableId: impTableId, rows: [["Test"]] } },
    ];

    for (const p of importPayloads) {
      await delay(100);
      const r = await hit(`1e-${p.name}`, "POST", "/v3/imports", p.body);
      console.log(`  ${mark(r.status)} ${p.name}: ${JSON.stringify(r.body).substring(0, 300)}`);
    }

    // ══════════════════════════════════════════════════════════════════
    // EXP 2: Workbook Re-Parenting (TODO-044)
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 2: Workbook Re-Parenting\n");

    // Create a second workbook
    const wb2 = await hit("2a", "POST", "/v3/workbooks", {
      workspaceId: parseInt(WORKSPACE), name: "INV-reparent-target"
    });
    const wb2Id = wb2.body?.id;
    console.log(`  Second workbook: ${wb2Id}`);

    // Get current table's workbook
    const tblSchema = await hit("2b", "GET", `/v3/tables/${impTableId}`);
    const origWb = (tblSchema.body?.table || tblSchema.body)?.workbookId;
    console.log(`  Table's current workbook: ${origWb}`);

    // Try re-parenting
    if (wb2Id) {
      await delay(100);
      const reparent = await hit("2c", "PATCH", `/v3/tables/${impTableId}`, { workbookId: wb2Id });
      const newWb = (reparent.body?.table || reparent.body)?.workbookId || reparent.body?.workbookId;
      console.log(`  ${mark(reparent.status)} PATCH workbookId: ${origWb} → ${newWb} (${origWb === newWb ? "UNCHANGED" : "MOVED!"})`);

      // Also try parentFolderId
      await delay(100);
      const folder = await hit("2d", "PATCH", `/v3/tables/${impTableId}`, { parentFolderId: "test-folder" });
      console.log(`  ${mark(folder.status)} PATCH parentFolderId: ${JSON.stringify(folder.body).substring(0, 200)}`);
    }

    // ══════════════════════════════════════════════════════════════════
    // EXP 3: Tag-to-Table Association (TODO-046)
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 3: Tag-to-Table Association\n");

    // Create a tag
    const tag = await hit("3a", "POST", `/v3/workspaces/${WORKSPACE}/resource-tags`, {
      tagText: "inv-test-tag", tagColor: "matcha", isPublic: true
    });
    const tagId = tag.body?.tagId;
    if (tagId) tagsToclean.push(tagId);
    console.log(`  Tag: ${tagId}`);

    if (tagId) {
      // Try associating tag with table via PATCH table
      const tagPayloads = [
        { name: "tags-array", body: { tags: [tagId] } },
        { name: "resourceTags", body: { resourceTags: [tagId] } },
        { name: "tagIds", body: { tagIds: [tagId] } },
        { name: "resourceTagIds", body: { resourceTagIds: [tagId] } },
      ];

      for (const p of tagPayloads) {
        await delay(100);
        const r = await hit(`3b-${p.name}`, "PATCH", `/v3/tables/${impTableId}`, p.body);
        const tblTags = r.body?.tags || r.body?.resourceTags || r.body?.table?.tags || r.body?.table?.resourceTags;
        console.log(`  ${mark(r.status)} PATCH ${p.name}: tags in response = ${JSON.stringify(tblTags)}`);
      }

      // Try dedicated association endpoint
      const assocEndpoints = [
        ["POST", `/v3/tables/${impTableId}/tags`, { tagId }],
        ["POST", `/v3/tables/${impTableId}/resource-tags`, { tagId }],
        ["PUT", `/v3/tables/${impTableId}/tags/${tagId}`, {}],
        ["POST", `/v3/resource-tags/${tagId}/tables`, { tableId: impTableId }],
      ];
      for (const [method, path, body] of assocEndpoints) {
        await delay(50);
        const r = await hit("3c", method as string, path as string, body);
        console.log(`  ${mark(r.status)} ${method} ${(path as string).replace(impTableId!, "{tbl}").replace(tagId, "{tag}")}`);
      }

      // Try on workbook too
      if (wb2Id) {
        await delay(50);
        const wbTag = await hit("3d", "PATCH", `/v3/workbooks/${wb2Id}`, { tags: [tagId] });
        console.log(`  ${mark(wbTag.status)} PATCH workbook with tags (likely 404)`);
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // EXP 4: Attributes Catalog Deep Dive (TODO-023)
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 4: Attributes Catalog Deep Dive\n");

    const attrs = await hit("4a", "GET", "/v3/attributes");
    const attrMap = attrs.body?.attributeDescriptionsMap?.waterfallAttributes || {};
    const attrKeys = Object.keys(attrMap);
    console.log(`  Total attributes: ${attrKeys.length}`);

    // Categorize
    const personAttrs = attrKeys.filter(k => k.startsWith("person/"));
    const companyAttrs = attrKeys.filter(k => k.startsWith("company/"));
    const otherAttrs = attrKeys.filter(k => !k.startsWith("person/") && !k.startsWith("company/"));
    console.log(`  Person: ${personAttrs.length}, Company: ${companyAttrs.length}, Other: ${otherAttrs.length}`);

    // List all with their types
    console.log("\n  Person attributes:");
    for (const k of personAttrs.sort()) {
      const a = attrMap[k];
      console.log(`    ${k}: ${a.displayName} (${a.dataTypeSettings?.type || "?"}) popular=${a.isPopular} actions=${(a.actionIds || []).length}`);
    }
    console.log("\n  Company attributes:");
    for (const k of companyAttrs.sort()) {
      const a = attrMap[k];
      console.log(`    ${k}: ${a.displayName} (${a.dataTypeSettings?.type || "?"}) popular=${a.isPopular} actions=${(a.actionIds || []).length}`);
    }
    if (otherAttrs.length > 0) {
      console.log("\n  Other attributes:");
      for (const k of otherAttrs) console.log(`    ${k}: ${JSON.stringify(attrMap[k]).substring(0, 100)}`);
    }

    // Check for attributeProviderPathMap
    const providerMap = attrs.body?.attributeProviderPathMap;
    if (providerMap) {
      console.log(`\n  attributeProviderPathMap keys: ${Object.keys(providerMap).length}`);
      const sampleKey = Object.keys(providerMap)[0];
      console.log(`  Sample: ${sampleKey} → ${JSON.stringify(providerMap[sampleKey]).substring(0, 300)}`);
    }

    // ══════════════════════════════════════════════════════════════════
    // EXP 5: Single Field Read + New Endpoints (TODO-047)
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 5: New Endpoint Discovery\n");

    const probes = [
      ["GET", `/v3/tables/${impTableId}/fields/${impFieldId}`],
      ["GET", `/v3/tables/${impTableId}/fields`],
      ["GET", `/v3/tables/${impTableId}/schema`],
      ["GET", `/v3/tables/${impTableId}/metadata`],
      ["GET", `/v3/tables/${impTableId}/stats`],
      ["GET", `/v3/fields/${impFieldId}`],
      ["POST", `/v3/tables/${impTableId}/fields/batch`, { fields: [{ name: "Batch1", type: "text" }] }],
      ["GET", `/v3/tables/${impTableId}/views/${impView}/filter`],
      ["GET", `/v3/tables/${impTableId}/views/${impView}/sort`],
      ["GET", `/v3/tables/${impTableId}/sources`],
      ["GET", `/v3/tables/${impTableId}/records/count`],
      ["GET", `/v3/tables/${impTableId}/workbook`],
    ];

    for (const [method, path, body] of probes) {
      await delay(50);
      const r = await hit("5", method as string, path as string, body);
      console.log(`  ${mark(r.status)} ${method} ${(path as string).replace(impTableId!, "{tbl}").replace(impFieldId!, "{fld}").replace(impView!, "{view}")}: ${JSON.stringify(r.body).substring(0, 150)}`);
    }

    // ══════════════════════════════════════════════════════════════════
    // EXP 6: Source Type Exploration
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> EXP 6: Source Types & Settings\n");

    // Read all sources
    const sources = await hit("6a", "GET", `/v3/sources?workspaceId=${WORKSPACE}`);
    const srcList = sources.body || [];
    console.log(`  ${Array.isArray(srcList) ? srcList.length : 0} sources`);

    // Catalog source types
    if (Array.isArray(srcList)) {
      const types = new Map<string, number>();
      for (const s of srcList) {
        types.set(s.type || "unknown", (types.get(s.type || "unknown") || 0) + 1);
      }
      console.log(`  Source types: ${[...types.entries()].map(([k, v]) => `${k}(${v})`).join(", ")}`);

      // Dump first source of each type
      const seen = new Set<string>();
      for (const s of srcList) {
        if (!seen.has(s.type)) {
          seen.add(s.type);
          console.log(`\n  Type "${s.type}" sample:`);
          console.log(`    state: ${JSON.stringify(s.state).substring(0, 300)}`);
          console.log(`    typeSettings: ${JSON.stringify(s.typeSettings).substring(0, 300)}`);
          console.log(`    sourceSubscriptions: ${JSON.stringify(s.sourceSubscriptions).substring(0, 200)}`);
        }
      }
    }

  } finally {
    // Cleanup
    for (const tid of tablesToClean) {
      if (tid) { await delay(200); await hit("cleanup", "DELETE", `/v3/tables/${tid}`); }
    }
    for (const tagId of tagsToclean) {
      await delay(100);
      await hit("cleanup-tag", "DELETE", `/v3/workspaces/${WORKSPACE}/resource-tags/${tagId}`);
    }
    const out = path.join(__dirname, "..", "results", `investigate-session-10a-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    console.log(`\nResults saved to ${out}`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
