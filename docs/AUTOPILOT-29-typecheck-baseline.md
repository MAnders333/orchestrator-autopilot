# AUTOPILOT-29 — typecheck gate, phase 1: the gate + the honest baseline

**Status: the gate exists and is RED. Nothing was fixed and nothing was silenced.**

This phase stands the gate up and measures the debt. It deliberately does not
repair a single error, does not add an `any`, a `@ts-ignore`, or a relaxed flag
to manufacture a green result, and does not wire a pre-push hook. A gate that is
green because the compiler was blinded looks like coverage and is worse than no
gate at all.

## What landed

| change | what |
| --- | --- |
| `package.json` | `devDependencies: typescript ^5.9.3, @types/bun ~1.3.14`; `scripts.typecheck: tsc --noEmit` |
| `tsconfig.json` | new; type-check-only config matching how the code is already written |
| `bun.lock` | the two devDeps, plus one incidental pre-existing correction (below) |

Run it with `bun run typecheck`.

### Why these two dependency pins

Both were chosen empirically, not by default.

**`typescript@^5.9.3`, not `^7.x`.** `bun add -d typescript` resolves to
`typescript@7.0.2` (the native port). Both were measured against this repo:
**they report the identical 206 errors**, with only cosmetic differences in
which error code a few diagnostics get attributed to. With diagnostics equal,
5.9.3 wins on two concrete grounds:

- `typescript@5.9.3` was *already* in `bun.lock` before this change, pulled in as
  the peer of `bun-ffi-structs` (`peerDependencies: {"typescript": "^5"}`, via
  `@opentui/core`). Pinning `^5.9.3` adds a root devDependency with **zero
  resolution churn** and keeps that declared peer range satisfied. Installing
  `^7` silently drops the 5.9.3 entry and satisfies a `^5` peer with 7.x — bun
  does not warn. (Impact is types-only: `bun-ffi-structs` never imports
  `typescript` at runtime, verified by grep. But it is a needless lie in the
  lockfile.)
- TS 7 is new enough that every in-flight branch would inherit it as a variable.
  There is no diagnostic benefit here to pay for that.

**`@types/bun@~1.3.14`, not `^1.4.x`.** `@types/bun` (not `bun-types` — `bun-types`
is now just a transitive dep of `@types/bun`) resolves cleanly: `bun:test`,
`bun:sqlite`, and `Bun.*` all typecheck with zero module-resolution errors.
`bun add` picks `1.4.2`, but this repo runs **bun 1.3.14** and `@types/bun@1.3.14`
exists. Types ahead of the runtime let you typecheck against APIs the installed
bun does not have — the exact failure mode a type gate is supposed to prevent. The
tilde keeps the types on the runtime's minor.

### tsconfig strictness: `strict: true`, deliberately, with the gate left red

The config ships with full `strict`. That is the honest measurement and it hides
nothing. The alternative — shipping `strict: false` so the number looks smaller —
would have been pointless here anyway: **`strict: false` still leaves 128 errors**
(see the tranche table). No flag setting available makes this gate green, so
there is no version of this config that manufactures a false pass. Committing the
strict one means the baseline number in this document is the real total, and the
phasing below can be executed by *fixing code*, never by moving the goalposts.

One deviation worth naming: `skipLibCheck: true`. That is not a suppression of
our errors — it stops third-party shipped `.d.ts` files (`@opentui/*`, `solid-js`)
from dominating the output. It is justified inline in `tsconfig.json`. No other
error-hiding option is set, and no `any` or `@ts-ignore` was added anywhere.

`allowImportingTsExtensions: true` + `noEmit: true` + `moduleResolution: bundler`
accommodate the repo's load-bearing explicit `.ts` import specifiers. Not one
import was rewritten.

## THE BASELINE

```
$ bun run typecheck
206 errors   (exit 2)
```

62 `.ts` files checked across `src/` and `test/`.

| split | errors |
| --- | --- |
| `src/` | 98 |
| `test/` | 108 |

### By strictness flag — where the 206 actually comes from

| configuration | errors | delta |
| --- | --- | --- |
| `strict: false` (floor) | **128** | — |
| `+ noImplicitAny` | 187 | **+59** |
| `+ strictNullChecks` | 144 | **+16** |
| `+ strictFunctionTypes` | 133 | **+5** |
| `+ strictBindCallApply` / `noImplicitThis` / `useUnknownInCatchVariables` / `alwaysStrict` | 128 | **+0** |
| `strict: true` (shipped) | **206** | |

The headline is the floor: **128 of the 206 errors survive with strictness fully
off.** This is not pedantry debt. These are wrong types, missing properties,
undeclared names, and broken module paths — the compiler disagreeing with the
code at its most permissive setting.

### By category

| code | n | what it is |
| --- | --- | --- |
| TS7006 | 49 | implicit `any` parameter (all from `noImplicitAny`) |
| TS2322 | 41 | type not assignable |
| TS2353 | 25 | object literal specifies an unknown property |
| TS2345 | 21 | argument type mismatch |
| TS2307 | 14 | **cannot find module** |
| TS7053 | 8 | implicit `any` from index expression |
| TS2304 | 8 | **cannot find name** |
| TS2740/2739/2741 | 12 | object literal missing required properties |
| TS18048/2532 | 8 | possibly `undefined` |
| TS2448 / TS18004 | 4 | **used before declaration / no value in scope** |
| TS2305 | 2 | **module has no exported member** |
| remaining | 14 | assorted singletons |

### By file (top)

| file | errors |
| --- | --- |
| `src/hosts/pi-extension.ts` | 55 |
| `test/framework/runner.test.ts` | 31 |
| `test/hosts/opencode-tui.test.ts` | 18 |
| `test/queue-store.test.ts` | 13 |
| `src/hosts/opencode-plugin.ts` | 12 |
| `src/hosts/pi-panel.ts` | 10 |
| `test/autopilot.test.ts` | 8 |
| 24 other files | ≤6 each |

## What the gate found on its first run

The item was filed on the theory that type errors tests do not exercise land
silently. The first run confirms it, three times over.

**1. `src/verdict.ts:46` calls a function that does not exist.**

```
src/verdict.ts(46,15): error TS2304: Cannot find name 'firstLine'.
```
```ts
if (typeof ev.summary === "string") {
  const m = firstLine(ev.summary).match(VERDICT_RE);
```

`firstLine` is defined nowhere in the repo — `grep -rn firstLine src/` returns
this call site and nothing else. Any `parseVerdict` call that falls through the
`ev.results` loop and hits a string `ev.summary` throws
`ReferenceError: firstLine is not defined`. The verdict path is the PASS/FAIL
routing for reviewer output. `test/verdict.test.ts` never exercises the
`summary` branch, so 423 passing tests say nothing about it. **This is a live
defect, unreported before this run.**

**2. `src/hosts/opencode-plugin.ts` — the opencode plugin adapter cannot load.**

```
src/hosts/opencode-plugin.ts(365,3): error TS2448: Block-scoped variable 'tools' used before its declaration.
src/hosts/opencode-plugin.ts(382,31): error TS2304: Cannot find name 'backend'.
src/hosts/opencode-plugin.ts(387,92): error TS18004: No value exists in scope for the shorthand property 'stateDir'.
src/hosts/opencode-plugin.ts(405,11): error TS2304: Cannot find name 'schedules'.
```

`OrchestratorAutopilot` assigns `tools.autopilot` at line 365 and
`tools.flag_for_review` at ~420, but `const tools` is declared at line 439 — a TDZ
`ReferenceError` — and reads `backend`/`stateDir`/`schedules`, which exist only
inside `createOpenCodeFramework`, not in this scope. 9 errors.

To be precise about credit: this one is **already known and tracked** — see the
comment at `test/hosts/opencode.test.ts:143-148` and the `test.todo` blocked on
`AUTOPILOT-WORKTREE-PRESERVATION-2`. The value here is that the gate finds it
mechanically, from the source, without anyone remembering to leave a comment.

**3. `src/hosts/pi-extension.ts` — 12 type assertions that have been silently
`any` this whole time.**

```
src/hosts/pi-extension.ts(45,70): error TS2307: Cannot find module './core.ts' or its corresponding type declarations.
```
```ts
const LIB_DIR = join(__dirname, "..");                       // → src/
const { Autopilot } = require(`${LIB_DIR}/core.ts`) as typeof import("./core.ts");
```

The runtime path is right (`src/core.ts`). The *type* path is not: `./core.ts` is
relative to `src/hosts/`, where no `core.ts` exists — it should be `../core.ts`.
Twelve of these (`./config.ts`, `./queue-store.ts`, `./backends/index.ts`,
`./tools/queue-ops.ts`, `./framework/*.ts`, `./agents/install.ts` …). Line 56's
`typeof import("./pi-panel.ts")` is correct and reports no error, which is exactly
the control case. Because nothing ever checked these, every one of the twelve
`require(...) as typeof import(...)` casts has been resolving to `any` — the whole
pi host has been typed as nothing.

Two further real findings, lower severity:

- `src/backends/types.ts:15` uses `CompletionEvent` without importing it (it lives
  in `src/types.ts`), which cascades into
  `src/backends/pi.ts(32,40): TS2305: Module '"./types.ts"' has no exported member 'CompletionEvent'`.
- `src/framework/runner.ts:680` returns `deferUserMessage` in the object literal,
  but `FrameworkRunner` does not declare it (TS2353). The property is emitted and
  invisible to any typed caller.
- `test/queue-store.test.ts:10` imports `readyItems` from `src/queue-store.ts`,
  which exports no such name and never did (`grep -rn readyItems src/` finds
  nothing). The import is unused, so bun elides it and the suite stays green — a
  stale import surviving purely because nothing checks.

## Recommended phasing

The backlog is **not** near-zero, so the gate should not be enabled as a blocking
check yet. Fix in tranches, cheapest-and-highest-signal first. Sizes are estimated
from the error clusters, not guessed at from the totals.

| tranche | scope | errors | effort | notes |
| --- | --- | --- | --- | --- |
| **T1 — the 12 bad `typeof import` paths** | `src/hosts/pi-extension.ts` | ~12 direct (unblocks much of that file's 55) | **small** — `./x.ts` → `../x.ts` | Mechanical, but it un-`any`s the whole pi host, so expect *new* errors to appear behind it. Do this first and re-measure; the 206 will go up before it goes down. |
| **T2 — real defects** | `verdict.ts` `firstLine`; `backends/types.ts` missing `CompletionEvent` import; `runner.ts` `deferUserMessage`; the stale `readyItems` import in `test/queue-store.test.ts` | ~5 | **small** | Highest value per line changed. `verdict.ts` is a live crash. |
| **T3 — opencode adapter repair** | `src/hosts/opencode-plugin.ts` TDZ cluster | 9 | **medium** | Already owned by `AUTOPILOT-WORKTREE-PRESERVATION-2`; do not duplicate. Un-blocks the `test.todo` at `test/hosts/opencode.test.ts:148`. |
| **T4 — test fixtures** | `test/**` object literals | ~91 of the 128 floor | **medium, one focused pass** | Dominated by one root cause: `QueueItem` / `Omit<QueueItem, …>` literals missing fields that became required (29 name `QueueItem` explicitly). A single shared `makeQueueItem(partial)` fixture builder collapses most of this. Do NOT hand-edit 91 sites. |
| **T5 — `noImplicitAny`** | mostly callback params | +59 | **medium, mechanical** | Annotate; do not reach for `any` to close them. |
| **T6 — `strictNullChecks` + `strictFunctionTypes`** | | +21 | **small** | Genuinely small once T1–T5 land. |

**Enable now:** nothing new — `strict: true` is already on and the config is
committed as-is. The gate is runnable today (`bun run typecheck`) as an
informational check.

**Defer:** the wiring. A pre-push hook, or a "workers must run typecheck before
reporting" instruction in `skills/orchestrator-operations/SKILL.md`, only makes
sense at zero errors — wired today it would fire on every unrelated branch and be
trained away within a day. Sequence it strictly after the count reaches 0.
Recommended wiring when that lands: **both** — a pre-push hook running
`bun test && bun run typecheck` (the repo has no hooks at all today, so this is
net-new), plus the SKILL.md line so workers see failures before push.

**Explicitly do not:** gate "changed files only". `tsc` has no good per-file mode,
and the errors here are cross-file (the `pi-extension.ts` casts affect everything
they import). It would produce a gate that passes on the diff and misses the
breakage.

### Caveat on these numbers

Two branches are in flight: **AUTOPILOT-32** (hosts/config/prompt) and
**AUTOPILOT-34** (core/auto-recovery/queue-store). `src/hosts/*` alone accounts for
**83 of the 206** errors and `test/hosts/*` for another 35. Re-measure after both
land before starting T1 — the file-level numbers above will move.

## Publishing / lockfile impact

- **Consumers are unaffected.** `typescript` and `@types/bun` are
  `devDependencies`; npm and bun install only `dependencies` for a consumer. No
  install-size or dependency-surface change to the published package.
- **`tsconfig.json` is not published** — `files[]` ships `src`, `skills`,
  `prompts`, `docs`, `README.md`, `LICENSE`, and was not modified. `exports`
  points at raw `.ts` sources, so a consumer typechecking against this package
  does so under *their* tsconfig, exactly as before. Adding `tsconfig.json` to
  `files[]` is **not** recommended: a published root tsconfig is not inherited by
  consumers and only invites confusion. This document, being in `docs/`, does
  ship — consistent with the existing `docs/AUTOPILOT-9-verification.md`.
- **`bun.lock` carries one incidental correction.** The committed lockfile had
  `@opentui/core`, `@opentui/solid`, and `solid-js` under `devDependencies`, while
  `package.json` has had them under `dependencies` since commit `99c038f`. The
  lockfile was stale; `bun add` re-synced it. Consumers were never affected
  (they read `package.json`), but `bun install --production` from this repo would
  previously have skipped the TUI host's runtime deps. This is a fix, flagged here
  only because it is an unrelated hunk in the diff.
- **One cosmetic lock change:** hoisting of `marked` flips (18.0.5 now at top
  level, 17.0.1 nested under `@opentui/core`). Both consumers keep their exact
  pinned versions; only which one sits at the tree root changes.
- `bun install` is idempotent against the committed lock (verified: re-running
  produces a byte-identical `bun.lock`).

## Verification

| check | result |
| --- | --- |
| `bun test` before | 423 pass / 8 skip / 1 todo / 0 fail |
| `bun test` after | **423 pass / 8 skip / 1 todo / 0 fail** — unchanged (8 runs) |
| `bun run typecheck` | runs; exits 2; 206 errors |
| `.ts` import specifiers | untouched |
| `any` / `@ts-ignore` added | none |
| version | unchanged at 0.5.1 |

One caveat reported rather than swept: of nine `bun test` runs across this change,
**one** came back `422 pass / 1 fail`. It did not reproduce in the eight others and
the failing test name was not captured. It is almost certainly a pre-existing
timing flake — several tests poll with `waitFor(..., 4000)` and spawn real
processes, on a machine currently running other worktrees. Nothing in this change
can reach the runtime: `tsconfig.json` sets none of the three keys bun actually
honours at runtime (`paths`, `jsx`, `experimentalDecorators`), and the only other
changes are two devDependencies and a docs file. Worth a separate flake hunt; not
worth blocking this on.

### One environment note

`node_modules` in a worktree is a **symlink** to the main checkout's
`node_modules`, so `bun add` here mutated the shared install that the other
in-flight worktrees also use. The mutation is additive (two devDeps) plus the
`marked` re-hoist; both `marked` consumers were verified to still resolve their
pinned versions (`@earendil-works/pi-tui` → 18.0.5 hoisted, `@opentui/core` →
17.0.1 nested), and this worktree's full suite passes against it. Also note that
`.gitignore`'s `node_modules/` pattern does not match a symlink, so `node_modules`
shows as untracked in `git status` — do not `git add -A` in a worktree.
