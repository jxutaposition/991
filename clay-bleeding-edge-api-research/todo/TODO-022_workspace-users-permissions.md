# TODO-022: Workspace Users & Permissions Management

**Priority:** P2 — User management and access control
**Status:** Open — READ confirmed, WRITE untested
**Discovered:** Session 5 (INV-018)

## What Works

- `GET /v3/workspaces/{id}/users` → `{users: [...]}` — lists all workspace members with:
  - `id`, `username`, `email`, `name`, `profilePicture`, `fullName`
  - `role`: `{id, name}` (role-based access control)
- `GET /v3/workspaces/{id}/permissions` → `{userPermissions: [...]}` — role assignments per user

## What Needs Investigation

1. `POST /v3/workspaces/{id}/users` — invite user
2. `DELETE /v3/workspaces/{id}/users/{userId}` — remove user
3. `PATCH /v3/workspaces/{id}/permissions` — change user role
4. Document available role IDs and permissions

## Success Criteria

- Can list, invite, and remove workspace members
- Can assign roles
