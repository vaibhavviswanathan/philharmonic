#!/usr/bin/env bash
# Philharmonic sandbox entrypoint.
#
# Cloudflare's Sandbox SDK control plane invokes work via `sandbox.exec()`, so
# the entrypoint just keeps the container alive. See SPEC §13.1.
set -euo pipefail
exec tail -f /dev/null
