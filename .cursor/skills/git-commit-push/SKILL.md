---
name: git-commit-push
description: >-
  Reviews the full git working tree (modified, staged, and untracked paths),
  drafts a concise conventional commit message from real diffs, then runs
  git add, commit, and push. Use when the user asks to commit and push, wants a
  commit message from current changes, invokes a commit subagent, or says
  /git-commit-push.
---

# Git: summarize uncommitted work, commit, push

## Goal

Turn **everything not yet committed** (tracked diffs + untracked files) into one clear commit and push it. Treat “not tracked” as **uncommitted**; if the user only wants untracked files, they will say so—in that case stage **only** untracked paths.

## Before you touch git

1. Run from the **repository root** (the directory that contains `.git`).
2. **Do not** `git add` or commit: `.env`, secrets, local-only artifacts, or paths clearly ignored for good reason. If something important is wrongly ignored, say so instead of forcing `-f`.
3. If `git status` is clean, report that and **stop** (no empty commit).

## Inspect changes (required)

Use the shell; do not guess from memory.

1. `git status -sb` — short branch + change list.
2. `git diff` — unstaged changes to **tracked** files.
3. `git diff --staged` — already-staged changes (if any).
4. **Untracked files**: names come from `git status`. For a accurate summary, read new files or use `git add -N <path>` (intent-to-add) then `git diff --staged <path>` to see a patch; remove intent with `git reset <path>` if you do not want them staged yet.

Prefer **small, focused commits**. If the working tree mixes unrelated features, describe that and either:

- ask the user which chunk to commit first, or  
- stage **only** the paths that belong together (`git add path1 path2`).

## Commit message

Follow **Conventional Commits** (`type(scope): subject`):

- **types**: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, etc.
- **subject**: imperative, ~50 chars, no trailing period.
- **body** (optional): what changed and why, wrapped ~72 chars.

Example:

```text
feat(onboarding): add engagement stage and onboarding layout

Wire client engagement stage migration, workspace delete retention,
and frontend onboarding/integrations entry points.
```

Show the user the **final** message before `git commit` when changes are large or ambiguous; otherwise proceed.

## Add, commit, push

1. `git add …` — only paths that belong in this commit.
2. `git commit -m "type(scope): subject" -m "Optional body paragraph(s)."`
3. `git push`:
   - If the branch has no upstream: `git push -u origin HEAD` (adjust remote if not `origin`).

On failure (hooks, conflicts, rejected push), print the error, fix if in scope, or tell the user what is blocking.

## Windows / PowerShell

Commands are the same; use `;` to chain if needed. Stay in the repo root.
