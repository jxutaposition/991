/**
 * Session 11A: Formula Language Capabilities + Enrichment Result Extraction
 *
 * TODO-049: Map the full formula language
 * TODO-052: Can formulas extract structured data from enrichment results?
 *
 * CREDIT COST: 1 enrichment execution (normalize-company-name on 1 row)
 *
 * Usage:
 *   CLAY_WORKSPACE="1080480" npx tsx investigate-session-11a-formulas.ts
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
    return { probe, method, url: urlPath, status: 0, body: null, error: err.message };
  }
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Session 11A: Formula Language + Enrichment Extraction          ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  const me = await hit("0", "GET", "/v3/me");
  if (me.status === 401) { console.error("Session expired."); process.exit(1); }
  const apiToken = me.body?.apiToken;
  console.log(`Session OK: ${me.body?.email}`);
  console.log(`API Token from /v3/me: ${apiToken ? apiToken.substring(0, 10) + "..." : "none"}\n`);

  let tableId: string | null = null;

  try {
    // Create table with test data
    const t = await hit("init", "POST", "/v3/tables", {
      workspaceId: parseInt(WORKSPACE), type: "spreadsheet", name: "INV-formula-lab"
    });
    tableId = t.body?.table?.id;
    await delay(500);

    const s = await hit("s", "GET", `/v3/tables/${tableId}`);
    const viewId = ((s.body?.table || s.body)?.gridViews || [])[0]?.id;

    // Create input columns
    const cols: Record<string, string> = {};
    const colDefs = [
      { name: "Text", type: "text", ts: { dataTypeSettings: { type: "text" } } },
      { name: "Number", type: "text", ts: { dataTypeSettings: { type: "number" } } },
      { name: "URL", type: "text", ts: { dataTypeSettings: { type: "url" } } },
      { name: "Email", type: "text", ts: { dataTypeSettings: { type: "email" } } },
      { name: "JSON Data", type: "text", ts: { dataTypeSettings: { type: "json" } } },
    ];

    for (const cd of colDefs) {
      await delay(80);
      const c = await hit(`col-${cd.name}`, "POST", `/v3/tables/${tableId}/fields`, {
        name: cd.name, type: cd.type, typeSettings: cd.ts, activeViewId: viewId
      });
      cols[cd.name] = c.body?.field?.id;
    }

    // Create enrichment column (1 credit cost)
    await delay(80);
    const enrichCol = await hit("col-enrich", "POST", `/v3/tables/${tableId}/fields`, {
      name: "Enriched", type: "action",
      typeSettings: {
        actionKey: "normalize-company-name",
        actionPackageId: "6c973999-fb78-4a5a-8d99-d2fee5b73878",
        inputsBinding: [{ name: "companyName", formulaText: `{{${cols["Text"]}}}` }],
        dataTypeSettings: { type: "json" }
      },
      activeViewId: viewId
    });
    cols["Enriched"] = enrichCol.body?.field?.id;

    // Enable autoRun so enrichment fires on insert
    await hit("autorun", "PATCH", `/v3/tables/${tableId}`, { tableSettings: { autoRun: true } });

    console.log(`Fields: ${Object.entries(cols).map(([k, v]) => `${k}=${v}`).join(", ")}\n`);

    // Insert ONE test row (1 credit for enrichment)
    await delay(200);
    await hit("row", "POST", `/v3/tables/${tableId}/records`, {
      records: [{
        cells: {
          [cols["Text"]]: "Anthropic",
          [cols["Number"]]: "42.7",
          [cols["URL"]]: "https://www.anthropic.com/research/papers",
          [cols["Email"]]: "hello@anthropic.com",
          [cols["JSON Data"]]: '{"key": "value", "nested": {"deep": true}, "arr": [1,2,3]}'
        }
      }]
    });

    // Wait for enrichment
    console.log("Waiting 5s for enrichment...\n");
    await delay(5000);

    // ══════════════════════════════════════════════════════════════════
    // FORMULA TESTS — All free after this point
    // ══════════════════════════════════════════════════════════════════

    const formulaTests: { name: string; formula: string }[] = [
      // String operations
      { name: "UPPER", formula: `UPPER({{${cols["Text"]}}})` },
      { name: "LOWER", formula: `LOWER({{${cols["Text"]}}})` },
      { name: "LEN", formula: `LEN({{${cols["Text"]}}})` },
      { name: "TRIM", formula: `TRIM("  hello  ")` },
      { name: "concat", formula: `{{${cols["Text"]}}} + " Inc"` },
      { name: "template", formula: `"Company: " + {{${cols["Text"]}}}` },
      { name: "includes", formula: `{{${cols["Text"]}}}?.includes("thro")` },
      { name: "toLowerCase", formula: `{{${cols["Text"]}}}?.toLowerCase()` },
      { name: "split", formula: `{{${cols["Email"]}}}?.split("@")?.[1]` },
      { name: "replace", formula: `{{${cols["Text"]}}}?.replace("Anthropic", "REPLACED")` },
      { name: "slice", formula: `{{${cols["Text"]}}}?.slice(0, 3)` },
      { name: "startsWith", formula: `{{${cols["Text"]}}}?.startsWith("Ant")` },

      // Domain/URL extraction
      { name: "DOMAIN", formula: `DOMAIN({{${cols["URL"]}}})` },
      { name: "url-match", formula: `{{${cols["URL"]}}}?.match(/https?:\\/\\/([^/]+)/)?.[1]` },

      // Number operations
      { name: "parseInt", formula: `parseInt({{${cols["Number"]}}})` },
      { name: "parseFloat", formula: `parseFloat({{${cols["Number"]}}})` },
      { name: "Math.round", formula: `Math.round({{${cols["Number"]}}})` },
      { name: "Math.floor", formula: `Math.floor({{${cols["Number"]}}})` },
      { name: "multiply", formula: `{{${cols["Number"]}}} * 2` },
      { name: "toFixed", formula: `parseFloat({{${cols["Number"]}}})?.toFixed(0)` },

      // Conditional logic
      { name: "ternary", formula: `{{${cols["Number"]}}} > 50 ? "high" : "low"` },
      { name: "nullish", formula: `{{${cols["Text"]}}} || "default"` },
      { name: "AND", formula: `{{${cols["Text"]}}} && {{${cols["Number"]}}} > 10` },
      { name: "NOT", formula: `!{{${cols["Text"]}}}` },
      { name: "equality", formula: `{{${cols["Text"]}}} === "Anthropic"` },

      // JSON operations
      { name: "JSON.parse", formula: `JSON.parse({{${cols["JSON Data"]}}})?.key` },
      { name: "JSON-nested", formula: `JSON.parse({{${cols["JSON Data"]}}})?.nested?.deep` },
      { name: "JSON-array", formula: `JSON.parse({{${cols["JSON Data"]}}})?.arr?.[0]` },
      { name: "JSON-arrlen", formula: `JSON.parse({{${cols["JSON Data"]}}})?.arr?.length` },
      { name: "typeof", formula: `typeof {{${cols["Text"]}}}` },
      { name: "typeof-num", formula: `typeof {{${cols["Number"]}}}` },
      { name: "JSON.stringify", formula: `JSON.stringify({text: {{${cols["Text"]}}}, num: {{${cols["Number"]}}}})` },

      // Enrichment result extraction (TODO-052)
      { name: "enrich-raw", formula: `{{${cols["Enriched"]}}}` },
      { name: "enrich-typeof", formula: `typeof {{${cols["Enriched"]}}}` },
      { name: "enrich-stringify", formula: `JSON.stringify({{${cols["Enriched"]}}})` },
      { name: "enrich-?.original", formula: `{{${cols["Enriched"]}}}?.original_name` },
      { name: "enrich-?.normalized", formula: `{{${cols["Enriched"]}}}?.normalized_name` },
      { name: "enrich-keys", formula: `Object.keys({{${cols["Enriched"]}}} || {})` },
      { name: "enrich-keys-str", formula: `JSON.stringify(Object.keys({{${cols["Enriched"]}}} || {}))` },

      // Date operations
      { name: "Date-now", formula: `new Date().toISOString()` },
      { name: "Date-year", formula: `new Date().getFullYear()` },

      // Clay utility functions
      { name: "Clay.formatJSON", formula: `Clay.formatForJSON({{${cols["Text"]}}})` },

      // Array operations
      { name: "array-create", formula: `[1, 2, 3].join(", ")` },
      { name: "array-map", formula: `[1, 2, 3].map(x => x * 2).join(", ")` },
      { name: "array-filter", formula: `[1, 2, 3, 4, 5].filter(x => x > 3).join(", ")` },
    ];

    console.log(">>> Creating formula columns...\n");
    const formulaFieldIds: { name: string; id: string }[] = [];

    for (const ft of formulaTests) {
      await delay(60);
      const r = await hit(`f-${ft.name}`, "POST", `/v3/tables/${tableId}/fields`, {
        name: `F: ${ft.name}`, type: "formula",
        typeSettings: { formulaText: ft.formula, formulaType: "text", dataTypeSettings: { type: "text" } },
        activeViewId: viewId
      });
      const fid = r.body?.field?.id;
      const err = r.body?.field?.settingsError;
      if (r.status === 200 && fid) {
        formulaFieldIds.push({ name: ft.name, id: fid });
        if (err) console.log(`  ⚠️ ${ft.name}: created but settingsError: ${JSON.stringify(err)}`);
      } else {
        console.log(`  ❌ ${ft.name}: ${r.status} — ${JSON.stringify(r.body).substring(0, 150)}`);
      }
    }
    console.log(`\n  Created ${formulaFieldIds.length}/${formulaTests.length} formula columns\n`);

    // Wait for formula evaluation
    await delay(2000);

    // Read ALL results
    console.log(">>> Reading formula results...\n");
    const rows = await hit("read", "GET", `/v3/tables/${tableId}/views/${viewId}/records?limit=10`);
    const record = (rows.body?.results || [])[0];

    if (record) {
      for (const ff of formulaFieldIds) {
        const cell = record.cells?.[ff.id];
        const val = cell?.value;
        const status = cell?.metadata?.status;
        const err = cell?.metadata?.errorMessage;
        const formula = formulaTests.find(ft => ft.name === ff.name)?.formula || "";
        console.log(`  ${status === "SUCCESS" ? "✅" : status === "ERROR" ? "❌" : "⚠️"} ${ff.name}: ${JSON.stringify(val)} (status: ${status || "none"})`);
        if (err) console.log(`     error: ${err}`);
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // API KEY AUTH TEST (TODO-053) — FREE
    // ══════════════════════════════════════════════════════════════════
    console.log("\n\n>>> API Key Auth Test (TODO-053)\n");

    if (apiToken) {
      // Try using apiToken from /v3/me as Bearer auth
      const authTests = [
        { name: "Bearer token", headers: { Authorization: `Bearer ${apiToken}` } },
        { name: "X-Api-Key", headers: { "X-Api-Key": apiToken } },
        { name: "Api-Key", headers: { "Api-Key": apiToken } },
      ];

      for (const at of authTests) {
        const url = `${API_BASE}/v3/me`;
        const resp = await fetch(url, { headers: { Accept: "application/json", ...at.headers } });
        const body = await resp.json().catch(() => resp.text());
        console.log(`  ${at.name}: ${resp.status} — ${JSON.stringify(body).substring(0, 100)}`);
      }

      // Also try creating an API key
      console.log("\n  Creating API key...");
      const createKey = await hit("apikey-create", "POST", "/v3/api-keys", {
        resourceType: "user",
        resourceId: String(me.body?.id),
        name: "inv-test-key"
      });
      console.log(`  POST /v3/api-keys: ${createKey.status} — ${JSON.stringify(createKey.body).substring(0, 300)}`);
    }

  } finally {
    if (tableId) {
      await delay(200);
      await hit("cleanup", "DELETE", `/v3/tables/${tableId}`);
    }
    const out = path.join(__dirname, "..", "results", `investigate-session-11a-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    console.log(`\nResults saved to ${out}`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
