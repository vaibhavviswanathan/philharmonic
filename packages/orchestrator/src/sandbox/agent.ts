import type { Sandbox as SandboxInstance } from "@cloudflare/sandbox";
import type { DispatchPayload } from "@phil/shared";
import type { Env } from "../env.js";

/**
 * Build the CLAUDE.md content that gives Claude Code its task context.
 * Claude Code reads CLAUDE.md natively at startup.
 */
export function buildClaudeMd(
  payload: DispatchPayload,
  existingClaudeMd?: string,
): string {
  const subtaskList = payload.subtasks
    .map((s, i) => `${i + 1}. [${s.id}] ${s.description}\n   Files: ${s.fileTargets.join(", ") || "TBD"}`)
    .join("\n");

  const philSection = `
# Phil Task Instructions

## Task
${payload.subtasks.length > 0 ? payload.subtasks.map((s) => s.description).join("; ") : "See subtasks below"}

## Branch: ${payload.branchName}

## Subtasks (complete in order)
${subtaskList}

## How You Work
You are being managed by a manager agent that will send you instructions via the terminal.
- **Wait for instructions** — don't start working until the manager tells you what to do.
- **Follow the manager's instructions** — it will tell you when to plan, execute, create PRs, etc.
- When you finish a step, return to the idle prompt so the manager knows you're done.

## Rules
- Port 3000 is RESERVED — use port 8080 for any servers.
- Keep PR titles concise and PR bodies brief.
- Do NOT run install commands unless the task specifically requires adding dependencies.
- Never force-push unless rebasing.
`;

  if (existingClaudeMd && existingClaudeMd.trim()) {
    return existingClaudeMd + "\n\n" + philSection;
  }
  return philSection;
}

/**
 * Build the self-contained startup script that handles EVERYTHING:
 * - Clone repo if not present (container may have recycled)
 * - Create branch
 * - Set up git credentials
 * - Write CLAUDE.md
 * - Skip onboarding
 * - Launch Claude Code inside tmux
 *
 * This script is the `shell` for proxyTerminal(), so it runs every time
 * the user opens the terminal tab. It's idempotent — if tmux is already
 * running, it just attaches.
 */
export function buildStartScript(
  payload: DispatchPayload,
  env: Env,
): string {
  const token = env.GITHUB_TOKEN ?? "";
  const apiKey = env.ANTHROPIC_API_KEY ?? "";
  const repoUrl = payload.repoContext.repoUrl;
  const authedUrl = token
    ? repoUrl.replace("https://", `https://x-access-token:${token}@`)
    : repoUrl;
  const claudeMdContent = buildClaudeMd(payload);
  // Escape single quotes and backslashes for embedding in shell heredoc
  const claudeMdEscaped = claudeMdContent.replace(/\\/g, "\\\\").replace(/'/g, "'\\''");

  return `#!/bin/bash
set -e
SOCK=/workspace/.tmux.sock

# If tmux session already exists, just attach
if tmux -S "$SOCK" has-session -t claude 2>/dev/null; then
  exec tmux -S "$SOCK" attach -t claude
fi

echo "Setting up sandbox..."

# Create phil user if needed
id phil &>/dev/null || useradd -m -s /bin/bash phil

# Clone repo if workspace has no git repo (container recycled)
if [ ! -d /workspace/.git ]; then
  echo "Cloning repository..."
  git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password=${token}"; }; f'
  # Clone to temp dir and move (workspace may contain our startup script)
  git clone '${authedUrl}' /tmp/phil-repo 2>&1
  cp -a /tmp/phil-repo/. /workspace/
  rm -rf /tmp/phil-repo
  cd /workspace
  git remote set-url origin '${repoUrl}'
  git checkout -b '${payload.branchName}' 2>/dev/null || git checkout '${payload.branchName}' 2>/dev/null || true
else
  cd /workspace
fi

chown -R phil:phil /workspace /home/phil 2>/dev/null

# Git config for phil user
runuser -u phil -- git config --global user.name "Phil Agent"
runuser -u phil -- git config --global user.email "phil@agent.local"
runuser -u phil -- git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password=${token}"; }; f'

# Write CLAUDE.md with task instructions
cat > /workspace/CLAUDE.md << 'CLAUDEMD'
${claudeMdEscaped}
CLAUDEMD
chown phil:phil /workspace/CLAUDE.md

# Skip Claude Code onboarding and trust dialogs
mkdir -p /home/phil/.claude
cat > /home/phil/.claude.json << 'CJSON'
{"hasCompletedOnboarding":true,"bypassPermissionsAccepted":true}
CJSON

# Pre-approve all permissions so no interactive prompts appear
mkdir -p /workspace/.claude
cat > /workspace/.claude/settings.json << 'SJSON'
{"permissions":{"allow":["Bash(*)","Read(*)","Write(*)","Edit(*)","Glob(*)","Grep(*)","WebFetch(*)","WebSearch(*)","mcp__*"],"deny":[]}}
SJSON

# Mark workspace as trusted in global settings
mkdir -p /home/phil/.claude
cat > /home/phil/.claude/settings.json << 'GSJSON'
{"permissions":{"allow":["Bash(*)","Read(*)","Write(*)","Edit(*)","Glob(*)","Grep(*)","WebFetch(*)","WebSearch(*)","mcp__*"],"deny":[]},"trustedDirectories":["/workspace"]}
GSJSON

chown -R phil:phil /home/phil/.claude /home/phil/.claude.json /workspace/.claude

echo "Starting Claude Code..."

# Launch Claude Code inside tmux (detached)
tmux -S "$SOCK" new-session -d -s claude "runuser -u phil -- bash -c '
  export ANTHROPIC_API_KEY=\\"${apiKey}\\"
  export GH_TOKEN=\\"${token}\\"
  export GITHUB_TOKEN=\\"${token}\\"
  export HOME=\\"/home/phil\\"
  export TERM=xterm-256color
  cd /workspace
  exec claude --dangerously-skip-permissions --verbose
'"

# If running interactively (terminal), attach to the session
if [ -t 0 ]; then
  exec tmux -S "$SOCK" attach -t claude
fi
`;
}

/**
 * Ensure the startup script exists in the sandbox.
 * Called right before proxyTerminal() so the script is always fresh,
 * even if the container was recycled.
 */
export async function ensureSandboxReady(
  sandbox: SandboxInstance,
  payload: DispatchPayload,
  env: Env,
): Promise<void> {
  const script = buildStartScript(payload, env);
  await sandbox.writeFile("/workspace/.phil-start.sh", script);
  await sandbox.exec("chmod +x /workspace/.phil-start.sh");
}
