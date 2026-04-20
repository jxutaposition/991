"""One-off: dump recent execution_sessions + execution_nodes for DB inspection.
Reads DATABASE_URL from backend/.env (no CLI args). Writes redacted summary to stdout."""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
except ImportError:
    print("Install: pip install psycopg2-binary", file=sys.stderr)
    sys.exit(1)

ROOT = Path(__file__).resolve().parents[1]
ENV = ROOT / ".env"


def load_database_url() -> str:
    if not ENV.is_file():
        print(f"Missing {ENV}", file=sys.stderr)
        sys.exit(1)
    text = ENV.read_text(encoding="utf-8", errors="replace")
    m = re.search(r"^DATABASE_URL=(.+)$", text, re.MULTILINE)
    if not m:
        print("DATABASE_URL not found in .env", file=sys.stderr)
        sys.exit(1)
    return m.group(1).strip().strip('"').strip("'")


def main() -> None:
    url = os.environ.get("DATABASE_URL") or load_database_url()
    conn = psycopg2.connect(url)
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, status, client_id, project_id, request_text,
                       created_at, updated_at
                FROM execution_sessions
                ORDER BY created_at DESC
                LIMIT 10
                """
            )
            sessions = cur.fetchall()
            print("=== execution_sessions (last 10) ===")
            for row in sessions:
                rt = (row.get("request_text") or "")[:120]
                print(
                    f"  id={row['id']} status={row['status']} "
                    f"client_id={row['client_id']} project_id={row['project_id']}"
                )
                print(f"    request_text[:120]={rt!r}")
                print(f"    created_at={row.get('created_at')} updated_at={row.get('updated_at')}")

            if not sessions:
                print("(no sessions)")
                return

            for s in sessions[:3]:
                sid = s["id"]
                cur.execute(
                    """
                    SELECT id, agent_slug, status,
                           parent_uid,
                           (parent_uid IS NULL) AS is_orchestrator_root,
                           task_description,
                           created_at
                    FROM execution_nodes
                    WHERE session_id = %s
                    ORDER BY created_at ASC
                    """,
                    (str(sid),),
                )
                nodes = cur.fetchall()
                roots = [n for n in nodes if n["is_orchestrator_root"]]
                print(f"\n=== execution_nodes for session {sid} (count={len(nodes)}) ===")
                print(f"    orchestrator rows (parent_uid IS NULL): {len(roots)}")
                for n in nodes:
                    td = (n.get("task_description") or "")[:80]
                    print(
                        f"  node id={n['id']} slug={n['agent_slug']} status={n['status']} "
                        f"root={n['is_orchestrator_root']} parent_uid={n['parent_uid']}"
                    )
                    print(f"    task[:80]={td!r}")

                cur.execute(
                    """
                    SELECT COUNT(*) AS c FROM node_messages WHERE session_id = %s
                    """,
                    (str(sid),),
                )
                mc = cur.fetchone()["c"]
                print(f"    node_messages total rows: {mc}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
