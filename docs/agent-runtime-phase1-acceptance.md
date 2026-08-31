# Phase 1 closeout / acceptance — 2026-08-31

**Status: NOT COMPLETE.** This is an evidence checkpoint, not a completion declaration.
No AUTO, Gemini, Claude, Jimeng, Web Local Bridge, or Provider transport work was added.

## A–C. Source and publication

- Workspace: `H:\zhihui`; initial worktree was clean.
- Branch: `feature/agent-runtime-codex-desktop-v1` (unchanged throughout).
- Initial HEAD: `8cbb75b`.
- Code checkpoint tested and pushed: `15a090e`.
- Baseline: `871cf0b73b7c2d072ea7bd94c1d79fe960838f17`, both local `main` and merge-base.
- Independent detached baseline worktree: `H:\zhihui-baseline`.
- [Published feature branch](https://github.com/KevinYoungsir/zhihui/tree/feature/agent-runtime-codex-desktop-v1).
- No merge to main. This report is a subsequent documentation-only commit.

## D. Reproducible baseline-delta gate

Baseline dependencies were installed with `npm ci --ignore-scripts --prefer-offline`.
The npm lockfile is identical on both branches; no dependency upgrade was made.
Both worktrees ran exactly:

```text
npm run test:web
npm run lint:web
npm run typecheck:web
npm run build --workspace=apps/web
```

Feature was rerun after the closeout fixes. Results:

| Check | Main baseline | Feature | Result |
|---|---|---|---|
| Full Web tests | 998 passed, 2 failed; 168 files | 1018 passed, 2 failed; 174 files | PASS — NO NEW REGRESSION |
| ESLint | 1 error, 133 warnings | Same error and warnings | PASS — NO NEW REGRESSION |
| Typecheck | 5 TS2339 errors | Same five diagnostics | PASS — NO NEW REGRESSION |
| Web build | Exit 0 | Exit 0 | PASS |

Identical failure signatures (PRE-EXISTING, deliberately not edited):

1. `canvasFunctionalStress.test.ts`: “selection chrome body is screen-space via CameraTransform (ADR 0027)”, line 147, SVG transform expectation.
2. `designDoneContent.test.ts`: “falls back to FE i18n when message is absent”, line 135, error-message fallback expectation.
3. `animationAutoKey.test.ts:147`: TS2339 `lottieLayerInd` union-member access.
4. `animationWorkbenchFocus.test.ts:65,86,121,142`: TS2339 `frameId` on `unknown`.
5. `animationVideoExport.ts:238`: ESLint `preserve-caught-error`, missing error cause.

The Web build script explicitly tolerates tsc failures. Its exit 0 is not represented as a clean typecheck.

Local evidence logs are in `%TEMP%\zhihui-phase1-closeout-20260831`:
`main-web-tests.log`, `main-lint.log`, `main-typecheck.log`, `main-web-build.log`,
`feature-web-tests-final.log`, `feature-lint-final.log`, `feature-typecheck-final.log`,
and `feature-web-build.log`. These local logs are not committed.

## Closeout fixes verified locally

- Corrected the Tauri bundled/debug MCP script path from `../../scripts` to `../../../scripts`.
- Explicitly declared `windows-sys/Win32_Security`, required by `CreateJobObjectW` in the resolved dependency source.
- Cargo regenerated its dependency edges: direct `libc` belongs to `recombyn`, not `env_filter`.
- Added an in-flight operation reservation to the existing CanvasToolGateway. Concurrent retries now await the first operation instead of executing twice.
- Added session cancellation tombstones and an AbortSignal passed to the existing canonical MCP apply path. Already-fetched cancelled batches are acknowledged without applying.
- Prevented a CLI process from starting after cancellation during discovery or grant creation; late grants are revoked.
- Fixed the API adapter's missing cancellation terminal event when its aborted executor resolves normally.

All **20 tests in six Phase 1 Web test files passed**. Three new defect tests were first observed failing and then passing after the fixes. Two additional tests cover cancellation during discovery and grant minting.

```text
npm run test:web -- src/service/agentRuntime/__tests__ src/service/__tests__/mcpCanvasUrl.test.ts src/components/editor/mcp/McpCanvasBridge.test.ts
```

## E–H. Windows environment, Rust, Tauri and API

The standard project README, Chinese README, API README, contributing guide,
self-hosting guide, desktop guide, package scripts and Makefile were inspected.

- Installed official Rustup through WinGet (`Rustlang.Rustup`); Cargo reports `1.98.0`, stable `x86_64-pc-windows-msvc`.
- Created the documented `apps/api/.venv` using existing Python 3.14.
- Installed the eight local Python packages and `apps/api[dev]` from official PyPI; `pip check` passes.
- Generated `apps/api/.env` from the tracked example, set the documented local MySQL URL and enabled MCP. It is gitignored; no third-party LLM key was configured.
- MSVC C++ Build Tools, Docker Desktop and WSL are absent. Hardware virtualization is enabled. Further system installation / possible reboot requires user coordination; no reboot or security-policy change was performed.

Actual commands attempted:

| Command | Observed result |
|---|---|
| `cargo check --manifest-path apps/web/src-tauri/Cargo.toml` | Fails at dependency build scripts: MSVC `link.exe` missing; Runtime source compilation not established |
| `cargo test --manifest-path apps/web/src-tauri/Cargo.toml --lib` | Same missing MSVC toolchain; Rust tests not executed |
| `npm run build:desktop` | Before-build fails because esbuild is absent in the existing Tauri/Vite configuration |
| `npm run test:api -- tests/unit_tests/test_mcp_run_grants.py` | pytest starts; session fixture exits because MySQL is unreachable; **no tests ran** |

An equivalent Tauri frontend build was run on main using `TAURI_ENV_PLATFORM=windows`,
`VITE_DESKTOP_MODE=cloud`, and `npm run build --workspace=apps/web -- --mode cloud`.
It fails with the same missing-esbuild diagnostic. This is **PRE-EXISTING**;
no animation, old ADR, unrelated i18n, or Vite refactor was made to hide it.
It still prevents a real packaged Desktop acceptance build.

MySQL and Redis have not started; no listener was found on 3306, 6379 or 8000.
API health and MCP availability are not verified. The standard Web dev server was
started on loopback port 3000; `/zh/home` returns HTTP 200. A responding Web page
or a Vite 502 is explicitly not accepted as a working stack.

## I–J. Real Codex probe and diagnostic

The real installed CLI reports:

```text
codex-cli 0.151.0-alpha.7.2
Logged in using ChatGPT
```

This verifies executable/auth probing, **not Desktop settings UI**.

A real fixed-text diagnostic used stdin, ephemeral mode, read-only sandbox,
an empty temporary working directory and `--ignore-user-config` (supported by the
installed CLI). It did not configure or call MCP and did not read authentication files.

Sanitized outcome:

```json
{
  "scope": "standalone CLI diagnostic, NOT Tauri/UI E2E",
  "exitCode": 1,
  "timedOut": true,
  "success": false,
  "classification": "A: network/service unavailable",
  "eventTypes": {"thread.started": 1, "turn.started": 1, "error": 1},
  "tempRemoved": true
}
```

The local diagnostic was capped at 60 seconds and cleaned its process tree.
No parameter rejection or login failure was observed. With no MCP configured,
there is no evidence attributing this failure to MCP or Canvas.
**EXTERNAL BLOCKER**, not a reason to substitute a mocked successful Codex response.
`~/.codex/config.toml` SHA256 before and after is identical (contents not logged).

## K–P. Core acceptance not yet satisfied

- No real AgentDock → Tauri → Codex → MCP → SceneDocument test succeeded or was claimed.
- No acceptance test project/title was created; project ID, revision, node counts and title assertions are **not available**, not fabricated.
- Gateway unit-level idempotency is verified; **real MCP request retry idempotency is not**. The REST call does not yet carry a stable operation ID through dispatch to the queue, which currently assigns a random batch ID.
- UI cancellation / Windows parent-and-descendant process inspection is **not verified**.
- Live Redis grant revoke and reuse rejection are **not verified**; mocked Web grant-service tests are not a substitute for API grant tests.
- Late operations are blocked in the cancelling editor's Gateway, but server-side queued/retried operations and cross-session cancellation remain **unverified / incomplete**.
- Native lifecycle still needs closeout: terminal JSONL can precede OS cleanup; the watchdog retains the terminator until its deadline; pipe readers can outlive the parent; early-start failure cleanup and success-without-terminal handling need hardening and OS tests.
- The successful diagnostic temp-directory cleanup is **not** evidence that Desktop success/cancel/error/timeout cleanup all work.

These are actual remaining acceptance/code gaps. **CODE COMPLETE: not established.**
**ENVIRONMENT VERIFIED: no.** **REAL CODEX E2E: blocked by external network and local prerequisites.**

## Q–R. GitHub Actions

Runs were explicitly dispatched after pushing code checkpoint `15a090e`:

- [Desktop Windows/macOS runtime tests and Windows bundle](https://github.com/KevinYoungsir/zhihui/actions/runs/33387804161).
- [Feature Web/API CI](https://github.com/KevinYoungsir/zhihui/actions/runs/33387806940).
- [Main equivalent CI baseline](https://github.com/KevinYoungsir/zhihui/actions/runs/33387809252).

Final hosted job results at code checkpoint `15a090e`:

- [Windows Runtime compile/test](https://github.com/KevinYoungsir/zhihui/actions/runs/33387804161/job/99474274211): **SUCCESS**, 6 passed, 0 failed, 0 ignored.
- [macOS Runtime compile/test](https://github.com/KevinYoungsir/zhihui/actions/runs/33387804161/job/99474274078): **SUCCESS**, 6 passed, 0 failed, 0 ignored.

These compile the Windows Job Object and macOS process-group modules. The six
tests cover JSONL and input/origin validation, **not real process-tree termination**.
Hosted CI does not satisfy the explicit current-Windows-host build requirement.

Self-hosted Windows build and both regular CI runs remain queued. GitHub's repository
runner endpoint reports **zero registered runners**. This is a CI environment blocker
shared by main and feature, not a new failing test. The overall Desktop workflow is
therefore not fully successful. No workflow configuration or runner policy was changed.

## S. Secret audit

Before push, the tracked main-to-feature diff and accumulated local log files were scanned
for full MCP run-grant values, JWTs, API keys, GitHub tokens, private keys and literal
Bearer/Cookie headers. **No matches**. No raw stdout/stderr from the live Codex diagnostic was saved.
GitHub dispatch used existing Git authentication in memory only, without credential output or persistence.
Ignored env/venv/diagnostic files are not in the commit.

This is a bounded diff/log audit, not a claim that untested error paths can never leak secrets.

## T–U. Final acceptance matrix at this checkpoint

| Check | Main baseline | Feature | Result |
|---|---|---|---|
| Targeted Web tests | New Runtime tests absent | 20/20 | PASS |
| Full Web tests | 2 existing failures | Same 2; +20 passing tests | PASS — NO NEW REGRESSION |
| ESLint | 1 error / 133 warnings | Same | PASS — NO NEW REGRESSION |
| Typecheck | 5 TS2339 | Same 5 | PASS — NO NEW REGRESSION |
| Web build | Exit 0 | Exit 0 | PASS, tsc separately gated |
| API unit / grant tests | Not executed | MySQL session fixture exits | BLOCKED |
| Rust tests | Not executed | Hosted Windows + macOS: 6/6 each; local MSVC absent | CI PASS / LOCAL BLOCKED |
| cargo check | Not executed | MSVC absent | BLOCKED |
| Tauri build | Equivalent frontend fails: esbuild absent | Same; MSVC also absent | PRE-EXISTING + ENVIRONMENT BLOCKER |
| Windows CI | Equivalent regular CI queued | Runtime compile/tests pass; self-hosted bundle/regular CI queued | RUNTIME PASS / REMAINDER BLOCKED |
| macOS CI | No prior Runtime module | Compile and 6 Rust tests pass | PASS |
| Codex executable/auth probe | N/A | Installed / ready | PASS (CLI probe only) |
| Codex text smoke | N/A | Sampling/network timeout | EXTERNAL BLOCKER |
| Desktop Runtime settings UI | N/A | Not launched | BLOCKED |
| Codex → Canvas E2E | N/A | Not run | BLOCKED |
| Latest SceneDocument assertions | N/A | No real creation | NOT VERIFIED |
| Idempotency | N/A | Unit pass; real MCP retry missing | INCOMPLETE |
| Cancel process tree | N/A | No Desktop OS inspection | NOT VERIFIED |
| Grant revoke | N/A | Mocked Web tests only | NOT VERIFIED |
| Late ops rejection | N/A | Local Gateway tests pass; server integration missing | INCOMPLETE |
| Secret scan | N/A | No tracked-diff / log findings | PASS within scanned scope |

**PHASE 1: NOT COMPLETE. Do not enter Phase 2.**
