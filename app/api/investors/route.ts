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
  return (investorsData as Investor[])
    .filter(i => !i.israeli)
    .filter(i => Boolean(normalizeLinkedInProfileUrl(i.linkedin)));
}

export async function GET() {
  try {
    await ensureTable();
    const { rows } = await pool.query<{ profile: Investor }>(
      "select profile from investor_profiles order by coalesce((profile->>'score')::int, 0) desc, profile->>'name' asc"
    );
    const investors = rows.map(r => r.profile)
      .filter(i => !i.israeli)
      .filter(i => Boolean(normalizeLinkedInProfileUrl(i.linkedin)));
    return NextResponse.json({ investors });
  } catch (err) {
    console.warn("Falling back to bundled investors", err);
    return NextResponse.json({ investors: fallbackInvestors(), warning: err instanceof Error ? err.message : "investor load failed" });
  }
}
