import type { Sandbox as SandboxInstance } from "@cloudflare/sandbox";
import type { DispatchPayload } from "@phil/shared";
import type { Env } from "../env.js";

/**
 * Build the CLAUDE.md content that gives Claude Code its task context.
 * This replaces the old -p prompt + --append-system-prompt approach.
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

## Rules
- Port 3000 is RESERVED — use port 8080 for any servers.
- After completing all subtasks: git add, git commit, git push, then gh pr create.
- Keep PR titles concise and PR bodies brief.
- Do NOT run install commands unless the task specifically requires adding dependencies.
- Never force-push unless rebasing.
- If the project can serve a web UI, start the dev server in the background on port 8080.
`;

  if (existingClaudeMd && existingClaudeMd.trim()) {
    return existingClaudeMd + "\n\n" + philSection;
  }
  return philSection;
}

/**
 * Build the prompt for Claude Code from the dispatch payload.
 * Used as the initial message sent to the interactive Claude Code session.
 */
export function buildPrompt(payload: DispatchPayload): string {
  const subtaskList = payload.subtasks
    .map((s, i) => `${i + 1}. [${s.id}] ${s.description}\n   Files: ${s.fileTargets.join(", ") || "TBD"}`)
    .join("\n");

  return `You are working on a coding task in a git repository.

## Task context
- Branch: ${payload.branchName}
- Repository: ${payload.repoContext.repoUrl}
- Project type: ${payload.repoContext.projectType}

## Subtasks to complete (in order)
${subtaskList}

## Instructions
1. Read the relevant files to understand the project structure
2. Implement each subtask
3. Commit your changes with clear messages
4. Push to the branch: ${payload.branchName}
5. Open a PR using \`gh pr create\`
6. **Preview**: If the project can serve a web UI, start the dev server in the background and note the port.
   - **IMPORTANT: Port 3000 is RESERVED and CANNOT be used.** Use port 8080 instead.

Begin working on the task now.`;
}

/**
 * Build the append-system-prompt with Phil-specific rules.
 */
export function buildSystemAppend(): string {
  return `## Phil Agent Rules
- You are running inside a sandboxed container as Phil's coding agent.
- Port 3000 is RESERVED by the system — configure any servers to use port 8080.
- After completing all subtasks, you MUST: git add, git commit, git push, then gh pr create.
- Do NOT run install commands unless the task specifically requires adding dependencies.
- Keep PR titles concise and PR bodies brief.
- Never force-push unless rebasing.`;
}

/**
 * Parse a stream-json NDJSON line for logging purposes.
 * Returns a human-readable log message or null if not interesting.
 */
export function parseStreamEvent(line: string): string | null {
  try {
    const event = JSON.parse(line);
    if (event.type === "stream_event") {
      const e = event.event;
      // Tool use start
      if (e?.type === "content_block_start" && e?.content_block?.type === "tool_use") {
        return `Tool: ${e.content_block.name}`;
      }
      // Tool use with input
      if (e?.type === "tool_use") {
        const input = JSON.stringify(e.input ?? {}).slice(0, 120);
        return `Tool: ${e.name} ${input}`;
      }
    }
    if (event.type === "result") {
      return `Claude Code finished`;
    }
  } catch {
    // Not valid JSON, skip
  }
  return null;
}

/**
 * Configures a sandbox so that when the user connects via proxyTerminal(),
 * Claude Code auto-launches in the PTY shell.
 *
 * We write env vars + auto-start logic to /root/.bashrc so the terminal
 * session runs Claude Code directly. The user sees Claude working in real-time
 * and can type to it.
 *
 * Returns immediately — Claude Code starts when the terminal PTY connects.
 */
export async function startInteractiveAgent(
  sandbox: SandboxInstance,
  payload: DispatchPayload,
  env: Env,
  onLog: (message: string) => Promise<void>,
  _onResult?: (result: { prUrl?: string; previewUrl?: string }) => Promise<void>,
): Promise<void> {
  const token = env.GITHUB_TOKEN ?? "";

  // Set up git credentials
  if (token) {
    await sandbox.exec(
      `git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password=${token}"; }; f'`,
    );
  }

  // Read existing CLAUDE.md if the repo has one
  const existingClaudeMd = await sandbox.exec("cat /workspace/CLAUDE.md 2>/dev/null || true");
  const claudeMdContent = buildClaudeMd(payload, existingClaudeMd.stdout.trim() || undefined);
  await sandbox.writeFile("/workspace/CLAUDE.md", claudeMdContent);

  await onLog("Sandbox ready — writing startup script...");

  // Create phil user at runtime (handles both old and new container images)
  await sandbox.exec("id phil &>/dev/null || useradd -m -s /bin/bash phil");
  await sandbox.exec("chown -R phil:phil /workspace");

  // Set up git config for the phil user
  await sandbox.exec('runuser -u phil -- git config --global user.name "Phil Agent"');
  await sandbox.exec('runuser -u phil -- git config --global user.email "phil@agent.local"');
  if (token) {
    await sandbox.exec(
      `runuser -u phil -- git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password=${token}"; }; f'`,
    );
  }

  // Pre-create Claude Code config to skip first-run onboarding
  // The onboarding flag lives in ~/.claude.json (NOT ~/.claude/state.json)
  await sandbox.exec("mkdir -p /home/phil/.claude");
  await sandbox.writeFile("/home/phil/.claude.json", JSON.stringify({ hasCompletedOnboarding: true }));
  await sandbox.exec("chown phil:phil /home/phil/.claude.json");
  await sandbox.exec("chown -R phil:phil /home/phil/.claude");

  // Write startup script to /workspace (guaranteed shared between exec and terminal)
  // Uses tmux so the session persists across terminal reconnects.
  // Socket in /workspace so it's visible from both exec() and proxyTerminal() contexts.
  // IMPORTANT: onboarding skip config MUST be created inside this script (not via
  // sandbox.writeFile) because the terminal PTY has a separate filesystem view.
  const startScript = `#!/bin/bash
SOCK=/workspace/.tmux.sock

# If tmux session already exists, just attach
if tmux -S "$SOCK" has-session -t claude 2>/dev/null; then
  exec tmux -S "$SOCK" attach -t claude
fi

# First run — set up user and config
id phil &>/dev/null || useradd -m -s /bin/bash phil
chown -R phil:phil /workspace /home/phil 2>/dev/null

# Create Claude Code onboarding skip config (must run in PTY context)
mkdir -p /home/phil/.claude
echo '{"hasCompletedOnboarding":true}' > /home/phil/.claude.json
chown -R phil:phil /home/phil/.claude /home/phil/.claude.json

# Start Claude Code inside a tmux session
exec tmux -S "$SOCK" new-session -s claude "runuser -u phil -- bash -c '
  export ANTHROPIC_API_KEY=\\"${env.ANTHROPIC_API_KEY}\\"
  export GH_TOKEN=\\"${token}\\"
  export GITHUB_TOKEN=\\"${token}\\"
  export HOME=\\"/home/phil\\"
  export DISABLE_INTERACTIVITY=1
  cd /workspace
  exec claude --dangerously-skip-permissions --verbose
'"
`;
  await sandbox.writeFile("/workspace/.phil-start.sh", startScript);
  await sandbox.exec("chmod +x /workspace/.phil-start.sh");

  // Verify the file exists
  const check = await sandbox.exec("ls -la /workspace/.phil-start.sh");
  await onLog(`Startup script written: ${check.stdout.trim()}`);
  await onLog("Claude Code will start when terminal connects.");
}

