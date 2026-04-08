#!/usr/bin/env bash
# check-sql-safety.sh — fail the build on unsafe SQL patterns in backend/src.
#
# Two checks:
#
#   1. Any `let *sql* = format!(...)` (SQL built via format!) MUST be preceded
#      by a `// sql-format-ok: <reason>` comment within the 3 lines above it.
#      The annotation says "I have audited this; the only interpolated values
#      are server-controlled (allowlists, hardcoded literals, or `$N` placeholders
#      bound separately via PgArguments)."
#
#   2. The number of `execute_unparameterized(` call sites must not increase
#      beyond the recorded baseline. The unsafe path is intentionally ugly so
#      reviewers spot it; this check makes sure new code doesn't add to it.
#
# Run from `backend/`:
#
#   bash scripts/check-sql-safety.sh
#
# Or set `SQL_SAFETY_BASELINE_UPDATE=1` to refresh the baseline after a
# legitimate migration that intentionally reduces (or, with explicit approval,
# increases) the count.

set -euo pipefail

cd "$(dirname "$0")/.."

SRC_DIR="src"
BASELINE_FILE="scripts/.sql-safety-baseline"

# ── Check 1: format!() SQL without sql-format-ok annotation ────────────────────

unannotated=$(
  find "$SRC_DIR" -name "*.rs" -print0 | xargs -0 awk '
    /let .*sql.* = format!/ {
      if (last1 !~ /sql-format-ok/ && last2 !~ /sql-format-ok/ && last3 !~ /sql-format-ok/ && last4 !~ /sql-format-ok/) {
        print FILENAME":"FNR
      }
    }
    { last4=last3; last3=last2; last2=last1; last1=$0 }
  '
)

if [[ -n "$unannotated" ]]; then
  echo "❌ SQL safety check FAILED — format!()-built SQL without sql-format-ok annotation:"
  echo
  echo "$unannotated"
  echo
  echo "Each occurrence of \`let <name>sql<name> = format!(...)\` building a SQL string"
  echo "MUST be preceded by a \`// sql-format-ok: <reason>\` comment within 3 lines, OR"
  echo "rewritten to use \`db.execute_with(\"... \$1 ...\", pg_args!(value))\`."
  echo
  echo "See CLAUDE.md → Backend → \"SQL safety\"."
  exit 1
fi

# ── Check 2: execute_unparameterized count must not exceed baseline ───────────

current_count=$(grep -rEc 'execute_unparameterized\(' "$SRC_DIR" --include='*.rs' | awk -F: '{sum += $2} END {print sum+0}')

if [[ ! -f "$BASELINE_FILE" ]]; then
  echo "$current_count" > "$BASELINE_FILE"
  echo "ℹ️  No baseline file — initialized $BASELINE_FILE with $current_count"
fi

baseline=$(cat "$BASELINE_FILE")

if [[ "${SQL_SAFETY_BASELINE_UPDATE:-}" = "1" ]]; then
  echo "$current_count" > "$BASELINE_FILE"
  echo "✅ Baseline updated: $baseline → $current_count"
elif [[ "$current_count" -gt "$baseline" ]]; then
  echo "❌ SQL safety check FAILED — execute_unparameterized count went UP."
  echo
  echo "    baseline:  $baseline"
  echo "    current:   $current_count"
  echo
  echo "New code added \`db.execute_unparameterized(...)\` calls. This method is"
  echo "the intentionally-ugly raw-SQL path — see pg.rs for why."
  echo
  echo "Either rewrite your new query as \`db.execute_with(\"... \$1 ...\", pg_args!(...))\`,"
  echo "OR if the raw query is genuinely safe (fully static SQL literal, no interpolation),"
  echo "migrate one of the EXISTING execute_unparameterized sites in the same PR to"
  echo "keep the count flat. The goal is for this number to only ever decrease."
  echo
  echo "Existing sites you could migrate:"
  grep -rn 'execute_unparameterized(' "$SRC_DIR" --include='*.rs' | head -20
  exit 1
elif [[ "$current_count" -lt "$baseline" ]]; then
  echo "✅ execute_unparameterized count decreased: $baseline → $current_count"
  echo "   Run \`SQL_SAFETY_BASELINE_UPDATE=1 bash scripts/check-sql-safety.sh\` to lock in the improvement."
fi

echo "✅ SQL safety check passed (annotated format!() sites: $(grep -rEc 'sql-format-ok' "$SRC_DIR" --include='*.rs' | awk -F: '{sum += $2} END {print sum+0}'); execute_unparameterized sites: $current_count)"
