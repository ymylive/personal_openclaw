# QQ Dashboard Control And Stickers Design

## Goal

Expand the standalone `/qq` dashboard so operators can directly manage monitored QQ groups and configure AI-driven local sticker-pack sending from the dashboard, then persist that configuration back into the existing QQ channel runtime.

## Scope

This work stays inside the QQ module surfaces:

- `workspace/modules/qq/qq_dashboard_server.py`
- `workspace/modules/qq/dashboard_assets/*`
- QQ-focused runtime/config helpers under `workspace/finance_system/*` as needed

It does not redesign the main OpenClaw Control UI and it does not introduce a separate database-backed admin app.

## User Outcomes

Operators can use `/qq` to:

1. Add, remove, enable, and disable monitored groups.
2. Edit group labels, focus text, priority, and per-group behavior overrides.
3. Configure a local sticker-pack root directory organized by emotion folders.
4. Let AI decide whether to attach one sticker image to a QQ reply, subject to global and per-group controls.

## Architecture

### QQ configuration boundary

The QQ dashboard will gain a QQ-specific configuration model layered on top of the existing `channels.qq` config shape. The dashboard edits a normalized view that maps back to existing fields such as:

- `channels.qq.allowedGroups`
- `channels.qq.monitorGroups`
- `channels.qq.ambientChatGroups`

New QQ-specific settings for sticker behavior and group policy will live under a QQ-owned namespace in the same config file so runtime and dashboard stay in sync without introducing a second persistence system.

### Group control model

Each group record should support:

- `groupId`
- `name`
- `focus`
- `enabled`
- `priority`
- `replyEnabled`
- `stickerEnabled`
- `stickerIntensity`
- `cooldownSeconds`

The dashboard presents these as form controls rather than raw JSON.

### Sticker-pack model

Sticker packs are directory-based. The operator points QQ at a root directory whose immediate subdirectories represent emotion packs, for example:

- `happy/`
- `comfort/`
- `tease/`
- `angry-soft/`

The runtime scans these folders and exposes a pack summary to the dashboard. AI does not classify arbitrary files globally; it chooses from the operator-provided emotion folders. At most one sticker image may be attached to a reply.

### AI decision policy

The configured policy is the approved “balanced” mode:

- text remains the default
- AI may attach one local sticker when it has sufficient confidence
- every group can override sticker usage
- per-group cooldown prevents spam

AI decides:

1. whether a sticker should be sent
2. which emotion pack best fits the reply
3. which image inside that pack to use

The operator controls the candidate space and the allowed frequency.

## Dashboard API Changes

The QQ dashboard server will expose QQ-specific configuration endpoints in addition to the existing read-only bootstrap/status endpoints.

Required API surface:

- `GET /qq/api/bootstrap`
- `GET /qq/api/status`
- `GET /qq/api/config`
- `POST /qq/api/config`
- `GET /qq/api/stickers`

`/qq/api/config` returns the normalized editable QQ config model.

`/qq/api/stickers` returns:

- configured root path
- discovered emotion directories
- per-directory image counts
- validation problems

`POST /qq/api/config` validates and persists the operator’s changes back into the OpenClaw config file.

## Validation Rules

- group IDs must be numeric
- priorities must be integers in a bounded range
- cooldown must be non-negative
- sticker root path may be empty only when sticker sending is disabled globally
- only image files from approved extensions count toward pack inventory
- invalid config writes must be rejected with actionable error messages

## Runtime Integration

The QQ runtime keeps using the existing channel configuration, but gains helper functions to:

- read normalized group policy
- read sticker-pack policy
- scan the directory-based sticker packs
- expose a constrained sticker candidate list to the AI/tooling path

No unrestricted filesystem browsing should be given to the AI. The runtime should provide already-filtered pack metadata and selected file paths.

## Testing

Required test coverage:

- dashboard config normalization and persistence
- validation failures for malformed group/sticker settings
- sticker directory scanning and inventory summary
- frontend rendering for editable groups and sticker settings
- regression coverage for the login panel already added

## Deployment

The final rollout includes:

1. updating the dashboard files in the repo
2. pushing the branch to GitHub
3. syncing the live QQ dashboard/runtime files to the VPS
4. restarting the QQ dashboard service/container
5. verifying `/qq` serves the new controls and preserves login status behavior
