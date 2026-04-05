# Clay Gotchas

- **Trailing slashes in URLs** cause lookup mismatches. LinkedIn URLs must NOT end with `/`. A Formula column that appends `/` to a URL already ending in `/` produces `//` which breaks matching.
- **"Force run all rows" vs "Run empty or out-of-date rows"**: the latter does NOT re-run rows with "No Record Found" results. Use "Force run all" after adding new reference data.
- **Enrichment credits are finite.** Always warn about credit consumption and test on a single row before bulk runs.
- **Row unit matters.** Define it before building any table. If the row unit doesn't match the data (e.g., enrichment is per-post but the row is per-expert), restructure first. Wrong row unit compounds into broken outputs.
- **Send-to-table columns** route rows to other Clay tables based on conditions.
- **Action columns** send data to external systems via webhooks or API calls. They fire based on configurable conditions.
- **URL normalization** between Clay and other systems (Supabase, n8n) is a common source of mismatches.
