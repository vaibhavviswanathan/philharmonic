# Philharmonic sandbox container — base image for every per-task workspace.
#
# Extends @cloudflare/sandbox's runtime image so the SDK's control plane
# (sandbox.exec, file I/O, port exposure, sessions) works out of the box.
# The Workflow checks out the repo into /workspace and runs `claude -p` in M6+.
#
# When @cloudflare/sandbox is bumped in apps/worker/package.json, bump this
# image tag too — they must match for the wire protocol to line up.

FROM docker.io/cloudflare/sandbox:0.5.6

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

# Headless Claude CLI runtime — the agent's brain.
RUN npm install -g @anthropic-ai/claude-code

# Pre-install the Tasks MCP server. SPEC §14 — exposes philharmonic.* tools
# (read_task, post_comment, update_status, add_proof_of_work, read_workflow_md)
# to the in-sandbox agent over stdio.
COPY mcp/tasks-mcp /opt/tasks-mcp
WORKDIR /opt/tasks-mcp
# `tsc` is a devDependency, so install all deps to build, then prune.
RUN npm install --no-fund --no-audit && npm run build && npm prune --omit=dev

WORKDIR /workspace
