import Anthropic from "@anthropic-ai/sdk";
import type { Sandbox as SandboxInstance } from "@cloudflare/sandbox";
import type { DispatchPayload } from "@phil/shared";
import type { Env } from "../env.js";

const TOOLS: Anthropic.Messages.Tool[] = [
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
    description: "Execute a shell command and return its output. Use for running tests, installing deps, etc.",
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
  {
    name: "github_pr",
    description: "Create a pull request on GitHub using the gh CLI.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "PR title" },
        body: { type: "string", description: "PR description (markdown)" },
        base: { type: "string", description: "Base branch (defaults to repo default)" },
      },
      required: ["title", "body"],
    },
  },
];

function buildSystemPrompt(payload: DispatchPayload): string {
  return `You are Phil's coding agent. Your task is to implement code changes, write tests, and open a pull request.

## Task context
- Branch: ${payload.branchName}
- Repository: ${payload.repoContext.repoUrl}
- Project type: ${payload.repoContext.projectType}
${payload.repoContext.testFramework ? `- Test framework: ${payload.repoContext.testFramework}` : ""}
${payload.repoContext.packageManager ? `- Package manager: ${payload.repoContext.packageManager}` : ""}

## Subtasks to complete (in order)
${payload.subtasks.map((s, i) => `${i + 1}. [${s.id}] ${s.description}\n   Files: ${s.fileTargets.join(", ") || "TBD"}`).join("\n")}

## Instructions
1. Work through each subtask in order
2. After implementing each subtask, commit your changes with a clear message
3. Write tests alongside your implementation
4. Run the test suite to verify your changes
5. Once all subtasks are complete, push to the branch and open a PR
6. The PR description should explain what changed, why, and include test results

## Rules
- Never force-push
- Commit after each logical unit of work
- Run tests before pushing
- The PR title should be concise and descriptive
`;
}

/**
 * Runs the Claude agent loop, using the Sandbox SDK to execute tools.
 * The agent loop runs in the Worker; tool calls execute in the sandbox container.
 */
export async function runAgentLoop(
  sandbox: SandboxInstance,
  payload: DispatchPayload,
  env: Env,
  onLog: (message: string) => Promise<void>,
): Promise<{ prUrl?: string }> {
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const systemPrompt = buildSystemPrompt(payload);

  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: "Begin working on the task. Start with subtask 1 and work through each one. When done, push and open a PR.",
    },
  ];

  let prUrl: string | undefined;
  const maxTurns = 50;

  for (let turn = 0; turn < maxTurns; turn++) {
    await onLog(`Agent turn ${turn + 1}/${maxTurns}`);

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const textBlocks = response.content.filter((b) => b.type === "text");
      if (textBlocks.length > 0) {
        await onLog(`Agent finished: ${(textBlocks[0] as Anthropic.Messages.TextBlock).text.slice(0, 200)}`);
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
        const result = await executeTool(sandbox, toolUse.name, input, env);

        if (toolUse.name === "github_pr" && typeof result === "string" && result.includes("github.com")) {
          prUrl = result;
          await onLog(`PR created: ${prUrl}`);
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

  return { prUrl };
}

/**
 * Execute a tool call via the Sandbox SDK.
 */
async function executeTool(
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
      const result = await sandbox.exec(input.command as string, { cwd: "/workspace" });
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
      const result = await sandbox.exec(`git push origin ${branch}`, {
        cwd: "/workspace",
        env: { GITHUB_TOKEN: env.GITHUB_TOKEN },
      });
      return result.stdout ?? result.stderr ?? "Pushed";
    }
    case "github_pr": {
      const title = input.title as string;
      const body = input.body as string;
      const base = input.base as string | undefined;
      const baseArg = base ? `--base ${base}` : "";
      const result = await sandbox.exec(
        `gh pr create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" ${baseArg}`,
        {
          cwd: "/workspace",
          env: { GITHUB_TOKEN: env.GITHUB_TOKEN },
        },
      );
      return result.stdout?.trim() ?? result.stderr ?? "PR created";
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
