# Deep Dive: authAccountId Discovery

**Date**: 2026-04-06
**Investigation**: INV-010 (authAccountId + App Accounts)
**Status**: BREAKTHROUGH

## The Discovery

**`GET /v3/app-accounts` returns ALL auth accounts with their IDs.**

This is the #1 most impactful finding in the entire research project. Without it, enrichment column creation required manual user input for every `authAccountId`. Now the agent can:

1. List all available auth accounts: `GET /v3/app-accounts`
2. Filter by provider type (matches `auth.providerType` in actions catalog)
3. Auto-select the right `authAccountId` when creating enrichment columns
4. Fall back to Clay-managed shared accounts when no user-owned account exists

## Endpoint Details

### GET /v3/app-accounts

**Auth**: Session cookie
**Query params**: Optional `workspaceId` (returns same results with or without it)

**Response**: Array of app account objects:
```json
[
  {
    "id": "aa_ZR72u7bn5qmS",
    "name": "Clay-managed ElevenLabs account",
    "appAccountTypeId": "elevenlabs",
    "isSharedPublicKey": true,
    "userOwnerId": null,
    "workspaceOwnerId": 4515,
    "reauthInitiatedByUserId": null,
    "obfuscatedCredentials": null,
    "defaultAccess": "can_use",
    "authMethodId": null,
    "createdAt": "2025-02-06T17:30:40.524Z",
    "updatedAt": "2025-02-06T17:31:46.785Z",
    "deletedAt": null,
    "useStaticIP": false,
    "reauthInitiatedAt": null,
    "abilities": {
      "canUpdate": false,
      "canDelete": false,
      "canAccess": true
    }
  }
]
```

### Key Fields

| Field | Type | Description |
|---|---|---|
| `id` | string | The `authAccountId` to use in enrichment column typeSettings (e.g., `aa_ZR72u7bn5qmS`) |
| `name` | string | Human-readable name |
| `appAccountTypeId` | string | Provider type — matches `auth.providerType` in actions catalog |
| `isSharedPublicKey` | boolean | True = Clay-managed shared account. False = user's own API key |
| `userOwnerId` | number/null | User who owns this account (null for Clay-managed) |
| `workspaceOwnerId` | number | Workspace that owns this account |
| `defaultAccess` | string | Access level (`can_use`) |
| `obfuscatedCredentials` | string/null | Masked credential (e.g., `sk-...xxx`) for user-owned accounts |
| `abilities` | object | CASL permissions (canUpdate, canDelete, canAccess) |
| `useStaticIP` | boolean | Whether to route through Clay's static IP |

### Statistics for Amit's Workspace

- **111 total app accounts**
- **111 Clay-managed (shared)** — these are included in Clay's subscription
- **0 user-owned** — Amit hasn't connected any personal API keys yet
- **87 unique providers** represented

### CRUD Status

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/v3/app-accounts` | **200** | Lists all accounts |
| GET | `/v3/app-accounts?workspaceId=` | **200** | Same result |
| GET | `/v3/workspaces/{id}/app-accounts` | **200** | Same result |
| POST | `/v3/app-accounts` | 404 | Cannot create via API (must use Clay UI) |
| GET | `/v3/app-accounts/{id}` | 404 | Cannot read single account |

## How to Use This

### Auto-wiring enrichment columns

```
1. GET /v3/actions?workspaceId=X → find the action (e.g., apollo-find-people)
2. Note the auth.providerType (e.g., "apollo")
3. GET /v3/app-accounts → find account where appAccountTypeId === "apollo"
4. Use that account's id as authAccountId in the field typeSettings
5. POST /v3/tables/{id}/fields with the complete enrichment column config
```

### Priority: user-owned > Clay-managed

When multiple accounts exist for the same provider:
- Prefer `isSharedPublicKey: false` (user's own API key, higher rate limits)
- Fall back to `isSharedPublicKey: true` (Clay-managed, may have lower limits)

## Additional Discovery: Action Column Creation Requires `actionPackageId`

Creating action columns with just `actionKey` returns `"value" does not match any of the allowed types`. The field also needs `actionPackageId` (UUID from the actions catalog). Updated understanding:

```json
{
  "name": "Find Email",
  "type": "action",
  "activeViewId": "gv_xxx",
  "typeSettings": {
    "actionKey": "apollo-find-people",
    "actionVersion": 1,
    "actionPackageId": "uuid-from-actions-catalog",
    "authAccountId": "aa_xxx",
    "dataTypeSettings": {"type": "json"},
    "inputsBinding": [...]
  }
}
```

The `actionPackageId` is the `package.id` field from the actions catalog response.

## Also Confirmed

- Error message `"App Account not found"` is returned when a non-existent `authAccountId` is provided — meaning the API validates the ID before creating the column
- The error `"value" does not match any of the allowed types` means the `typeSettings` structure doesn't match the expected Joi/Zod schema for the `action` field type
