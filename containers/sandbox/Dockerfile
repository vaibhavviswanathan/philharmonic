# Philharmonic sandbox container — base image for every per-task workspace.
#
# Each running task lands in a fresh instance of this image with /workspace mounted
# empty; the Workflow checks out the repo into /workspace and writes prompt + run
# token + MCP config into /workspace/.philharmonic/. See SPEC §13.
#
# Wired into wrangler.jsonc `containers` binding starting at M5. M0 ships the
# image source so the Deploy button has a buildable image once enabled.

FROM node:22-bookworm-slim

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

# M6: pre-install Tasks MCP server (containers/sandbox/mcp/tasks-mcp).
#   COPY mcp/tasks-mcp /opt/tasks-mcp
#   WORKDIR /opt/tasks-mcp
#   RUN npm ci && npm run build

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /workspace
ENV PATH="/usr/local/bin:${PATH}"
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
