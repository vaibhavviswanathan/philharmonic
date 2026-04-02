import { describe, it, expect } from "vitest";
import { buildPrompt, buildSystemAppend, parseStreamEvent, buildClaudeMd } from "./agent.js";

describe("buildPrompt", () => {
  const payload = {
    taskId: "t1",
    branchName: "phil/add-auth",
    repoContext: { repoUrl: "https://github.com/user/repo", projectType: "node", defaultBranch: "main", structure: [] },
    subtasks: [
      { id: "s1", description: "Create auth middleware", fileTargets: ["src/auth.ts"], status: "pending" as const, dependencies: [] },
      { id: "s2", description: "Add login route", fileTargets: ["src/routes.ts", "src/auth.ts"], status: "pending" as const, dependencies: [] },
    ],
    touchSet: [],
    callbackUrl: "",
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
    const p = { ...payload, subtasks: [{ id: "s1", description: "Explore", fileTargets: [], status: "pending" as const, dependencies: [] }] };
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

describe("buildClaudeMd", () => {
  const payload = {
    taskId: "t1",
    branchName: "phil/add-auth",
    repoContext: { repoUrl: "https://github.com/user/repo", projectType: "node", defaultBranch: "main", structure: [] },
    subtasks: [
      { id: "s1", description: "Create auth middleware", fileTargets: ["src/auth.ts"], status: "pending" as const, dependencies: [] },
    ],
    touchSet: [],
    callbackUrl: "",
  };

  it("includes task instructions header", () => {
    expect(buildClaudeMd(payload)).toContain("# Phil Task Instructions");
  });

  it("includes branch name", () => {
    expect(buildClaudeMd(payload)).toContain("phil/add-auth");
  });

  it("includes subtask listing", () => {
    expect(buildClaudeMd(payload)).toContain("[s1] Create auth middleware");
  });

  it("includes port 8080 rule", () => {
    expect(buildClaudeMd(payload)).toContain("port 8080");
  });

  it("includes PR creation rule", () => {
    expect(buildClaudeMd(payload)).toContain("gh pr create");
  });

  it("prepends existing CLAUDE.md content", () => {
    const existing = "# Project Setup\nUse pnpm for package management.";
    const result = buildClaudeMd(payload, existing);
    expect(result).toContain("# Project Setup");
    expect(result).toContain("# Phil Task Instructions");
    // Existing content should come first
    expect(result.indexOf("# Project Setup")).toBeLessThan(result.indexOf("# Phil Task Instructions"));
  });

  it("works without existing CLAUDE.md", () => {
    const result = buildClaudeMd(payload);
    expect(result).toContain("# Phil Task Instructions");
  });

  it("works with empty existing CLAUDE.md", () => {
    const result = buildClaudeMd(payload, "");
    expect(result).toContain("# Phil Task Instructions");
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
