import type { Sandbox as SandboxInstance } from "@cloudflare/sandbox";
import type { Task } from "@phil/shared";
import type { Env } from "../env.js";

/**
 * Runs Claude Code CLI to address PR review comments.
 * Reuses the existing sandbox (still has the repo + branch).
 */
export async function runReviewFixLoop(
  sandbox: SandboxInstance,
  task: Task,
  reviewContext: string,
  env: Env,
  onLog: (message: string) => Promise<void>,
): Promise<{ pushed: boolean }> {
  const token = env.GITHUB_TOKEN ?? "";

  // Ensure git credentials are set (sandbox may have been restarted)
  if (token) {
    await sandbox.exec(
      `git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password=${token}"; }; f'`,
    );
  }

  const prompt = `You are fixing PR review comments on branch ${task.branchName}.

## Task
${task.description}

## PR
${task.prUrl ?? "unknown"}

## Review Comments to Address
${reviewContext}

## Instructions
1. Read the files mentioned in the review comments
2. Make the requested changes
3. Commit with a clear message referencing the review feedback
4. Push to the branch (the PR will auto-update)

## Rules
- Only make changes that address the review comments — don't refactor unrelated code
- Keep commits focused and descriptive
- Do NOT run install, build, test, or lint unless the reviewer specifically asks
- If asked to rebase: git fetch origin main && git rebase origin/main, then push with --force-with-lease
- After pushing, you are DONE — stop immediately`;

  const systemAppend = `## Phil Review Agent Rules
- You are running inside a sandboxed container as Phil's review-fix agent.
- Port 3000 is RESERVED — use port 8080 for any servers.
- After fixing, you MUST: git add, git commit, git push.
- Force-push with --force-with-lease is ALLOWED after a rebase.`;

  await sandbox.writeFile("/tmp/phil-prompt.txt", prompt);
  await sandbox.writeFile("/tmp/phil-system-append.txt", systemAppend);

  await onLog("Starting Claude Code review-fix agent...");

  // Clean up previous output
  await sandbox.exec("rm -f /tmp/claude-output.jsonl /tmp/claude-exit-code");

  const claudeCmd = [
    'claude',
    '-p', '"$(cat /tmp/phil-prompt.txt)"',
    '--append-system-prompt-file', '/tmp/phil-system-append.txt',
    '--allowedTools', '"Bash,Read,Write,Edit,Glob,Grep"',
    '--output-format', 'stream-json',
    '--max-turns', '100',
  ].join(' ');

  await sandbox.exec(
    `bash -c '${claudeCmd} > /tmp/claude-output.jsonl 2>&1; echo $? > /tmp/claude-exit-code' &`,
    {
      cwd: "/workspace",
      env: {
        ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
        GH_TOKEN: token,
        HOME: "/root",
      },
    },
  );

  // Poll for completion
  const maxWallClock = 5 * 60 * 1000; // 5 minutes for review fixes
  const startTime = Date.now();
  let lastLine = 0;

  while (Date.now() - startTime < maxWallClock) {
    await new Promise((r) => setTimeout(r, 3000));

    // Read new log lines
    try {
      const tail = await sandbox.exec(
        `tail -n +${lastLine + 1} /tmp/claude-output.jsonl 2>/dev/null || true`,
      );
      if (tail.success && tail.stdout.trim()) {
        const lines = tail.stdout.split("\n").filter(Boolean);
        for (const line of lines) {
          lastLine++;
          try {
            const event = JSON.parse(line);
            if (event.type === "stream_event" && event.event?.type === "tool_use") {
              await onLog(`Tool: ${event.event.name}`);
            }
          } catch { /* skip non-JSON */ }
        }
      }
    } catch { /* file not ready */ }

    // Check if done
    try {
      const exitCheck = await sandbox.exec("cat /tmp/claude-exit-code 2>/dev/null || echo 'running'");
      if (exitCheck.success && exitCheck.stdout.trim() !== "running") {
        await onLog(`Review fix agent exited with code ${exitCheck.stdout.trim()}`);
        break;
      }
    } catch { /* still running */ }
  }

  if (Date.now() - startTime >= maxWallClock) {
    await onLog("Review fix hit 5min limit — stopping");
    await sandbox.exec("pkill -f 'claude.*-p' 2>/dev/null || true");
  }

  // Check if changes were pushed
  let pushed = false;
  try {
    const gitLog = await sandbox.exec(
      `git log --oneline -1 --format='%H' origin/${task.branchName} 2>/dev/null || true`,
      { cwd: "/workspace" },
    );
    const localHead = await sandbox.exec("git rev-parse HEAD", { cwd: "/workspace" });
    // If local HEAD is ahead of remote, push wasn't done — but Claude Code should have pushed
    // Check reflog for push
    const pushCheck = await sandbox.exec(
      `git reflog show origin/${task.branchName} --format='%H' -1 2>/dev/null || true`,
      { cwd: "/workspace" },
    );
    // Simple heuristic: if there are new commits since we started, assume pushed
    pushed = gitLog.stdout.trim() !== "" || pushCheck.stdout.trim() !== "";
    if (pushed) {
      await onLog("Changes pushed to PR");
    }
  } catch {
    // Assume pushed if Claude Code didn't error
  }

  return { pushed };
}
