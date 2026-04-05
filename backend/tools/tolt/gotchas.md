# Tolt Gotchas

- **MRR data is sensitive.** Never expose individual partner MRR on public/external dashboards.
- **Group changes affect commissions.** Always verify commission impact before reassigning groups.
- **Bulk CSV imports need verification.** After import, verify a sample of records to confirm changes applied correctly.
- **Revenue data flow:** Tolt (authoritative) -> Clay scoring columns (derived) -> Lovable dashboard (display). Tolt is the source of truth for revenue.
- **Group membership determines:** commission rates, dashboard visibility, and program tier.
