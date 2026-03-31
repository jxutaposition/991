#!/bin/bash
# Block Bash access to other owner directories and system writes
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Get this owner's ID from directory name
OWNER_ID=$(basename "$(cd "$(dirname "$0")/../.." && pwd)")

# Block access to other owners
OWNERS_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
for dir in "$OWNERS_DIR"/*/; do
  other="$(basename "$dir")"
  if [[ "$other" != "$OWNER_ID" ]] && echo "$CMD" | grep -q "$other"; then
    echo "Blocked: cannot access $other's directory" >&2
    exit 2
  fi
done

# Block writes to system skills
if echo "$CMD" | grep -qE 'system/skills.*(>|>>|tee|cp|mv|rm|sed|awk)'; then
  echo "Blocked: system skills are read-only" >&2
  exit 2
fi

exit 0
