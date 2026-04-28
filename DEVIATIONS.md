# Deviations from SPEC.md

Per SPEC §0, anywhere this implementation deviates from the prescriptive spec
gets recorded here so future readers can see why.

## D1 — Sandbox Dockerfile base image (M5)

**Spec (§13.1):** `FROM node:22-bookworm-slim`, install Node tools and the
Claude CLI from a clean Debian base.

**Implementation:** `FROM docker.io/cloudflare/sandbox:0.5.6`, then install
the same extras on top.

**Reason:** the `@cloudflare/sandbox` SDK ships a control-plane server inside
its container image. `sandbox.exec()`, file I/O, port exposure, and session
management all talk to that server over a private wire protocol. A bare
`node:22-bookworm-slim` image has no server, so `sandbox.exec()` would fail at
runtime even though the image builds cleanly. The published image is small
(it's still Debian + Node) so the cost of extending it is negligible.

**Constraint:** the image tag here MUST match the `@cloudflare/sandbox`
version pinned in `apps/worker/package.json`. Mismatched versions can drift
on the wire protocol.

## D2 — Project name (Philharmonic vs Symphony)

**Spec:** the spec was originally drafted with the product name "Symphony".

**Implementation:** the project is called Philharmonic. The bulk rename
covers the SPEC, README, WORKFLOW.md template, and bootstrap script. References
to the original OpenAI Symphony (the project this was inspired by) are
preserved in attribution links.

**Reason:** explicit user preference. The name change happened after the
spec was written.

## D3 — Path to migrations directory (M2)

**Spec (§4):** `migrations/0000_initial.sql` at repo root.

**Implementation:** same — but `apps/worker/drizzle.config.ts` writes to
`../../migrations` because drizzle-kit runs from the worker package and
needs a relative path.

**Reason:** drizzle-kit doesn't read `wrangler.jsonc`'s `migrations_dir`
field; it has its own `out` config. The relative path keeps the spec's root
location while letting drizzle-kit live in the worker workspace.
