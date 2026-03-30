# LELE-004: Tool Framework — Real Integrations

## Problem
Phase 0 uses mock responses for all GTM tools. Phase 1 requires real integrations. Each integration needs auth management, rate limiting, error handling, and response normalization.

## Integrations Needed (Priority Order)

### Tier 1 — Core (MVP1)
- **LinkedIn** (search_linkedin_profile, find_contacts): LinkedIn has no official API for search. Options: (a) Unofficial scraping via browser extension (already capturing sessions), (b) Apollo.io API as proxy, (c) RocketReach API. Recommend Apollo.io — covers LinkedIn data + enrichment in one API.
- **HubSpot** (read_crm_contact, write_crm_contact, read_crm_pipeline): Official API. OAuth2 flow required. Per-customer credentials stored encrypted in DB.
- **Google Search** (web_search): Tavily API. Simple REST, already in .env.example.
- **URL fetcher** (fetch_url): Playwright headless for JS-heavy pages (LinkedIn, etc.). Use Rust's `reqwest` for simple pages.

### Tier 2 — Important (MVP2)
- **Salesforce** (read/write_crm_contact, read_crm_pipeline): Official API. OAuth2. More complex than HubSpot — sandbox testing required.
- **Company data** (search_company_data): Clearbit or Apollo enrichment. Per-call cost — implement caching in `company_enrichment_cache` table (domain → enrichment, 7-day TTL).
- **Company news** (fetch_company_news): NewsAPI or Bing News Search API. Low cost.

### Tier 3 — Later
- **Meta Ads API**: OAuth2 + app review process. 2-4 week approval delay. Can mock in MVP.
- **Google Ads API**: OAuth2. Requires Google Ads account. Mock in MVP.

## Auth Architecture
Per-customer integration credentials stored in `customer_integrations` table:
```sql
CREATE TABLE customer_integrations (
    customer_id UUID,
    integration_type TEXT,  -- 'hubspot', 'salesforce', 'apollo', etc.
    access_token_encrypted TEXT,
    refresh_token_encrypted TEXT,
    token_expires_at TIMESTAMPTZ,
    config JSONB,
    PRIMARY KEY (customer_id, integration_type)
);
```
Encryption: AES-256-GCM using a master key from environment variable.

## Rate Limiting
Each tool handler checks a Redis-backed rate limiter before making external calls. If rate limited, returns a structured error that the agent runner interprets as "retry after Xs."

## Open Questions
- Should we support multiple CRM integrations simultaneously (HubSpot AND Salesforce for the same customer)?
- How do we handle the case where an agent calls a tool for which the customer hasn't configured credentials?
- LinkedIn anti-scraping measures are aggressive — is Apollo API a reliable enough proxy?

## Acceptance Criteria
- [ ] Apollo API integrated for search_linkedin_profile and find_contacts
- [ ] HubSpot API integrated for all CRM tools
- [ ] Tavily integrated for web_search
- [ ] Per-customer credential storage with encryption
- [ ] Rate limiting on all external tool calls
- [ ] Graceful error handling (tool returns structured error, agent retries or fails gracefully)
