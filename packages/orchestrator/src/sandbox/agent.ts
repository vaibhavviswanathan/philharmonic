import type { Sandbox as SandboxInstance } from "@cloudflare/sandbox";
import type { DispatchPayload } from "@phil/shared";
import type { Env } from "../env.js";

/**
 * Build the prompt for Claude Code from the dispatch payload.
 */
function buildPrompt(payload: DispatchPayload): string {
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
function buildSystemAppend(): string {
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
function parseStreamEvent(line: string): string | null {
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
 * Runs Claude Code CLI inside the sandbox container.
 * Streams output via NDJSON polling for real-time dashboard logs.
 */
export async function runAgentLoop(
  sandbox: SandboxInstance,
  payload: DispatchPayload,
  env: Env,
  onLog: (message: string) => Promise<void>,
  onResult?: (result: { prUrl?: string; previewUrl?: string }) => Promise<void>,
): Promise<{ prUrl?: string; previewUrl?: string; agentContext?: string }> {
  const prompt = buildPrompt(payload);
  const systemAppend = buildSystemAppend();

  // Write prompt to file to avoid shell escaping issues
  await sandbox.writeFile("/tmp/phil-prompt.txt", prompt);
  await sandbox.writeFile("/tmp/phil-system-append.txt", systemAppend);

  // Set up git credentials for push
  const token = env.GITHUB_TOKEN ?? "";
  if (token) {
    await sandbox.exec(
      `git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password=${token}"; }; f'`,
    );
  }

  await onLog("Starting Claude Code agent...");

  // Clean up any previous output
  await sandbox.exec("rm -f /tmp/claude-output.jsonl /tmp/claude-exit-code");

  // Start Claude Code in background
  const claudeCmd = [
    'claude',
    '-p', '"$(cat /tmp/phil-prompt.txt)"',
    '--append-system-prompt-file', '/tmp/phil-system-append.txt',
    '--allowedTools', '"Bash,Read,Write,Edit,Glob,Grep"',
    '--output-format', 'stream-json',
    '--max-turns', '200',
    '--verbose',
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

  // Poll for output
  let lastLine = 0;
  const maxWallClock = 10 * 60 * 1000; // 10 minutes
  const startTime = Date.now();
  const pollInterval = 3000; // 3 seconds

  while (Date.now() - startTime < maxWallClock) {
    await new Promise((r) => setTimeout(r, pollInterval));

    // Read new lines from output file
    try {
      const tail = await sandbox.exec(
        `tail -n +${lastLine + 1} /tmp/claude-output.jsonl 2>/dev/null || true`,
      );
      if (tail.success && tail.stdout.trim()) {
        const lines = tail.stdout.split("\n").filter(Boolean);
        for (const line of lines) {
          lastLine++;
          const logMsg = parseStreamEvent(line);
          if (logMsg) {
            await onLog(logMsg);
          }
        }
      }
    } catch {
      // File might not exist yet
    }

    // Check if process finished
    try {
      const exitCheck = await sandbox.exec("cat /tmp/claude-exit-code 2>/dev/null || echo 'running'");
      if (exitCheck.success && exitCheck.stdout.trim() !== "running") {
        const exitCode = parseInt(exitCheck.stdout.trim(), 10);
        await onLog(`Claude Code exited with code ${exitCode}`);
        break;
      }
    } catch {
      // Still running
    }
  }

  // Check for timeout
  if (Date.now() - startTime >= maxWallClock) {
    await onLog("Claude Code hit 10min wall-clock limit — stopping");
    await sandbox.exec("pkill -f 'claude.*-p' 2>/dev/null || true");
  }

  // Capture agent context (the full NDJSON output) for post-hoc inspection
  let agentContext: string | undefined;
  try {
    const ctxResult = await sandbox.exec("cat /tmp/claude-output.jsonl 2>/dev/null || true");
    if (ctxResult.success && ctxResult.stdout.trim()) {
      // Extract tool calls and text responses for a structured summary
      const lines = ctxResult.stdout.split("\n").filter(Boolean);
      const summary: Array<{ type: string; content: string }> = [];
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === "stream_event") {
            const e = event.event;
            if (e?.type === "tool_use") {
              summary.push({ type: "tool", content: `${e.name}: ${JSON.stringify(e.input ?? {}).slice(0, 500)}` });
            } else if (e?.type === "text" && e?.text) {
              summary.push({ type: "text", content: e.text.slice(0, 1000) });
            }
          } else if (event.type === "result") {
            summary.push({ type: "result", content: JSON.stringify(event).slice(0, 2000) });
          }
        } catch { /* skip non-JSON lines */ }
      }
      agentContext = JSON.stringify(summary);
    }
  } catch { /* best effort */ }

  // Post-processing: extract PR URL
  let prUrl: string | undefined;
  try {
    const prResult = await sandbox.exec(
      `GH_TOKEN=${token} gh pr list --json url --state open --head ${payload.branchName} -q '.[0].url' 2>/dev/null || true`,
      { cwd: "/workspace" },
    );
    if (prResult.success && prResult.stdout.trim().startsWith("https://")) {
      prUrl = prResult.stdout.trim();
      await onLog(`PR created: ${prUrl}`);
      if (onResult) await onResult({ prUrl }).catch(() => {});
    }
  } catch {
    // No PR found
  }

  // Post-processing: detect or start preview server on port 8080
  console.log("[agent] Post-processing: checking for preview server");
  let previewUrl: string | undefined;
  const hostname = env.PREVIEW_HOSTNAME ?? new URL(env.WORKER_URL ?? "https://localhost").hostname;
  console.log(`[agent] Using preview hostname: ${hostname}`);
  try {
    let portCheck = await sandbox.exec("curl -sf http://localhost:8080 -o /dev/null && echo 'LISTENING' || echo 'CLOSED'");
    console.log(`[agent] Port check result: ${portCheck.stdout}`);

    // If no server running, try to start one automatically
    if (!portCheck.stdout.includes("LISTENING")) {
      await onLog("No server on port 8080 — attempting to start one...");

      // Strategy 1: Look for a pre-built dist/ directory with index.html — serve statically (fast)
      const findDist = await sandbox.exec(
        `find /workspace -maxdepth 4 -path '*/dist/index.html' -not -path '*/node_modules/*' 2>/dev/null | head -1 || true`,
      );
      if (findDist.success && findDist.stdout.trim()) {
        const distDir = findDist.stdout.trim().replace(/\/index\.html$/, "");
        await onLog(`Found built assets at ${distDir} — serving statically`);
        await sandbox.exec(
          `bash -c 'npx -y serve ${distDir} -l 8080 > /tmp/dev-server.log 2>&1 &'`,
          { env: { HOME: "/root" } },
        );
        await new Promise((r) => setTimeout(r, 3000));
        portCheck = await sandbox.exec("curl -sf http://localhost:8080 -o /dev/null && echo 'LISTENING' || echo 'CLOSED'");
      }

      // Strategy 2: Find a frontend package and start its dev server
      if (!portCheck.stdout.includes("LISTENING")) {
        let serverDir = "/workspace";
        const findFrontend = await sandbox.exec(
          `find /workspace -maxdepth 3 -name 'vite.config.*' -o -name 'next.config.*' 2>/dev/null | grep -v node_modules | head -1 || true`,
        );
        if (findFrontend.success && findFrontend.stdout.trim()) {
          serverDir = findFrontend.stdout.trim().replace(/\/[^/]+$/, "");
          console.log(`[agent] Found frontend package at: ${serverDir}`);
        }

        const pkgCheck = await sandbox.exec(`cat ${serverDir}/package.json 2>/dev/null || true`);
        if (pkgCheck.success && pkgCheck.stdout.includes("{")) {
          await onLog(`Installing dependencies in ${serverDir}...`);
          const hasPnpm = await sandbox.exec(`ls /workspace/pnpm-lock.yaml 2>/dev/null && echo 'yes' || echo 'no'`);
          const installCmd = hasPnpm.stdout.includes("yes")
            ? `cd /workspace && pnpm install --no-frozen-lockfile 2>&1`
            : `cd ${serverDir} && npm install --no-audit --no-fund 2>&1`;
          await sandbox.exec(installCmd, { cwd: serverDir });

          const startCmd = pkgCheck.stdout.includes('"dev"')
            ? "npm run dev -- --port 8080 --host 0.0.0.0"
            : pkgCheck.stdout.includes('"start"')
              ? "PORT=8080 npm start"
              : `npx -y serve ${serverDir} -l 8080`;
          await onLog(`Starting server in ${serverDir}: ${startCmd}`);
          await sandbox.exec(
            `bash -c 'cd ${serverDir} && ${startCmd} > /tmp/dev-server.log 2>&1 &'`,
            { env: { PORT: "8080", HOME: "/root" } },
          );
          await new Promise((r) => setTimeout(r, 8000));
          portCheck = await sandbox.exec("curl -sf http://localhost:8080 -o /dev/null && echo 'LISTENING' || echo 'CLOSED'");
          if (!portCheck.stdout.includes("LISTENING")) {
            const serverLog = await sandbox.exec("tail -20 /tmp/dev-server.log 2>/dev/null || true");
            await onLog(`Server failed to start. Log: ${serverLog.stdout.slice(0, 300)}`);
          }
        }
      }
    }

    if (portCheck.success && portCheck.stdout.includes("LISTENING")) {
      await onLog("Preview server detected on port 8080 — exposing...");
      const exposed = await sandbox.exposePort(8080, { hostname });
      previewUrl = exposed.url;
      await onLog(`Preview URL: ${previewUrl}`);
      if (onResult) await onResult({ prUrl, previewUrl }).catch(() => {});
    }
  } catch (err) {
    console.error(`[agent] Preview expose error:`, err);
    await onLog(`Preview expose failed: ${err}`);
  }

  return { prUrl, previewUrl, agentContext };
}
