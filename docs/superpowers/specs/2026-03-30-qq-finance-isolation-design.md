# QQ and Finance Isolation Design

## Goal

Refactor the current QQ-related and finance-related workspace code so that:

- QQ and finance are isolated at the code and configuration level.
- Both modules can continue to run on the same VPS and under the same overall OpenClaw deployment.
- Daily push orchestration becomes finance-only.
- QQ keeps its independent listener, `@` auto-reply, attachment parsing, and operational tooling.
- QQ frontend and finance frontend are separate applications and must not be combined into a single business console.
- Existing finance URLs and legacy script entrypoints remain compatible during migration.

## Confirmed Constraints

- Isolation scope: code and configuration isolation only, not separate VPSes or separate top-level deployments.
- Dependency rule: `qq -> shared`, `finance -> shared`, with no direct `qq <-> finance` imports.
- UI rule: QQ frontend and finance frontend must be separate, not separate tabs inside one combined business frontend.
- Daily push rule: daily push belongs to finance only, and only finance content is included in that workflow.
- QQ feature rule: QQ keeps independent `@` auto-reply, attachment extraction, listener state, and QQ diagnostics.
- Compatibility rule: keep existing script entrypoints, config paths, and the `/finance` route while introducing the new structure.

## Current State

Today the workspace-level implementation is mixed together inside `workspace/finance_system/`.
That directory currently contains:

- QQ transport and message tools such as `qq_direct_utils.py`, `qq_config.py`, `qq_logging.py`
- QQ listener and reply logic such as `qq_at_auto_reply.py`, `qq_attachment_extract.py`
- Finance reporting and schedule generation such as `report_bot.py`, `schedule_reminder.py`
- Finance push scripts such as `send_morning_news_to_qq.py`, `send_daily_schedule_to_qq.py`
- Finance dashboard server and assets such as `dashboard_server.py` and `dashboard_assets/*`

This creates three problems:

1. Module ownership is unclear because QQ transport and finance workflows live in the same directory.
2. Daily finance pushes are coupled to QQ implementation details.
3. Frontend ownership is unclear because finance already has its own dashboard while the broader Control UI is separate.

## Recommended Approach

Use a three-layer split with a compatibility shell:

1. `shared` for reusable infrastructure and contracts
2. `qq` for QQ-only runtime behavior and UI
3. `finance` for finance-only generation, finance push orchestration, and finance UI
4. legacy wrappers under `workspace/finance_system/` for migration compatibility

This is the best balance between isolation, migration safety, and deployment effort.

## Target Module Structure

Recommended target layout:

```text
workspace/
  modules/
    shared/
      config/
      logging/
      state/
      contracts/
      delivery/
    qq/
      transport/
      listener/
      attachments/
      status/
      ui/
    finance/
      reports/
      push/
      dashboard/
      status/
      ui/
  finance_system/
    ...legacy wrapper scripts kept for compatibility...
```

### Shared Module

`shared` owns only reusable primitives and contracts:

- config loading and normalization
- logging foundation
- state persistence helpers
- shared result and payload contracts
- delivery request abstractions
- utility helpers used by both modules

`shared` must not contain business behavior that effectively recreates a hidden coupling layer.
If a helper becomes QQ-specific or finance-specific, it belongs back in that module.

### QQ Module

`qq` owns only QQ-related runtime behavior:

- OneBot or WebSocket transport calls
- send, receive, and history-confirm logic
- group listener and `@` auto-reply flow
- attachment and file extraction entrypoints used by QQ workflows
- QQ-specific status, logs, health checks, and operational actions
- QQ frontend backend-facing view models or endpoints

QQ must not import finance reports, finance scheduling, or finance dashboard logic.

### Finance Module

`finance` owns only finance-related business behavior:

- news, morning, noon, and schedule generation
- daily finance-only push orchestration
- finance dashboard backend and finance static frontend
- finance status, job history, generated artifacts, and finance logs
- finance frontend backend-facing view models or endpoints

Finance must not talk to QQ transport directly.
If finance needs to emit a push, it should produce a delivery request through shared contracts and use a delivery boundary rather than QQ-specific implementation code.

## Dependency Rules

Allowed:

- `qq -> shared`
- `finance -> shared`

Not allowed:

- `qq -> finance`
- `finance -> qq`

Enforcement guidance:

- no direct Python imports between QQ and finance modules
- shared contracts should be small and explicit
- frontend routes and API handlers should map cleanly to a single module owner

## Daily Push Design

Daily push is moved fully under finance ownership.

That means:

- schedule triggers invoke finance jobs
- finance jobs generate finance content only
- daily push orchestration no longer lives in QQ-facing scripts
- QQ is treated as one possible delivery target, not the owner of the push workflow

Practical result:

- scripts like `send_morning_news_to_qq.py` stay as compatibility entrypoints
- their implementation becomes a wrapper that calls the new finance push layer
- finance produces the content and delivery request
- QQ transport details stay outside finance business code

This satisfies the requirement that daily push should only push finance content and that QQ should not be embedded in that business workflow.

## QQ Runtime Design

QQ keeps its independent operational surface:

- listener lifecycle
- `@` auto-reply handling
- attachment extraction
- QQ diagnostics
- send or receive debugging
- QQ logs and QQ state views

This means QQ remains a first-class module even after finance is removed from its business responsibilities.

## Frontend Design

The frontend must be explicitly separated into three distinct surfaces:

1. Core Control UI
2. QQ UI
3. Finance UI

### Core Control UI

The existing OpenClaw Control UI remains focused on gateway-wide operations:

- gateway overview
- generic channels
- agents
- sessions
- logs
- config

It may expose links into QQ UI and Finance UI, but it must not become the place where QQ and finance business consoles are merged together.

### QQ UI

QQ UI is a separate frontend application with its own route, recommended as `/qq`.

QQ UI should contain:

- QQ configuration
- transport health and connection state
- listener state
- `@` auto-reply controls
- attachment pipeline status
- QQ logs
- QQ operational actions and diagnostics

### Finance UI

Finance UI is a separate frontend application with its own route.
The existing `/finance` route should be retained and expanded rather than replaced with a different URL.

Finance UI should contain:

- finance dashboard
- daily push state
- job history
- generated report summaries
- finance config
- finance logs
- finance operational actions

## Routing and VPS Deployment

Use one VPS with explicit route separation at the reverse proxy layer.

Recommended public entrypoints:

- `/` for core Control UI
- `/qq` for QQ UI
- `/finance` for Finance UI

Recommended deployment topology:

- reverse proxy such as nginx routes requests by path
- gateway continues to serve the core Control UI and gateway APIs
- QQ frontend is built and served as a separate app or mounted static bundle
- finance frontend continues under `/finance`

This preserves operational simplicity:

- one VPS
- one proxy
- one main deployment surface
- clear user-facing separation

## Compatibility Strategy

Compatibility is mandatory for this migration.

Preserve:

- current config file locations
- legacy script paths
- `/finance` route

Migration strategy:

1. create the new `shared`, `qq`, and `finance` modules
2. move logic behind stable interfaces
3. keep old scripts under `workspace/finance_system/`
4. convert old scripts into wrappers that delegate to the new modules
5. keep existing CLI arguments where possible
6. migrate frontend entrypoints without breaking `/finance`

Examples of compatibility wrappers:

- `qq_at_auto_reply.py` becomes a thin wrapper around `workspace.modules.qq.listener`
- `send_morning_news_to_qq.py` becomes a thin wrapper around `workspace.modules.finance.push`
- `qq_direct_utils.py` becomes a wrapper or re-export boundary around `workspace.modules.qq.transport`

## Migration Phases

### Phase 1: Shared Extraction

Create the shared layer first:

- config base helpers
- logging base helpers
- state helpers
- delivery contracts

This reduces duplicated behavior before moving business code.

### Phase 2: QQ Extraction

Move QQ-specific logic into `qq`:

- transport calls
- reply listeners
- attachment handling
- QQ status and diagnostics

Keep wrapper files in `workspace/finance_system/`.

### Phase 3: Finance Extraction

Move finance logic into `finance`:

- reports
- schedule generation
- push orchestration
- dashboard backend and assets

Refactor daily push to be finance-owned and finance-only.

### Phase 4: Frontend Separation

Split frontend delivery surfaces:

- retain core Control UI
- add standalone QQ UI
- retain and adapt standalone Finance UI

Make routes and asset ownership explicit.

### Phase 5: VPS Deployment Update

Update the VPS deployment configuration:

- build separate frontend bundles
- mount or serve them at distinct paths
- route `/qq` and `/finance` independently
- preserve `/finance` compatibility

## Testing Strategy

Testing should verify isolation rather than only behavior.

### Shared

- config helpers
- logging helpers
- state persistence contracts
- delivery request contract tests

### QQ

- send and receive transport tests
- listener tests
- `@` auto-reply tests
- attachment extraction tests
- QQ status API tests

### Finance

- report generation tests
- daily push orchestration tests
- finance dashboard API tests
- finance history and status tests

### Frontend

- QQ UI routing and rendering tests
- Finance UI routing and rendering tests
- explicit checks that QQ and Finance business surfaces are not rendered as one mixed UI

### Compatibility

- legacy wrapper entrypoints still accept expected arguments
- `/finance` still resolves correctly
- migrated workflows continue to operate from old script paths

## Risks

### Risk: Shared Layer Becomes a Dumping Ground

Mitigation:

- keep shared restricted to true infrastructure and contracts
- reject business-specific helpers in code review

### Risk: Finance Still Leaks QQ Transport Knowledge

Mitigation:

- finance produces delivery requests, not QQ-specific socket calls
- remove direct QQ transport imports from finance code

### Risk: Frontend Separation Is Only Superficial

Mitigation:

- keep QQ UI and Finance UI as separate apps or separately built frontend surfaces
- do not place them inside a single mixed business console

### Risk: Compatibility Breakage

Mitigation:

- preserve old script filenames and CLI flags initially
- preserve `/finance`
- add wrapper tests before deleting any old behavior

## Acceptance Criteria

The design is considered implemented when all of the following are true:

- QQ and finance live in separate modules with a shared layer in between
- there are no direct imports between QQ and finance
- daily push is owned by finance and contains finance-only content
- QQ still supports listener, `@` auto-reply, and attachment extraction
- QQ UI and Finance UI are separate frontend surfaces
- `/finance` remains available
- legacy script paths continue to function through wrappers during migration
- the VPS deployment exposes distinct entrypoints for core Control UI, QQ UI, and Finance UI

## Implementation Recommendation

Implement this as an incremental refactor, not as a flag day rewrite.

The first implementation plan should focus on:

1. establishing the module boundaries
2. extracting shared contracts
3. moving QQ and finance code behind those boundaries
4. preserving the existing entrypoints during the move

This gives the cleanest path to later frontend and deployment work without breaking current operations.
