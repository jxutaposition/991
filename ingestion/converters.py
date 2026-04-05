"""Format-specific converters that produce clean markdown from structured files.

Each converter takes raw text content and returns readable markdown suitable
for chunking, embedding, and agent consumption. The goal is that ALL files
— regardless of original format — end up as semantically meaningful markdown
before entering the chunking pipeline.

Supported formats:
  - Slack JSON exports (channel history with threads)
  - Generic JSON (pretty-printed with human-readable extraction)
  - CSV / TSV (markdown tables with headers)
  - YAML / TOML (formatted with section headers)
"""

from __future__ import annotations

import csv
import io
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("ingestion-worker")


def convert_to_markdown(content: str, filename: str) -> str:
    """Dispatch to the appropriate converter based on file extension and content.

    Returns the original content unchanged for formats that are already
    markdown-like (.md, .txt) or when no converter applies.
    """
    ext = Path(filename).suffix.lower()

    if ext == ".json":
        return _convert_json(content, filename)
    if ext in (".csv", ".tsv"):
        return _convert_csv(content, filename, delimiter="\t" if ext == ".tsv" else ",")
    if ext in (".yaml", ".yml"):
        return _convert_yaml(content, filename)
    if ext == ".toml":
        return _convert_toml(content, filename)
    if ext == ".xml":
        return _convert_xml(content, filename)

    return content


# ── JSON ──────────────────────────────────────────────────────────────────────

def _convert_json(content: str, filename: str) -> str:
    """Convert JSON to readable markdown.

    Detects Slack exports automatically and delegates to the Slack converter.
    Otherwise falls back to generic JSON extraction.
    """
    try:
        data = json.loads(content)
    except (json.JSONDecodeError, ValueError):
        log.warning("Invalid JSON in %s, treating as plain text", filename)
        return content

    if _is_slack_export(data):
        return _convert_slack_json(data, filename)

    return _convert_generic_json(data, filename)


def _is_slack_export(data) -> bool:
    """Detect Slack channel export format: list of message objects with ts/text."""
    if not isinstance(data, list) or len(data) == 0:
        return False
    sample = data[0]
    return (
        isinstance(sample, dict)
        and "ts" in sample
        and ("text" in sample or "blocks" in sample)
        and ("user" in sample or "bot_id" in sample or "username" in sample)
    )


def _convert_slack_json(messages: list[dict], filename: str) -> str:
    """Convert Slack channel export to readable markdown.

    Groups messages by date, formats threads as nested quotes, resolves
    user IDs to display names where available, and preserves attachments
    and reactions as metadata.
    """
    channel_name = Path(filename).stem
    lines: list[str] = [f"# Slack Channel: #{channel_name}\n"]

    user_cache: dict[str, str] = {}
    for msg in messages:
        if "user_profile" in msg and "display_name" in msg["user_profile"]:
            uid = msg.get("user", "")
            name = msg["user_profile"]["display_name"] or msg["user_profile"].get("real_name", uid)
            if uid:
                user_cache[uid] = name

    current_date = ""
    for msg in messages:
        if msg.get("subtype") in ("channel_join", "channel_leave", "channel_purpose", "channel_topic"):
            continue

        ts = _slack_ts_to_datetime(msg.get("ts", "0"))
        date_str = ts.strftime("%Y-%m-%d")
        time_str = ts.strftime("%H:%M")

        if date_str != current_date:
            current_date = date_str
            lines.append(f"\n## {date_str}\n")

        user = _resolve_slack_user(msg, user_cache)
        text = _clean_slack_text(msg.get("text", ""), user_cache)

        if not text.strip() and not msg.get("files") and not msg.get("attachments"):
            continue

        lines.append(f"**@{user}** ({time_str}): {text}")

        if msg.get("files"):
            for f in msg["files"]:
                fname = f.get("name", f.get("title", "file"))
                lines.append(f"  [Attached: {fname}]")

        if msg.get("attachments"):
            for att in msg["attachments"]:
                att_text = att.get("text", att.get("fallback", ""))
                if att_text:
                    lines.append(f"  > {att_text[:500]}")

        if msg.get("reactions"):
            rxns = ", ".join(
                f":{r['name']}: ({r.get('count', 1)})" for r in msg["reactions"]
            )
            lines.append(f"  Reactions: {rxns}")

        if msg.get("replies"):
            thread_ts = msg.get("thread_ts", msg.get("ts"))
            thread_msgs = [m for m in messages if m.get("thread_ts") == thread_ts and m.get("ts") != msg.get("ts")]
            for reply in thread_msgs[:20]:
                r_ts = _slack_ts_to_datetime(reply.get("ts", "0"))
                r_time = r_ts.strftime("%H:%M")
                r_user = _resolve_slack_user(reply, user_cache)
                r_text = _clean_slack_text(reply.get("text", ""), user_cache)
                if r_text.strip():
                    lines.append(f"  > **@{r_user}** ({r_time}): {r_text}")

        lines.append("")

    return "\n".join(lines)


def _slack_ts_to_datetime(ts_str: str) -> datetime:
    try:
        return datetime.fromtimestamp(float(ts_str), tz=timezone.utc)
    except (ValueError, OSError):
        return datetime(2000, 1, 1, tzinfo=timezone.utc)


def _resolve_slack_user(msg: dict, cache: dict[str, str]) -> str:
    uid = msg.get("user", "")
    if uid in cache:
        return cache[uid]
    if msg.get("username"):
        return msg["username"]
    if msg.get("bot_id"):
        return msg.get("username", "bot")
    return uid or "unknown"


def _clean_slack_text(text: str, user_cache: dict[str, str]) -> str:
    """Clean Slack mrkdwn: resolve user mentions, channel links, URLs."""
    def replace_user_mention(match):
        uid = match.group(1)
        return f"@{user_cache.get(uid, uid)}"

    text = re.sub(r"<@(\w+)>", replace_user_mention, text)
    text = re.sub(r"<#\w+\|([^>]+)>", r"#\1", text)
    text = re.sub(r"<(https?://[^|>]+)\|([^>]+)>", r"[\2](\1)", text)
    text = re.sub(r"<(https?://[^>]+)>", r"\1", text)
    return text


# ── Generic JSON ──────────────────────────────────────────────────────────────

def _convert_generic_json(data, filename: str) -> str:
    """Convert arbitrary JSON to readable markdown.

    Strategy: extract human-readable fields (name, title, description, text,
    content, summary, body, message) into sections, and include the full
    structure as pretty-printed JSON for reference.
    """
    lines: list[str] = [f"# {Path(filename).stem}\n"]

    if isinstance(data, list):
        lines.append(f"Array of {len(data)} items.\n")
        for i, item in enumerate(data[:100]):
            lines.append(f"## Item {i + 1}\n")
            lines.append(_extract_readable_fields(item))
        if len(data) > 100:
            lines.append(f"\n*... and {len(data) - 100} more items (truncated)*\n")
    elif isinstance(data, dict):
        lines.append(_extract_readable_fields(data))
    else:
        lines.append(f"```json\n{json.dumps(data, indent=2, default=str)[:10000]}\n```\n")

    return "\n".join(lines)


_READABLE_KEYS = {
    "name", "title", "description", "text", "content", "summary",
    "body", "message", "comment", "note", "label", "question",
    "answer", "subject", "heading", "paragraph", "value",
    "email", "url", "address", "phone", "status", "type", "role",
}


def _extract_readable_fields(obj, depth: int = 0) -> str:
    """Recursively extract human-readable fields from a JSON object."""
    if depth > 4:
        return ""
    if not isinstance(obj, dict):
        s = str(obj)
        return s[:2000] if len(s) > 2000 else s

    lines: list[str] = []
    prefix = "  " * depth

    for key, value in obj.items():
        key_lower = key.lower().replace("_", "").replace("-", "")
        if isinstance(value, str) and len(value) > 0:
            if any(rk in key_lower for rk in _READABLE_KEYS) or len(value) > 50:
                display_val = value[:2000] if len(value) > 2000 else value
                lines.append(f"{prefix}**{key}**: {display_val}\n")
            elif len(value) <= 200:
                lines.append(f"{prefix}**{key}**: {value}\n")
        elif isinstance(value, dict):
            child = _extract_readable_fields(value, depth + 1)
            if child.strip():
                lines.append(f"{prefix}**{key}**:\n{child}")
        elif isinstance(value, list) and len(value) > 0:
            if all(isinstance(v, str) for v in value):
                joined = ", ".join(str(v) for v in value[:20])
                lines.append(f"{prefix}**{key}**: {joined}\n")
            elif all(isinstance(v, dict) for v in value):
                for j, item in enumerate(value[:10]):
                    child = _extract_readable_fields(item, depth + 1)
                    if child.strip():
                        lines.append(f"{prefix}- **{key}[{j}]**:\n{child}")
        elif value is not None:
            lines.append(f"{prefix}**{key}**: {value}\n")

    return "".join(lines)


# ── CSV / TSV ─────────────────────────────────────────────────────────────────

def _convert_csv(content: str, filename: str, delimiter: str = ",") -> str:
    """Convert CSV/TSV to markdown tables, splitting into sections if large."""
    lines: list[str] = [f"# {Path(filename).stem}\n"]

    try:
        reader = csv.reader(io.StringIO(content), delimiter=delimiter)
        rows = list(reader)
    except csv.Error:
        log.warning("Failed to parse CSV %s, treating as plain text", filename)
        return content

    if not rows:
        return content

    headers = rows[0]
    data_rows = rows[1:]

    lines.append(f"Table with {len(data_rows)} rows and {len(headers)} columns.\n")

    SECTION_SIZE = 50
    for section_start in range(0, len(data_rows), SECTION_SIZE):
        section_end = min(section_start + SECTION_SIZE, len(data_rows))
        if len(data_rows) > SECTION_SIZE:
            lines.append(f"## Rows {section_start + 1}-{section_end}\n")

        lines.append("| " + " | ".join(_sanitize_cell(h) for h in headers) + " |")
        lines.append("| " + " | ".join("---" for _ in headers) + " |")

        for row in data_rows[section_start:section_end]:
            padded = row + [""] * (len(headers) - len(row))
            lines.append("| " + " | ".join(_sanitize_cell(c) for c in padded[:len(headers)]) + " |")

        lines.append("")

    return "\n".join(lines)


def _sanitize_cell(text: str) -> str:
    """Sanitize a cell value for markdown tables."""
    text = text.replace("|", "\\|").replace("\n", " ").replace("\r", "")
    if len(text) > 200:
        text = text[:197] + "..."
    return text


# ── YAML ──────────────────────────────────────────────────────────────────────

def _convert_yaml(content: str, filename: str) -> str:
    """Convert YAML to readable markdown with section headers."""
    try:
        import yaml
        data = yaml.safe_load(content)
    except Exception:
        return f"# {Path(filename).stem}\n\n```yaml\n{content[:20000]}\n```\n"

    if data is None:
        return content

    lines: list[str] = [f"# {Path(filename).stem}\n"]

    if isinstance(data, dict):
        for key, value in data.items():
            lines.append(f"## {key}\n")
            if isinstance(value, (dict, list)):
                lines.append(f"```yaml\n{_yaml_dump(value)}\n```\n")
            else:
                lines.append(f"{value}\n")
    else:
        lines.append(f"```yaml\n{_yaml_dump(data)}\n```\n")

    return "\n".join(lines)


def _yaml_dump(obj) -> str:
    try:
        import yaml
        return yaml.dump(obj, default_flow_style=False, allow_unicode=True).strip()
    except Exception:
        return str(obj)[:10000]


# ── TOML ──────────────────────────────────────────────────────────────────────

def _convert_toml(content: str, filename: str) -> str:
    """Convert TOML to readable markdown with section headers."""
    try:
        import tomllib
    except ImportError:
        try:
            import tomli as tomllib  # type: ignore[no-redef]
        except ImportError:
            return f"# {Path(filename).stem}\n\n```toml\n{content[:20000]}\n```\n"

    try:
        data = tomllib.loads(content)
    except Exception:
        return f"# {Path(filename).stem}\n\n```toml\n{content[:20000]}\n```\n"

    lines: list[str] = [f"# {Path(filename).stem}\n"]

    for key, value in data.items():
        lines.append(f"## {key}\n")
        if isinstance(value, dict):
            for sub_key, sub_value in value.items():
                if isinstance(sub_value, (dict, list)):
                    lines.append(f"**{sub_key}**:\n```\n{json.dumps(sub_value, indent=2, default=str)}\n```\n")
                else:
                    lines.append(f"**{sub_key}**: {sub_value}\n")
        elif isinstance(value, list):
            for item in value:
                lines.append(f"- {item}\n")
        else:
            lines.append(f"{value}\n")

    return "\n".join(lines)


# ── XML ───────────────────────────────────────────────────────────────────────

def _convert_xml(content: str, filename: str) -> str:
    """Convert XML to readable markdown by extracting text content."""
    try:
        import xml.etree.ElementTree as ET
        root = ET.fromstring(content)
    except Exception:
        return f"# {Path(filename).stem}\n\n```xml\n{content[:20000]}\n```\n"

    lines: list[str] = [f"# {Path(filename).stem}\n"]
    _xml_to_markdown(root, lines, depth=0)
    return "\n".join(lines)


def _xml_to_markdown(element, lines: list[str], depth: int) -> None:
    if depth > 6:
        return

    tag = element.tag.split("}")[-1] if "}" in element.tag else element.tag
    text = (element.text or "").strip()
    tail = (element.tail or "").strip()

    has_children = len(element) > 0

    if has_children:
        if depth <= 2:
            lines.append(f"{'#' * (depth + 2)} {tag}\n")
        else:
            lines.append(f"{'  ' * depth}**{tag}**:\n")
        for child in element:
            _xml_to_markdown(child, lines, depth + 1)
    elif text:
        lines.append(f"{'  ' * depth}**{tag}**: {text[:2000]}\n")

    if tail:
        lines.append(f"{'  ' * depth}{tail[:500]}\n")
