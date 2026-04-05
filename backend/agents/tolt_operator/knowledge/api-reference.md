# Tolt API Reference

**Base URL**: `https://api.tolt.io` (or as provided in credential metadata)
**Auth**: Bearer token, auto-injected for requests to `tolt.io` or `api.tolt.io`.

## Endpoints

### Partners

| Action | Method | Endpoint | Notes |
|--------|--------|----------|-------|
| List partners | GET | `/v1/partners` | Supports `?limit=N&offset=N` for pagination |
| Get partner | GET | `/v1/partners/{id}` | Returns full partner record |
| Update partner | PATCH | `/v1/partners/{id}` | Update group, metadata |
| Search partners | GET | `/v1/partners?email={email}` | Filter by email |

**Partner object fields**: `id`, `email`, `name`, `group_id`, `group_name`, `status`, `created_at`, `referral_count`, `mrr`, `revenue`

### Links

| Action | Method | Endpoint | Notes |
|--------|--------|----------|-------|
| List links | GET | `/v1/links` | Referral links for partners |
| Create link | POST | `/v1/links` | Body: `{"partner_id": "...", "url": "..."}` |

### Commissions

| Action | Method | Endpoint | Notes |
|--------|--------|----------|-------|
| List commissions | GET | `/v1/commissions` | Filter: `?partner_id=X&from=DATE&to=DATE` |

**Commission fields**: `id`, `partner_id`, `amount`, `currency`, `status`, `created_at`, `transaction_id`

### Transactions

| Action | Method | Endpoint | Notes |
|--------|--------|----------|-------|
| List transactions | GET | `/v1/transactions` | Filter: `?partner_id=X&status=X` |

### Promotion Codes

| Action | Method | Endpoint | Notes |
|--------|--------|----------|-------|
| List codes | GET | `/v1/promotion-codes` | Active promotion codes |
| Create code | POST | `/v1/promotion-codes` | Body: `{"code": "...", "discount": N}` |

## Pagination

All list endpoints support:
- `limit` (default 25, max 100)
- `offset` (default 0)
- Response includes `total` count for calculating pages

## Common Patterns

**List all partners in a group**:
```
GET /v1/partners?group_id=GROUP_ID&limit=100
```

**Get MRR for a specific partner**:
```
GET /v1/partners/{id}
→ response.mrr contains current MRR value
```

**Reassign partner to new group**:
```
PATCH /v1/partners/{id}
Body: {"group_id": "NEW_GROUP_ID"}
```

**Verify reassignment**:
```
GET /v1/partners/{id}
→ confirm group_id matches new value
```
