import { NextResponse } from "next/server";
import { Pool } from "pg";
import investorsData from "../../../lib/investors.json";
import type { Investor } from "../../../lib/types";
import { normalizeLinkedInProfileUrl } from "../../../lib/linkedin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const databaseUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : undefined;
databaseUrl?.searchParams.delete("sslmode");

const pool = new Pool({
  connectionString: databaseUrl?.toString(),
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

let initialized = false;

async function ensureTable() {
  if (initialized) return;
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not configured");
  await pool.query(`
    create table if not exists investor_profiles (
      id text primary key,
      profile jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);
  initialized = true;
}

function fallbackInvestors() {
  return visibleInvestors(investorsData as Investor[]);
}

function visibleInvestors(investors: Investor[]) {
  return investors
    .filter(i => !i.israeli)
    .filter(isVisibleInvestor);
}

export async function GET() {
  try {
    await ensureTable();
    const { rows } = await pool.query<{ profile: Investor }>(
      "select profile from investor_profiles order by coalesce((profile->>'score')::int, 0) desc, profile->>'name' asc"
    );
    const profilesById = new Map<string, Investor>();
    for (const investor of investorsData as Investor[]) profilesById.set(investor.id, investor);
    for (const row of rows) profilesById.set(row.profile.id, row.profile);
    const investors = visibleInvestors(Array.from(profilesById.values()))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return NextResponse.json({ investors });
  } catch (err) {
    console.warn("Falling back to bundled investors", err);
    return NextResponse.json({ investors: fallbackInvestors(), warning: err instanceof Error ? err.message : "investor load failed" });
  }
}

function isVisibleInvestor(investor: Investor) {
  return investor.sub_bucket === "manual_add" || Boolean(normalizeLinkedInProfileUrl(investor.linkedin));
}

export async function POST(req: Request) {
  try {
    await ensureTable();
    const body = await req.json();
    const name = String(body?.name || "").trim();
    const rawLinkedIn = String(body?.linkedin || "").trim();
    if (!name) return NextResponse.json({ error: "missing name" }, { status: 400 });

    const linkedin = rawLinkedIn ? normalizeLinkedInProfileUrl(rawLinkedIn) || rawLinkedIn : "";
    const id = await uniqueManualId(name);
    const profile: Investor = {
      id,
      name,
      firm: "Manual add",
      role: "Manually added investor",
      bucket: "cold_angel",
      priority_tier: 2,
      sf_based: true,
      sf_uncertain: true,
      linkedin,
      notes: "Manually added from review page.",
      score: 55,
      portfolio: [],
      writings: [],
      network_signals: ["Manual add"],
      testimonials: [],
      sector_focus: [],
      stage_focus: [],
      leads_rounds: "unknown",
      enriched: false,
      confidence: "low",
      sub_bucket: "manual_add",
    };

    await pool.query(
      `insert into investor_profiles (id, profile, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (id) do update set profile = excluded.profile, updated_at = now()`,
      [id, JSON.stringify(profile)],
    );

    return NextResponse.json({ investor: profile });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "investor add failed" }, { status: 500 });
  }
}

async function uniqueManualId(name: string) {
  const base = `manual-${slugify(name) || "profile"}`;
  let id = base;
  let suffix = 2;
  while (await profileExists(id)) {
    id = `${base}-${suffix++}`;
  }
  return id;
}

async function profileExists(id: string) {
  const { rowCount } = await pool.query("select 1 from investor_profiles where id = $1 limit 1", [id]);
  return Boolean(rowCount);
}

function slugify(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
