import { NextResponse } from "next/server";
import { Pool } from "pg";

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
    create table if not exists investor_email_enrichment (
      linkedin_handle text primary key,
      email text,
      status text,
      provider text,
      verification text,
      domain text,
      updated_at timestamptz not null default now()
    )
  `);
  initialized = true;
}

export async function GET() {
  try {
    await ensureTable();
    const { rows } = await pool.query<{
      linkedin_handle: string;
      email: string | null;
      status: string | null;
      provider: string | null;
      verification: string | null;
      domain: string | null;
      updated_at: Date;
    }>(
      `select linkedin_handle, email, status, provider, verification, domain, updated_at
       from investor_email_enrichment`
    );

    const emails = Object.fromEntries(rows.map(row => [
      row.linkedin_handle,
      {
        email: row.email || "",
        status: row.status || "",
        provider: row.provider || "",
        verification: row.verification || "",
        domain: row.domain || "",
        updatedAt: row.updated_at.toISOString(),
      },
    ]));

    return NextResponse.json({ emails });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "email enrichment load failed", emails: {} }, { status: 500 });
  }
}
