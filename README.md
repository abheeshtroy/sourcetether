# SourceTether

> Source-verified memory for coding agents.

## Problem

Coding-agent memories can outlive the source code they describe. A retrieved memory may sound confident even after its evidence changed.

## What SourceTether does

SourceTether binds a deliberately selected atomic memory claim to an explicit TypeScript source declaration. At capture time, it creates a versioned structural AST fingerprint of that declaration. The fingerprint ignores comments and insignificant formatting, while detecting declaration changes.

Before a memory is released, SourceTether resolves and re-verifies the same declaration against the current source. It releases only verified memories. When verification cannot succeed, it withholds the memory content and returns a precise re-read target: the project-relative path and qualified symbol name.

## Verification states

- `verified`: the declaration resolves uniquely and its declaration kind and structural fingerprint match the captured anchor.
- `needs_revalidation` / `fingerprint_changed`: the declaration still resolves, but its kind or structural fingerprint differs from the captured anchor.
- `needs_revalidation` / `source_unparseable`: the current TypeScript source has parse diagnostics, so it cannot be safely re-anchored.
- `orphaned`: the originally anchored declaration no longer resolves uniquely.

Changed does not mean false. It means the prior claim requires a re-read of the indicated source target before it can be released again.

## Demo

### Hosted guided demo

The public Vercel showcase is a deterministic, per-browser-session walkthrough: it binds the fixed narrow claim to the Earth fixture, demonstrates the fingerprint mismatch after the controlled Moon fixture, and never contacts Claude-Mem or a local filesystem. It is intentionally labeled in the interface. The hosted walkthrough is a presentation of the verification behavior, not a live Claude-Mem retrieval.

### Local integration demo

```sh
npm install
npm run dev
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787).

The mission workflow is: **Capture observation** → migrate to **Moon** → memory is withheld → replay the stale versus revalidated lunar landing. Live capture requires a running local Claude-Mem worker and an available local observation ID. The remaining demo behavior is deterministic.

## Claude-Mem integration

SourceTether fetches one local Claude-Mem observation only to establish provenance. It stores a deliberately selected, narrow claim separately from that observation; it does not derive the claim automatically from observation text. The demo API never exposes raw Claude-Mem observation text.

## Architecture

- `src/sourcetether.ts` — declaration resolution, versioned AST fingerprinting, binding, verification, and the retrieval gate.
- `src/claude-mem.ts` — local Claude-Mem observation adapter and response normalization.
- `src/node-source-reader.ts` — project-root-confined TypeScript source reader.
- `src/mission-api.ts` — localhost JSON API, demo state handling, and static browser-client routing.
- `public/` — dependency-free browser mission-control client.
- `demo/mission/` — mutable landing-model fixture and Earth/Lunar source templates used by the demo.

## Current scope and deliberate limitations

- Direct TypeScript declarations only.
- No imports, re-exports, namespaces, computed names, overload resolution, or declaration-merge resolution.
- Declaration-level syntactic grounding, not transitive semantic dependency tracking.
- Explicit claim and symbol selection; no automatic claim inference.

## Validation

```sh
npm test
npm run typecheck
```

The current suite contains 42 tests.
