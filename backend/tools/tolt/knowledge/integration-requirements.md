# Tolt — Integration Requirements

## Credentials

Tolt API key — configured in Settings > Integrations.

## Access Model

- API key gives read access to partner data, revenue metrics, MRR, commissions, and group membership.
- Write access for group management and partner updates.
- All data is account-scoped — no per-resource configuration needed.

## Runtime Configuration

None — Tolt is account-scoped. The API key provides access to all partner and revenue data.

### Data Sensitivity

MRR and revenue data is sensitive. When building dashboards or reports:
- Internal dashboards: full revenue visibility is fine.
- External/partner-facing dashboards: NEVER expose MRR or revenue data. Revenue visibility creates support friction for edge cases. Use points, tiers, and badges for external views.
