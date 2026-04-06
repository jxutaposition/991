# INV-003: Enrichment Provider Configuration

**Status**: superseded
**Priority**: P1
**Gap**: GAP-004 (Enrichment Provider Configuration)
**Date started**: --
**Date completed**: --

## Hypothesis

When creating an enrichment (action) column, Clay's frontend must fetch the available enrichment providers, their action keys, package IDs, and the user's connected account IDs (`authAccountId`). These API calls would allow us to:

1. List available enrichment providers for an account
2. Get the correct `actionKey`, `actionVersion`, and `actionPackageId` for each provider
3. Get the user's `authAccountId` for each connected provider

This would make Claymate-format schema imports fully automated (currently `authAccountId` must be manually replaced).

## Method

1. **CDP interception**: Monitor API calls when:
   - Opening the "add column" / enrichment picker UI
   - Browsing available enrichment providers
   - Configuring an enrichment column
   - Selecting a connected account
2. **Direct probing**: Try expected endpoints:
   ```
   GET /v3/actions or /v3/enrichments or /v3/providers
   GET /v3/workspaces/{id}/connections or /v3/accounts
   GET /v3/auth-accounts or similar
   ```

## Findings

Superseded by INV-010 (Deep Dive: authAccountId, 2026-04-06). `GET /v3/app-accounts` returns all 111 auth accounts with IDs, provider types, and ownership. Full enumeration is now possible.

### What We Know from Claymate Lite

The schema format for action columns includes:
```json
{
  "actionKey": "provider-action-name",
  "actionVersion": 1,
  "actionPackageId": "uuid-of-package",
  "authAccountId": "aa_your_account_id",
  "inputsBinding": [{"name": "domain", "formulaText": "{{@Domain}}"}]
}
```

Claymate's docs warn: "You need to replace `authAccountId` values with your own. Get your auth IDs by exporting an existing table that uses those integrations."

If we can find a v3 endpoint that lists connected accounts and their IDs, this workaround becomes unnecessary.

## New Endpoints Discovered

*Will be added to `registry/endpoints.jsonl` as discovered.*

## Implications

If we can programmatically list connected accounts:
- Full schema import automation (no manual authAccountId replacement)
- The agent can validate that required providers are connected before attempting import
- Better error messages when enrichment configuration fails

## Next Steps

*Based on findings.*
