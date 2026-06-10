# Philharmonic sandbox container — base image for every per-task workspace.
#
# Extends @cloudflare/sandbox's runtime image so the SDK's control plane
# (sandbox.exec, file I/O, port exposure, sessions) works out of the box.
# The Workflow clones the repo into /workspace/repo and runs `claude -p` there.
#
# The image tag and the npm @cloudflare/sandbox version in
# apps/worker/package.json are IDENTICAL and exact-pinned — the SDK checks
# compatibility at startup (SPEC §13.1). Bump them together.
#
# NO ENTRYPOINT/CMD override — the base image's control-plane entrypoint must
# keep running.

FROM docker.io/cloudflare/sandbox:0.12.1

# System tools the agent uses for repo operations and shell work.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates jq ripgrep fd-find python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI — agents use `gh pr create` to land work.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Headless Claude CLI runtime — the agent's brain. Exact-pinned for
# reproducible images (bump deliberately, not on rebuild).
RUN npm install -g @anthropic-ai/claude-code@2.1.172

# Pre-install the Tasks MCP server. SPEC §14 — exposes philharmonic.* tools
# (read_task, post_comment, update_status, declare_dependency,
# add_proof_of_work, read_workflow_md) to the in-sandbox agent over stdio.
# `npm ci` against the committed package-lock.json keeps the install
# reproducible; `tsc` is a devDependency, so install everything to build,
# then prune.
COPY mcp/tasks-mcp /opt/tasks-mcp
WORKDIR /opt/tasks-mcp
RUN npm ci --no-fund --no-audit && npm run build && npm prune --omit=dev

WORKDIR /workspace
