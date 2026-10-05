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

## Operational ZIP validation

The requested operational path exists:
`C:\Projetos\monitor-ti\releases\agent\1.1.30\MonitorTI-Agent-1.1.30.zip`.
It matches the registered record exactly:

- SHA-256: `9a410cf373dcfe84b719d6c487b5d975cfbf6a48c83f9fd95e154eef9dcab542`
- Size: `34729290` bytes

A separate validation copy also exists at
`C:\TEMP\opencode\agent-only-registrar-validation\MonitorTI-Agent-1.1.30.zip`.
It has SHA-256 `3c77c633f8415e09a155729d9eb43c2be689b2e51e7da7c2328e27fff291ddac`
and size `34729235` bytes, so it is not presented as the registered package.

## Source and Git base

- Source candidate branch: `review/agent-canary-v129-publication`
- Source candidate commit: `5ca212536e48cb1eef7b7f07cc135915db202d42`
- Git base compared with `master`: `9f480d4fff59c652393708bb664d3645bc5a6105`
- Related review: PR #4
- Independent IP review: PR #3
- The source tree, build scripts, `agent/package.json`, and `agent/package-lock.json` are
  preserved in this review branch as the current tested reference.

The original canary worktree was also located at
`C:\Projetos\monitor-ti\.canary-agent-v1.1.30`:

- Git HEAD: `9f480d4fff59c652393708bb664d3645bc5a6105`
- Worktree state: dirty, with changes in `agent/build-agent-only.mjs`,
  `agent/package.json`, `agent/package-lock.json`, `agent/src/index.js`,
  `agent/src/network.js`, and `agent/test-network.test.js`.
- Untracked build outputs/scripts included `candidate/`, `scripts/canary-install.ps1`,
  and `scripts/canary-rollback.ps1`.
- Candidate build directory:
  `candidate/v1.1.30/canary-ip-61081d7-20260930-02`.
- Candidate executable SHA-256: the approved
  `58869964154daaead1bf372a186175e20b46aff7e2d8220c660b3dc620d3e95f`.
- Candidate agent-only ZIP SHA-256:
  `e6b8a34953d6990476e31c2908d90f786897920389cb634bbc655852278a21eb`.

The matching candidate output is strong evidence connecting that dirty worktree to the
approved executable, but the worktree was not a committed historical checkout. The
current branch sources are therefore described as a tested reference, not as a proven
byte-for-byte source reconstruction of the executable.

## Build inputs and command

- Node: `v24.19.0`
- npm: `11.17.0`
- esbuild lock version: `0.28.2`
- `@yao-pkg/pkg` lock version: `6.22.0`
- `postject` lock version: `1.0.0-alpha.6`
- Original canary build script: `.canary-agent-v1.1.30/agent/build-agent-only.mjs`
- Original canary command shape: `BUILD_ID=canary-ip-61081d7-20260930-02 node build-agent-only.mjs`
  from the original `agent/` directory. The exact historical shell invocation was not logged.
- Current generic script: `agent/build-agent.mjs`. It is a different full Agent/Notifier
  build path and must not be conflated with the original Agent-only build.
- Current reference command for a new, distinct artifact: `npm ci --ignore-scripts`
  followed by `node build-agent.mjs` from `agent/`
- Installer script: `agent/build-installer.mjs`

The exact historical dependency installation state and shell invocation were not recorded.
Neither the original Agent-only build nor the current generic build was executed for this
documentation correction. The current source tree is a tested reference only, not a
validated reproducible-build recipe for the approved executable.

## Tests

Affected tests are the Agent-only/update tests from PR #4. Test execution results and the
environment used are recorded in the PR. Running tests does not alter the registered
release or any machine.
