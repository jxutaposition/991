# Lele — Changes

Owner-specific skill and config changes.

## Entry Format

```yaml
- date: YYYY-MM-DD
  title: "Short description"
  summary: |
    What changed and why.
  files:
    - skills/my-skill/SKILL.md
```

---

## Entries

```yaml
- date: 2026-03-30
  title: "Added client: heyreach"
  summary: |
    Scaffolded client directory with brief.md, people.md, access/.
    Added tier-2 binding to agent.json (placeholder channel ID).
  files:
    - client/heyreach/ (new)
    - agent.json
```
