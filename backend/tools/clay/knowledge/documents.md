# Clay Documents (RAG)

Clay's document upload feature backs the Documents/RAG product. Use it to attach files an agent or workflow can reference. The flow is two server calls plus one direct S3 POST.

## Endpoints

| Method | Path | Tool | Notes |
|---|---|---|---|
| POST | `/v3/documents/{wsId}/upload-url` | `clay_upload_document` (step 1) | Body `{name (1-500 chars), folderId?, context?}`. Returns `{documentId (doc_…), uploadUrl, fields}`. Default `context` is `'agent_playground'`. |
| (S3) | `uploadUrl` (file-drop-prod bucket) | (handled inline by tool) | `multipart/form-data POST` with `fields` first then the `file` field last. S3 returns 204. |
| POST | `/v3/documents/{wsId}/{documentId}/confirm-upload` | (handled inline) | Body `{}` (or omitted). Returns full document record `{id, name, mimeType, size, context, createdAt, updatedAt, …}`. |
| DELETE | `/v3/documents/{wsId}/{documentId}` | `clay_delete_document` | Query params `?hard=boolean&deleteContents=boolean`. Returns `{success}`. |

## Why a 3-step flow

The agent only sees two tools (`clay_upload_document`, `clay_delete_document`). The S3 POST and `confirm-upload` are wrapped inside `clay_upload_document`'s handler — the agent passes the file content (or a URL/path) and the tool does:
1. POST init to Clay → get S3 policy
2. Multipart POST to S3 → 204
3. POST confirm-upload to Clay → returns full document record

If any step fails, the tool returns the failure with enough detail to retry.

## Gotchas

- The default `context` is `'agent_playground'`. Set it explicitly if the document needs to live elsewhere.
- The S3 POST is to a different bucket (`file-drop-prod`) than the CSV-import flow (`clay-base-import-prod`). Don't conflate them.
- Documents uploaded here are NOT automatically attached to any workflow or table — they're standalone resources you reference by `documentId` from workflow nodes.
- Hard delete (`?hard=true`) is irreversible.
