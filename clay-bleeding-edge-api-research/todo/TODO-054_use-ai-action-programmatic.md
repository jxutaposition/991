# TODO-054: Programmatic AI via use-ai Action

**Priority:** P0 — Turns Clay into an AI pipeline orchestrator
**Status:** Open

## Concept

The `use-ai` action takes `prompt`, `systemPrompt`, `model`, `temperature`, `jsonMode`, `answerSchemaType`, `maxCostInCents` — no auth needed. If we can create this as a column with autoRun, every row insertion automatically runs an LLM on the row data.

## Investigation Plan (1-2 credits)

1. Create table with text input column
2. Create `use-ai` action column: `{actionKey: "use-ai", inputsBinding: [{name: "prompt", formulaText: "Summarize: {{f_text}}"}]}`
3. Insert row → does autoRun trigger the AI?
4. Read the result — what does the AI response look like?
5. Test `jsonMode: true` — does it return structured JSON?
6. Test `answerSchemaType` — can we define output structure?
7. What `model` values are accepted?
