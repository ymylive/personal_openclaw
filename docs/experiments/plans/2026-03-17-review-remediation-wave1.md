---
summary: "Wave 1 remediation for latest review: auth exposure, usage/log polling, finance secret hygiene"
owner: "codex"
status: "in_progress"
last_updated: "2026-03-17"
title: "Review Remediation Wave 1"
---

# Review Remediation Wave 1

## Define

Reduce the highest-risk findings from commit `b02fab00b3fde90ee1d43805926a190b2e9992dd`
with minimal, reviewable changes that preserve current behavior where possible.

## Scope

- Browser/UI auth exposure hardening
- Usage/logs performance and polling reentrancy
- Finance dashboard secret hygiene and polling guard
- Nextcloud Talk room-token redaction

## Done

- Auth/onboarding flows no longer promote long-lived tokens via sharable URLs.
- Browser-side credential persistence is narrowed or removed where feasible without breaking pairing.
- Usage and logs polling avoid overlapping in-flight requests.
- Usage session discovery avoids unnecessary extra file reads when summary data is not requested.
- Finance dashboard requires an explicit secret and avoids overlapping refresh work.
- Nextcloud Talk logs/errors no longer expose room tokens.
- Focused regression checks pass for touched areas.

## Non-goals

- Full browser auth redesign to non-exportable WebCrypto keys
- Broad OAuth / QQ module test coverage expansion
- Cross-module refactors beyond the reviewed findings

## Task Cards

### Worker A

- Workflow Skill: `dispatching-parallel-agents`
- Primary Skill: `agency-security-engineer`
- Skill Path: `C:\Users\Ymy_l\.codex\skills\agency-security-engineer\SKILL.md`
- Secondary Skill: `agency-frontend-developer`
- Scope:
  - `ui/src/ui/device-identity.ts`
  - `ui/src/ui/device-auth.ts`
  - `ui/src/ui/gateway.ts`
  - `ui/src/ui/app-settings.ts`
  - `src/commands/dashboard.ts`
  - `src/commands/onboard-helpers.ts`
  - `src/wizard/onboarding.finalize.ts`
  - nearby focused tests only if needed
- Done:
  - Remove or reduce auth token propagation through `#token=...` URLs.
  - Reduce durable browser persistence for device auth material where compatible.
  - Keep onboarding/dashboard flows operational.
- Verify:
  - `pnpm vitest run src/commands/dashboard.test.ts ui/src/ui/navigation.browser.test.ts`

### Worker B

- Workflow Skill: `dispatching-parallel-agents`
- Primary Skill: `agency-backend-architect`
- Skill Path: `C:\Users\Ymy_l\.codex\skills\agency-backend-architect\SKILL.md`
- Secondary Skill: `agency-frontend-developer`
- Scope:
  - `src/gateway/server-methods/usage.ts`
  - `src/infra/session-cost-usage.ts`
  - `ui/src/ui/controllers/usage.ts`
  - `ui/src/ui/app-polling.ts`
  - `ui/src/ui/controllers/logs.ts`
  - nearby focused tests only if needed
- Done:
  - Avoid unnecessary transcript reads in session discovery.
  - Lower or rationalize excessive usage request limits.
  - Prevent overlapping quiet logs polling and related UI poll reentry.
- Verify:
  - `pnpm vitest run src/infra/session-cost-usage.test.ts`

### Worker C

- Workflow Skill: `dispatching-parallel-agents`
- Primary Skill: `agency-security-engineer`
- Skill Path: `C:\Users\Ymy_l\.codex\skills\agency-security-engineer\SKILL.md`
- Secondary Skill: `agency-frontend-developer`
- Scope:
  - `workspace/finance_system/report_bot.py`
  - `workspace/finance_system/dashboard_assets/finance_dashboard.js`
  - `extensions/nextcloud-talk/src/room-info.ts`
  - `extensions/nextcloud-talk/src/send.ts`
  - lightweight focused tests if present
- Done:
  - Finance dashboard fails closed when secret is missing.
  - Finance dashboard polling is single-flight.
  - Nextcloud Talk token-bearing logs/errors are redacted.
- Verify:
  - `python -m py_compile workspace/finance_system/report_bot.py workspace/finance_system/dashboard_server.py workspace/finance_system/dashboard_access.py`
  - `pnpm vitest run extensions/nextcloud-talk/src/send.test.ts`

## Integration

- Main agent reviews returned diffs for overlap and compatibility.
- Final validation runs only after all three scopes are integrated.

## Risks

- Browser auth hardening may require compatibility tradeoffs for existing paired sessions.
- Usage caching changes must not serve stale session summaries.
- Finance fail-closed behavior may require environment fixes in deployments missing the secret.
