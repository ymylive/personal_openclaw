# QQ Dashboard Control And Stickers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add editable QQ group controls and balanced local sticker-pack governance to the standalone `/qq` dashboard, then deploy it to GitHub and the VPS.

**Architecture:** Keep `/qq` as the QQ-owned operational surface. Add QQ-specific config read/write APIs and sticker inventory APIs in the Python dashboard server, then wire the existing frontend to edit normalized group and sticker policy records instead of raw JSON.

**Tech Stack:** Python 3 stdlib HTTP server, JSON config persistence, static HTML/CSS/JS dashboard assets, unittest, VPS Docker deployment

---

### Task 1: Extend QQ Dashboard Backend Model

**Files:**
- Modify: `workspace/modules/qq/qq_dashboard_server.py`
- Test: `workspace/modules/qq/tests/test_dashboard_server.py`

- [ ] Add failing tests for normalized config reads, sticker inventory reads, and config writes.
- [ ] Run `python3 -m unittest workspace.modules.qq.tests.test_dashboard_server -v` and confirm the new tests fail for missing endpoints/helpers.
- [ ] Implement backend helpers for QQ group config normalization, sticker directory scanning, and JSON persistence.
- [ ] Add `GET /qq/api/config`, `POST /qq/api/config`, and `GET /qq/api/stickers`.
- [ ] Re-run `python3 -m unittest workspace.modules.qq.tests.test_dashboard_server -v` and make the suite green.

### Task 2: Add Dashboard Editing UI

**Files:**
- Modify: `workspace/modules/qq/dashboard_assets/qq_dashboard.html`
- Modify: `workspace/modules/qq/dashboard_assets/qq_dashboard.css`
- Modify: `workspace/modules/qq/dashboard_assets/qq_dashboard.js`

- [ ] Add failing frontend-oriented tests by extending static asset assertions in `workspace/modules/qq/tests/test_dashboard_server.py`.
- [ ] Run `python3 -m unittest workspace.modules.qq.tests.test_dashboard_server -v` and confirm the new UI assertions fail.
- [ ] Add a group management section with editable rows for enablement, priority, focus, reply toggle, sticker toggle, intensity, and cooldown.
- [ ] Add a sticker settings section with root directory input, pack inventory summary, and save action.
- [ ] Wire the dashboard JS to load `GET /qq/api/config`, submit `POST /qq/api/config`, and refresh `GET /qq/api/stickers`.
- [ ] Re-run `python3 -m unittest workspace.modules.qq.tests.test_dashboard_server -v` and make the suite green.

### Task 3: Add Sticker Policy Runtime Support

**Files:**
- Modify: `workspace/finance_system/qq_config.py`
- Modify: `workspace/finance_system/qq_direct_utils.py`
- Modify: `workspace/finance_system/qq_at_auto_reply.py`
- Modify: related QQ runtime helpers only if needed

- [ ] Add failing tests or minimal targeted assertions for sticker policy parsing and constrained candidate generation.
- [ ] Run the relevant test command and confirm it fails before implementation.
- [ ] Implement balanced-mode sticker policy parsing using directory-based emotion packs.
- [ ] Ensure runtime exposes at most one candidate sticker attachment per reply decision and honors group-specific overrides/cooldowns.
- [ ] Re-run the focused tests and ensure they pass.

### Task 4: Review And Verification

**Files:**
- Modify only files touched by prior tasks if review fixes are needed.

- [ ] Run a dedicated code review pass focused on config safety, dashboard validation, and runtime regressions.
- [ ] Address review findings without broadening scope.
- [ ] Run `python3 -m unittest workspace.modules.qq.tests.test_dashboard_server -v`.
- [ ] Run any focused QQ runtime verification command added during implementation.
- [ ] Run `python3 -m py_compile workspace/modules/qq/qq_dashboard_server.py`.

### Task 5: Push And Deploy

**Files:**
- Sync the finalized QQ dashboard/runtime files to the git-backed repo and VPS.

- [ ] Copy the final files into `/root/openclaw` on the VPS-backed repo if local workspace is not the git checkout.
- [ ] Commit with `scripts/committer "<message>" <file...>` in the git-backed repo.
- [ ] Push to GitHub.
- [ ] Sync the live QQ dashboard/runtime files to `/root/.openclaw/workspace/...` on the VPS.
- [ ] Restart the QQ dashboard service/container and any dependent QQ runtime service if required.
- [ ] Verify `/qq` serves the new controls and the login panel still reports `ready` when QQ is online.
