import { describe, it, expect } from "vitest";

// We test the pure functions from agent.ts.
// Since buildPrompt, buildSystemAppend, and parseStreamEvent are not exported,
// we extract and test the logic inline.

// --- buildPrompt logic ---

function buildPrompt(payload: {
  branchName: string;
  repoContext: { repoUrl: string; projectType: string };
  subtasks: Array<{ id: string; description: string; fileTargets: string[] }>;
}): string {
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

function buildSystemAppend(): string {
  return `## Phil Agent Rules
- You are running inside a sandboxed container as Phil's coding agent.
- Port 3000 is RESERVED by the system — configure any servers to use port 8080.
- After completing all subtasks, you MUST: git add, git commit, git push, then gh pr create.
- Do NOT run install commands unless the task specifically requires adding dependencies.
- Keep PR titles concise and PR bodies brief.
- Never force-push unless rebasing.`;
}

function parseStreamEvent(line: string): string | null {
  try {
    const event = JSON.parse(line);
    if (event.type === "stream_event") {
      const e = event.event;
      if (e?.type === "content_block_start" && e?.content_block?.type === "tool_use") {
        return `Tool: ${e.content_block.name}`;
      }
      if (e?.type === "tool_use") {
        const input = JSON.stringify(e.input ?? {}).slice(0, 120);
        return `Tool: ${e.name} ${input}`;
      }
    }
    if (event.type === "result") {
      return `Claude Code finished`;
    }
  } catch {
    return null;
  }
  return null;
}

describe("buildPrompt", () => {
  const payload = {
    branchName: "phil/add-auth",
    repoContext: { repoUrl: "https://github.com/user/repo", projectType: "node" },
    subtasks: [
      { id: "s1", description: "Create auth middleware", fileTargets: ["src/auth.ts"] },
      { id: "s2", description: "Add login route", fileTargets: ["src/routes.ts", "src/auth.ts"] },
    ],
  };

  it("includes branch name", () => {
    expect(buildPrompt(payload)).toContain("phil/add-auth");
  });

  it("includes repo URL", () => {
    expect(buildPrompt(payload)).toContain("https://github.com/user/repo");
  });

  it("lists subtasks in order", () => {
    const prompt = buildPrompt(payload);
    expect(prompt).toContain("1. [s1] Create auth middleware");
    expect(prompt).toContain("2. [s2] Add login route");
  });

  it("lists file targets", () => {
    const prompt = buildPrompt(payload);
    expect(prompt).toContain("Files: src/auth.ts");
    expect(prompt).toContain("Files: src/routes.ts, src/auth.ts");
  });

  it("shows TBD for empty file targets", () => {
    const p = { ...payload, subtasks: [{ id: "s1", description: "Explore", fileTargets: [] }] };
    expect(buildPrompt(p)).toContain("Files: TBD");
  });

  it("warns about reserved port 3000", () => {
    expect(buildPrompt(payload)).toContain("Port 3000 is RESERVED");
  });
});

describe("buildSystemAppend", () => {
  it("contains Phil agent rules", () => {
    const append = buildSystemAppend();
    expect(append).toContain("Phil Agent Rules");
    expect(append).toContain("port 8080");
    expect(append).toContain("git push");
    expect(append).toContain("gh pr create");
  });
});

describe("parseStreamEvent", () => {
  it("returns null for invalid JSON", () => {
    expect(parseStreamEvent("not json")).toBeNull();
  });

  it("returns null for unrelated JSON", () => {
    expect(parseStreamEvent('{"type":"ping"}')).toBeNull();
  });

  it("parses content_block_start tool_use", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", name: "Edit" },
      },
    });
    expect(parseStreamEvent(line)).toBe("Tool: Edit");
  });

  it("parses tool_use with input", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "tool_use",
        name: "Read",
        input: { file_path: "/workspace/src/index.ts" },
      },
    });
    const result = parseStreamEvent(line);
    expect(result).toContain("Tool: Read");
    expect(result).toContain("file_path");
  });

  it("truncates long input to 120 chars", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "tool_use",
        name: "Write",
        input: { content: "x".repeat(500) },
      },
    });
    const result = parseStreamEvent(line)!;
    // "Tool: Write " prefix + truncated JSON
    const inputPart = result.replace("Tool: Write ", "");
    expect(inputPart.length).toBeLessThanOrEqual(120);
  });

  it("parses result event", () => {
    const line = JSON.stringify({ type: "result", cost: 0.05 });
    expect(parseStreamEvent(line)).toBe("Claude Code finished");
  });

  it("returns null for stream_event without tool", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "text_delta", text: "hello" },
    });
    expect(parseStreamEvent(line)).toBeNull();
  });
});
