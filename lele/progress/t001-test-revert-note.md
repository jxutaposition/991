# T-001 Test Revert Note

**Created:** 2026-03-27
**Purpose:** After the Tolt CSV Group Reassign workflow test completes, move these 5 partners back from HeyReachCreators (grp_x9eBYi86fiYag6LdTkdMNR2Z) to HeyReach-New (grp_VD6eSkGHJ38enp12mRjt4Xb5).

## Partners to revert

| Partner ID | Name | Email |
|---|---|---|
| part_GFzL5212xdehMMfsJwHouEdo | locherhay dee | locherhaydee@gmail.com |
| part_WPtRxSztFbsjBAmDF9tJFaEA | Max Kalinin | kalininmaxik@ya.ru |
| part_DEwJbACaHKPe9ZoNHBo7iLZM | Micha Listwo | mic.listwon@gmail.com |
| part_fKYGhYEaipGJngWTZTgsUUQD | Dany Dalal | dany.dalal@focentra.ai |
| part_Z88U4L3SxifixkpSiC4NxfMK | Konstantin Sadelkow | eliahkonstantin@gmail.com |

## Revert API calls

For each partner, call:
```
PATCH https://api.tolt.com/v1/partners/{partner_id}
Authorization: Bearer <see client/access/secrets.md — Tolt API key>
Content-Type: application/json

{"group_id": "grp_VD6eSkGHJ38enp12mRjt4Xb5"}
```

## Status
- [ ] Test run completed
- [ ] Partners reverted to HeyReach-New
