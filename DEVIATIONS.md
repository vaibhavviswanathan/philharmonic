# Deviations from SPEC.md

Per SPEC §0 / §21, anywhere the implementation deviates from the prescriptive
spec gets recorded here with reasoning, so future readers can see why.

## Status

**SPEC v2 absorbed every deviation recorded against v1**, so this ledger is
currently empty. For the record, the absorbed entries were:

- **D1 — sandbox Dockerfile base image.** v1 prescribed `node:22-bookworm-slim`;
  the implementation extends `cloudflare/sandbox` because the SDK's control
  plane is a server inside that image. Now the spec'd behavior — SPEC v2 §13.1,
  including the exact image-tag ↔ SDK-version pin.
- **D2 — project name.** The spec was drafted as "Symphony"; the project is
  Philharmonic. SPEC v2 is written against the real name throughout (original
  OpenAI Symphony attribution preserved).
- **D3 — migrations path.** Root `migrations/` written by drizzle-kit via a
  relative `out` path from the worker package. Validated and folded into the
  SPEC v2 repository-layout/data-model sections.

## Open deviations

_None. Add new entries below as they happen, using the template:_

```
## D<n> — <short title> (<milestone or task ID>)

**Spec (§<section>):** what the spec prescribes.

**Implementation:** what was actually built.

**Reason:** why the deviation was necessary or better.
```
