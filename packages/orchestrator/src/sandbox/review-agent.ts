import Anthropic from "@anthropic-ai/sdk";
import type { Sandbox as SandboxInstance } from "@cloudflare/sandbox";
import type { Task } from "@phil/shared";
import type { Env } from "../env.js";

/**
 * Tools available during review fix — same as main agent but scoped in prompt.
 */
const REVIEW_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "fs_read",
    description: "Read the contents of a file at the given path.",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string", description: "Absolute or relative file path" } },
      required: ["path"],
    },
  },
  {
    name: "fs_write",
    description: "Write content to a file, creating directories as needed.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path to write to" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "shell_exec",
    description: "Execute a shell command and return its output.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "Shell command to run" },
      },
      required: ["command"],
    },
  },
  {
    name: "git_commit",
    description: "Stage files and create a git commit.",
    input_schema: {
      type: "object" as const,
      properties: {
        message: { type: "string", description: "Commit message" },
        files: { type: "array", items: { type: "string" }, description: "Files to stage (omit to stage all)" },
      },
      required: ["message"],
    },
  },
  {
    name: "git_push",
    description: "Push commits to the remote feature branch.",
    input_schema: {
      type: "object" as const,
      properties: {
        branch: { type: "string", description: "Branch name to push" },
      },
      required: ["branch"],
    },
  },
];

function buildReviewSystemPrompt(task: Task, reviewContext: string): string {
  return `You are Phil's review-fix agent. A PR has been reviewed and you need to address the reviewer's comments.

## Context
- Branch: ${task.branchName}
- Repository: ${task.repoUrl}
- PR: ${task.prUrl ?? "unknown"}
- Task: ${task.description}

## Review Comments to Address
${reviewContext}

## Instructions
1. Read the files mentioned in the review comments (or the relevant files)
2. Make the requested changes
3. Commit with a clear message referencing the review feedback
4. Push to the branch (the PR will auto-update)

## Rules
- Only make changes that address the review comments — don't refactor or change unrelated code
- Keep commits focused and descriptive
- Do NOT run install, build, test, or lint commands unless the reviewer specifically asks you to verify something
- If a review comment is unclear or contradictory, make your best judgment and note it in the commit message
- NEVER force-push
- NEVER run git reset, git rebase, or any destructive git operations
- After pushing, you are DONE. Do not try to verify or fetch — just stop
`;
}

/**
 * Runs a scoped agent loop to address PR review comments.
 * Reuses the existing sandbox (still has the repo + branch).
 */
export async function runReviewFixLoop(
  sandbox: SandboxInstance,
  task: Task,
  reviewContext: string,
  env: Env,
  onLog: (message: string) => Promise<void>,
): Promise<{ pushed: boolean }> {
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const systemPrompt = buildReviewSystemPrompt(task, reviewContext);

  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: "Address the review comments above. Read the relevant files, make the fixes, commit, and push.",
    },
  ];

  let pushed = false;
  const maxTurns = 25; // Review fixes should be quick

  for (let turn = 0; turn < maxTurns; turn++) {
    await onLog(`Review fix turn ${turn + 1}/${maxTurns}`);

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: systemPrompt,
      tools: REVIEW_TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const textBlocks = response.content.filter((b) => b.type === "text");
      if (textBlocks.length > 0) {
        await onLog(`Review fix done: ${(textBlocks[0] as Anthropic.Messages.TextBlock).text.slice(0, 200)}`);
      }
      break;
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      const input = toolUse.input as Record<string, unknown>;
      await onLog(`Tool: ${toolUse.name} ${JSON.stringify(input).slice(0, 100)}`);

      try {
        const result = await executeReviewTool(sandbox, toolUse.name, input, env);

        if (toolUse.name === "git_push") {
          pushed = true;
          await onLog("Changes pushed to PR");
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: String(result).slice(0, 10_000),
        });
      } catch (err) {
        await onLog(`Tool error: ${toolUse.name} - ${err}`);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Error: ${err}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  return { pushed };
}

/**
 * Execute a tool — same as main agent but reuses the tool implementations.
 */
async function executeReviewTool(
  sandbox: SandboxInstance,
  toolName: string,
  input: Record<string, unknown>,
  env: Env,
): Promise<string> {
  switch (toolName) {
    case "fs_read": {
      const result = await sandbox.readFile(input.path as string);
      return result.content;
    }
    case "fs_write": {
      await sandbox.writeFile(input.path as string, input.content as string);
      return `Written to ${input.path}`;
    }
    case "shell_exec": {
      const result = await sandbox.exec(input.command as string, {
        cwd: "/workspace",
        timeout: 120_000,
      });
      const output = (result.stdout ?? "") + (result.stderr ? `\nSTDERR:\n${result.stderr}` : "");
      if (!result.success) {
        return `EXIT ${result.exitCode}\n${output}`;
      }
      return output || "(no output)";
    }
    case "git_commit": {
      const files = input.files as string[] | undefined;
      if (files && files.length > 0) {
        await sandbox.exec(`git add ${files.join(" ")}`, { cwd: "/workspace" });
      } else {
        await sandbox.exec("git add -A", { cwd: "/workspace" });
      }
      const result = await sandbox.exec(
        `git commit -m "${(input.message as string).replace(/"/g, '\\"')}"`,
        { cwd: "/workspace" },
      );
      return result.stdout ?? result.stderr ?? "Committed";
    }
    case "git_push": {
      const branch = input.branch as string;
      const token = env.GITHUB_TOKEN ?? "";
      const remoteResult = await sandbox.exec("git remote get-url origin", { cwd: "/workspace" });
      const originalUrl = remoteResult.stdout?.trim() ?? "";
      if (!token) return "Push failed: GITHUB_TOKEN not set";
      const authedUrl = originalUrl.replace("https://", `https://x-access-token:${token}@`);
      await sandbox.exec(`git remote set-url origin '${authedUrl}'`, { cwd: "/workspace" });
      const pushResult = await sandbox.exec(`git push origin ${branch}`, {
        cwd: "/workspace",
        timeout: 60_000,
      });
      await sandbox.exec(`git remote set-url origin '${originalUrl}'`, { cwd: "/workspace" });
      if (!pushResult.success) {
        return `Push failed (exit ${pushResult.exitCode}): ${pushResult.stderr ?? pushResult.stdout ?? "unknown error"}`;
      }
      return pushResult.stderr ?? pushResult.stdout ?? "Pushed";
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
