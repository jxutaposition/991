import { NextResponse } from "next/server";
import { Pool } from "pg";
import type { DeepDiveRecord, DeepDiveResult, Investor } from "../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const databaseUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : undefined;
databaseUrl?.searchParams.delete("sslmode");

const pool = new Pool({
  connectionString: databaseUrl?.toString(),
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

let initialized = false;

async function ensureTables() {
  if (initialized) return;
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not configured");
  await pool.query(`
    create table if not exists investor_deep_dives (
      investor_id text primary key,
      status text not null,
      result jsonb,
      error text,
      updated_at timestamptz not null default now()
    )
  `);
  initialized = true;
}

export async function GET(req: Request) {
  try {
    await ensureTables();
    const investorId = new URL(req.url).searchParams.get("investorId");
    const { rows } = investorId
      ? await pool.query(
        "select investor_id, status, result, error, updated_at from investor_deep_dives where investor_id = $1",
        [investorId],
      )
      : await pool.query("select investor_id, status, result, error, updated_at from investor_deep_dives");

    const deepDives = rows.map(rowToRecord);
    return NextResponse.json({ deepDives });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "deep dive load failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    await ensureTables();
    const body = await req.json();
    const investorId = String(body?.investorId || "");
    if (!investorId) return NextResponse.json({ error: "missing investorId" }, { status: 400 });

    const investor = await loadInvestor(investorId);
    if (!investor) return NextResponse.json({ error: "investor not found" }, { status: 404 });

    await upsertStatus(investorId, "running", null, null);
    try {
      const research = await collectResearch(investor);
      const result = await synthesizeDeepDive(investor, research);
      await upsertStatus(investorId, "complete", result, null);
      return NextResponse.json({ deepDive: { investorId, status: "complete", result, error: null, updatedAt: new Date().toISOString() } });
    } catch (err) {
      const message = err instanceof Error ? err.message : "deep dive failed";
      await upsertStatus(investorId, "error", null, message);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "deep dive failed" }, { status: 500 });
  }
}

async function loadInvestor(investorId: string): Promise<Investor | null> {
  const { rows } = await pool.query<{ profile: Investor }>(
    "select profile from investor_profiles where id = $1",
    [investorId],
  );
  return rows[0]?.profile ?? null;
}

async function upsertStatus(investorId: string, status: string, result: DeepDiveResult | null, error: string | null) {
  await pool.query(
    `insert into investor_deep_dives (investor_id, status, result, error, updated_at)
     values ($1, $2, $3::jsonb, $4, now())
     on conflict (investor_id) do update
     set status = excluded.status, result = excluded.result, error = excluded.error, updated_at = now()`,
    [investorId, status, result ? JSON.stringify(result) : null, error],
  );
}

async function collectResearch(investor: Investor) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not configured");

  const identity = `${investor.name}${investor.firm ? ` ${investor.firm}` : ""}`;
  const queries = [
    `"${investor.name}" pre-seed angel investment portfolio`,
    `"${investor.name}" "${investor.firm}" seed pre-seed investments`,
    `"${investor.name}" startup founder announced angel investor`,
    `"${investor.name}" site:x.com startup angel investor`,
    `"${investor.name}" site:linkedin.com/posts startup investment`,
    `"${identity}" interview investment thesis founders`,
  ];

  const results = [];
  for (const query of queries) {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "advanced",
        include_answer: true,
        include_raw_content: false,
        max_results: 6,
      }),
    });
    if (!res.ok) throw new Error(`Tavily search failed: ${res.status}`);
    const json = await res.json();
    results.push({
      query,
      answer: json.answer || "",
      results: (json.results || []).map((item: { title?: string; url?: string; content?: string }) => ({
        title: item.title || "",
        url: item.url || "",
        content: item.content || "",
      })),
    });
  }
  return results;
}

async function synthesizeDeepDive(investor: Investor, research: unknown): Promise<DeepDiveResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
  const model = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";

  const prompt = `You are doing investor diligence for a founder.

Investor profile:
${JSON.stringify({
    name: investor.name,
    firm: investor.firm,
    role: investor.role,
    linkedin: investor.linkedin,
    notes: investor.notes,
    thesis_blurb: investor.thesis_blurb,
    portfolio: investor.portfolio,
    network_signals: investor.network_signals,
    sector_focus: investor.sector_focus,
    stage_focus: investor.stage_focus,
  }, null, 2)}

Web research snippets:
${JSON.stringify(research, null, 2)}

Answer these questions:
1. What pre-seed investments have this person and fund, if applicable, made all time? If a deal is not obviously pre-seed, include it only if evidence strongly suggests an earliest-stage angel/pre-seed/seed-style bet.
2. If direct investment lists are incomplete, infer carefully from X, LinkedIn, blogs, interviews, founder announcements, and news coverage. Do not invent deals.
3. What patterns appear across founders, traction, and product?
4. For each company, who are the founders, what are their backgrounds, why are they the right people according to public evidence, and why did this investor likely invest or how does it match their thesis?

Return strict JSON only, no markdown, in this exact shape:
{
  "investor": { "name": string, "firm": string },
  "preSeedInvestments": [
    {
      "company": string,
      "oneLine": string,
      "stage": string,
      "roundDate": string,
      "amount": string,
      "investorRole": string,
      "product": string,
      "tractionAtInvestment": string,
      "founders": [
        { "name": string, "background": string, "whyRightPerson": string, "evidence": string }
      ],
      "whyInvestorLikelyInvested": string,
      "thesisMatch": string,
      "sources": [
        { "title": string, "url": string, "evidence": string }
      ],
      "confidence": "high" | "medium" | "low"
    }
  ],
  "patterns": {
    "founders": string,
    "traction": string,
    "product": string,
    "investorThesis": string
  },
  "researchNotes": string,
  "gaps": string[]
}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      temperature: 0.1,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic request failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = json.content?.map((part: { type: string; text?: string }) => part.type === "text" ? part.text || "" : "").join("") || "";
  return parseJson(text);
}

function parseJson(text: string): DeepDiveResult {
  try {
    return JSON.parse(text) as DeepDiveResult;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("LLM did not return JSON");
    return JSON.parse(match[0]) as DeepDiveResult;
  }
}

function rowToRecord(row: { investor_id: string; status: string; result: DeepDiveResult | null; error: string | null; updated_at: Date }): DeepDiveRecord {
  return {
    investorId: row.investor_id,
    status: row.status as DeepDiveRecord["status"],
    result: row.result,
    error: row.error,
    updatedAt: row.updated_at.toISOString(),
  };
}
