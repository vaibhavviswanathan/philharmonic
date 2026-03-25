import Anthropic from "@anthropic-ai/sdk";
import type { DispatchPayload, Subtask } from "@phil/shared";
import { ToolProxy } from "./proxy.js";
import { fsRead } from "./tools/fs-read.js";
import { fsWrite } from "./tools/fs-write.js";
import { shellExec } from "./tools/shell-exec.js";
import { gitCommit, gitPush } from "./tools/git.js";
import { githubPr } from "./tools/github-pr.js";

const anthropic = new Anthropic();

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
    description: "Execute a shell command and return its output.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "The command to run (passed to shell)" },
        args: { type: "array", items: { type: "string" }, description: "Command arguments" },
        cwd: { type: "string", description: "Working directory (defaults to /workspace)" },
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
    description: "Create a pull request on GitHub.",
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

const toolHandlers: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
  fs_read: (input) => fsRead(input as { path: string }),
  fs_write: (input) => fsWrite(input as { path: string; content: string }),
  shell_exec: (input) => shellExec(input as { command: string; args?: string[]; cwd?: string }),
  git_commit: (input) => gitCommit(input as { message: string; files?: string[] }),
  git_push: (input) => gitPush(input as { branch: string }),
  github_pr: (input) => githubPr(input as { title: string; body: string; base?: string }),
};

function buildSystemPrompt(payload: DispatchPayload): string {
  return `You are Phil's coding agent running inside a sandbox. Your task is to implement code changes, write tests, and open a pull request.

## Task context
- Branch: ${payload.branchName}
- Repository: ${payload.repoContext.repoUrl}
- Project type: ${payload.repoContext.projectType}
${payload.repoContext.testFramework ? `- Test framework: ${payload.repoContext.testFramework}` : ""}
${payload.repoContext.packageManager ? `- Package manager: ${payload.repoContext.packageManager}` : ""}

## Subtasks to complete (in order)
${payload.subtasks.map((s, i) => `${i + 1}. [${s.id}] ${s.description}\n   Files: ${s.fileTargets.join(", ") || "TBD"}`).join("\n")}

## Touch set (files you may modify)
${payload.touchSet.join("\n") || "Not restricted"}

## Instructions
1. Work through each subtask in order
2. After implementing each subtask, commit your changes with a clear message
3. Write tests alongside your implementation
4. Run the test suite to verify your changes
5. Once all subtasks are complete, push to the branch and open a PR
6. The PR description should explain what changed, why, and include test results

## Rules
- Never force-push
- Never modify files outside the touch set without good reason
- Commit after each logical unit of work
- Run tests before pushing
- The PR title should be concise and descriptive
`;
}

export async function runAgent(
  payload: DispatchPayload,
  onLog: (message: string) => void,
): Promise<{ prUrl?: string }> {
  const proxy = new ToolProxy();
  proxy.setPhase("implement");

  const systemPrompt = buildSystemPrompt(payload);
  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: "Begin working on the task. Start with subtask 1 and work through each one in order. When all subtasks are complete, push and open a PR.",
    },
  ];

  let prUrl: string | undefined;
  const maxTurns = 50;

  for (let turn = 0; turn < maxTurns; turn++) {
    onLog(`Agent turn ${turn + 1}/${maxTurns}`);

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });

    // Collect the assistant message
    messages.push({ role: "assistant", content: response.content });

    // If the model is done (no tool use), we're finished
    if (response.stop_reason === "end_turn") {
      const textBlocks = response.content.filter((b) => b.type === "text");
      if (textBlocks.length > 0) {
        onLog(`Agent finished: ${(textBlocks[0] as Anthropic.Messages.TextBlock).text.slice(0, 200)}`);
      }
      break;
    }

    // Process tool calls
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      onLog(`Tool: ${toolUse.name} ${JSON.stringify(toolUse.input).slice(0, 100)}`);

      const handler = toolHandlers[toolUse.name];
      if (!handler) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Unknown tool: ${toolUse.name}`,
          is_error: true,
        });
        continue;
      }

      try {
        const result = await proxy.execute(
          toolUse.name,
          toolUse.input,
          () => handler(toolUse.input as Record<string, unknown>),
        );
        const resultStr = typeof result === "string" ? result : JSON.stringify(result);

        // Detect PR URL
        if (toolUse.name === "github_pr" && typeof result === "string" && result.includes("github.com")) {
          prUrl = result;
          onLog(`PR created: ${prUrl}`);
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: resultStr.slice(0, 10_000),
        });
      } catch (err) {
        onLog(`Tool error: ${toolUse.name} - ${err}`);
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
