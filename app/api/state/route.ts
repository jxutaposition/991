import { NextResponse } from "next/server";
import { Pool } from "pg";
import type { Decision, DecisionMap } from "../../../lib/types";

export const runtime = "nodejs";

type QueueName = "lgm" | "lgmMissingLinkedIn" | "more";

const QUEUE_KIND: Record<QueueName, string> = {
  lgm: "queue:lgm",
  lgmMissingLinkedIn: "queue:lgm_missing_linkedin",
  more: "queue:more",
};

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
    create table if not exists investor_swipe_state (
      kind text not null,
      entity_id text not null,
      value text not null,
      updated_at timestamptz not null default now(),
      primary key (kind, entity_id)
    )
  `);
  initialized = true;
}

export async function GET() {
  try {
    await ensureTable();
    const { rows } = await pool.query<{ kind: string; entity_id: string; value: string }>(
      "select kind, entity_id, value from investor_swipe_state"
    );
    const decisions: DecisionMap = {};
    const lgmQueue: string[] = [];
    const lgmMissingLinkedInQueue: string[] = [];
    const moreQueue: string[] = [];
    const lgmSynced: Record<string, string> = {};

    for (const row of rows) {
      if (row.kind === "decision") decisions[row.entity_id] = row.value as Decision;
      else if (row.kind === QUEUE_KIND.lgm) lgmQueue.push(row.entity_id);
      else if (row.kind === QUEUE_KIND.lgmMissingLinkedIn) lgmMissingLinkedInQueue.push(row.entity_id);
      else if (row.kind === QUEUE_KIND.more) moreQueue.push(row.entity_id);
      else if (row.kind === "lgm_synced") lgmSynced[row.entity_id] = row.value;
    }

    return NextResponse.json({ decisions, lgmQueue, lgmMissingLinkedInQueue, moreQueue, lgmSynced });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "state load failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    await ensureTable();
    const body = await req.json();
    const op = body?.op;

    if (op === "saveDecision") {
      await upsert("decision", body.id, body.decision);
    } else if (op === "queue") {
      await upsert(QUEUE_KIND[body.queue as QueueName], body.id, "1");
    } else if (op === "dequeue") {
      await remove(QUEUE_KIND[body.queue as QueueName], body.id);
    } else if (op === "markSynced") {
      await upsert("lgm_synced", body.id, new Date().toISOString());
      await remove(QUEUE_KIND.lgm, body.id);
    } else if (op === "clear") {
      await pool.query("delete from investor_swipe_state");
    } else {
      return NextResponse.json({ error: "unknown op" }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "state update failed" }, { status: 500 });
  }
}

async function upsert(kind: string | undefined, id: string | undefined, value: string | undefined) {
  if (!kind || !id || !value) throw new Error("missing state fields");
  await pool.query(
    `insert into investor_swipe_state (kind, entity_id, value, updated_at)
     values ($1, $2, $3, now())
     on conflict (kind, entity_id) do update set value = excluded.value, updated_at = now()`,
    [kind, id, value]
  );
}

async function remove(kind: string | undefined, id: string | undefined) {
  if (!kind || !id) throw new Error("missing state fields");
  await pool.query("delete from investor_swipe_state where kind = $1 and entity_id = $2", [kind, id]);
}
