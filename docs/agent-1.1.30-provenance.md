# Agent 1.1.30 Provenance

## Scope

This document records the approved Agent executable without rebuilding or replacing it.
The release remains inactive and no machine update is performed by this branch.

## Approved executable

- Recovered path: `C:\TEMP\opencode\agent-only-registrar-validation\MonitorTI-Agent.exe`
- SHA-256: `58869964154daaead1bf372a186175e20b46aff7e2d8220c660b3dc620d3e95f`
- Size: `93355520` bytes
- File metadata: Node.js SEA executable, Node `24.19.0`
- Recovery status: exact executable hash confirmed

The executable is preserved outside Git because it is a generated binary and must not be
replaced by a new build under the same identity.

## Registered release record

- AgentRelease id: `32`
- Version: `1.1.30`
- Active: `false`
- Release date: `2026-10-01T20:33:59.719Z`
- Registered executable SHA-256: `58869964154daaead1bf372a186175e20b46aff7e2d8220c660b3dc620d3e95f`
- Registered executable size: `93355520` bytes
- Registered ZIP: `MonitorTI-Agent-1.1.30.zip`
- Registered ZIP SHA-256: `9a410cf373dcfe84b719d6c487b5d975cfbf6a48c83f9fd95e154eef9dcab542`
- Registered ZIP size: `34729290` bytes
- Registered manifest: agent-only, one executable, schema version 1

## Recovered ZIP discrepancy

A separately recovered validation ZIP exists at
`C:\TEMP\opencode\agent-only-registrar-validation\MonitorTI-Agent-1.1.30.zip`.
It contains the approved executable and `manifest.json`, but it is not asserted to be the
registered ZIP:

- Recovered ZIP SHA-256: `3c77c633f8415e09a155729d9eb43c2be689b2e51e7da7c2328e27fff291ddac`
- Recovered ZIP size: `34729235` bytes
- Registered ZIP SHA-256: `9a410cf373dcfe84b719d6c487b5d975cfbf6a48c83f9fd95e154eef9dcab542`
- Registered ZIP size: `34729290` bytes

The original registered ZIP bytes were not found. The recovered ZIP must not be presented
as the registered package.

## Source and Git base

- Source candidate branch: `review/agent-canary-v129-publication`
- Source candidate commit: `5ca212536e48cb1eef7b7f07cc135915db202d42`
- Git base compared with `master`: `9f480d4fff59c652393708bb664d3645bc5a6105`
- Related review: PR #4
- Independent IP review: PR #3
- The source tree, build scripts, `agent/package.json`, and `agent/package-lock.json` are
  preserved in this review branch.

The candidate source originally declared `1.1.25`. This branch records the required
`1.1.30` metadata in both package files. That metadata correction does not prove that the
approved executable was built from this exact checkout. The historical source checkout,
working-tree state, and original build log for the approved executable were not recovered.

## Build inputs and command

- Node: `v24.19.0`
- npm: `11.17.0`
- esbuild lock version: `0.28.2`
- `@yao-pkg/pkg` lock version: `6.22.0`
- `postject` lock version: `1.0.0-alpha.6`
- Build script: `agent/build-agent.mjs`
- Build command for a new, distinct artifact: `npm ci --ignore-scripts` followed by
  `node build-agent.mjs` from `agent/`
- Installer script: `agent/build-installer.mjs`

The historical build invocation and exact dependency installation state for the approved
executable were not recorded. No new build was executed for this provenance branch.

## Tests

Affected tests are the Agent-only/update tests from PR #4. Test execution results and the
environment used are recorded in the PR. Running tests does not alter the registered
release or any machine.
