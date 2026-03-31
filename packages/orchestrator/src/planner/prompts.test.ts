import { describe, it, expect } from "vitest";
import {
  PLANNER_SYSTEM_PROMPT,
  buildPlannerUserPrompt,
  buildPlannerRevisionPrompt,
} from "./prompts.js";

describe("PLANNER_SYSTEM_PROMPT", () => {
  it("contains required JSON schema fields", () => {
    expect(PLANNER_SYSTEM_PROMPT).toContain("planMarkdown");
    expect(PLANNER_SYSTEM_PROMPT).toContain("subtasks");
    expect(PLANNER_SYSTEM_PROMPT).toContain("touchSet");
    expect(PLANNER_SYSTEM_PROMPT).toContain("branchName");
  });

  it("warns about port 3000 being reserved", () => {
    expect(PLANNER_SYSTEM_PROMPT).toContain("Port 3000 is RESERVED");
    expect(PLANNER_SYSTEM_PROMPT).toContain("port 8080");
  });
});

describe("buildPlannerUserPrompt", () => {
  const baseArgs = {
    taskDescription: "Add JWT authentication",
    repoUrl: "https://github.com/user/repo",
    repoStructure: ["src/", "src/index.ts", "package.json"],
    projectType: "node-typescript",
  } as const;

  it("includes task description", () => {
    const prompt = buildPlannerUserPrompt(
      baseArgs.taskDescription,
      baseArgs.repoUrl,
      [...baseArgs.repoStructure],
      baseArgs.projectType,
    );
    expect(prompt).toContain("Add JWT authentication");
  });

  it("includes repo URL and project type", () => {
    const prompt = buildPlannerUserPrompt(
      baseArgs.taskDescription,
      baseArgs.repoUrl,
      [...baseArgs.repoStructure],
      baseArgs.projectType,
    );
    expect(prompt).toContain("https://github.com/user/repo");
    expect(prompt).toContain("node-typescript");
  });

  it("includes repo structure", () => {
    const prompt = buildPlannerUserPrompt(
      baseArgs.taskDescription,
      baseArgs.repoUrl,
      [...baseArgs.repoStructure],
      baseArgs.projectType,
    );
    expect(prompt).toContain("src/index.ts");
    expect(prompt).toContain("package.json");
  });

  it("includes CLAUDE.md when provided", () => {
    const prompt = buildPlannerUserPrompt(
      baseArgs.taskDescription,
      baseArgs.repoUrl,
      [...baseArgs.repoStructure],
      baseArgs.projectType,
      "Always use ESLint",
    );
    expect(prompt).toContain("CLAUDE.md");
    expect(prompt).toContain("Always use ESLint");
  });

  it("omits CLAUDE.md section when not provided", () => {
    const prompt = buildPlannerUserPrompt(
      baseArgs.taskDescription,
      baseArgs.repoUrl,
      [...baseArgs.repoStructure],
      baseArgs.projectType,
    );
    expect(prompt).not.toContain("CLAUDE.md");
  });

  it("ends with JSON instruction", () => {
    const prompt = buildPlannerUserPrompt(
      baseArgs.taskDescription,
      baseArgs.repoUrl,
      [...baseArgs.repoStructure],
      baseArgs.projectType,
    );
    expect(prompt).toContain("Return ONLY the JSON");
  });
});

describe("buildPlannerRevisionPrompt", () => {
  it("includes previous plan and feedback", () => {
    const prompt = buildPlannerRevisionPrompt(
      "Add auth",
      "https://github.com/user/repo",
      ["src/"],
      "node",
      '{"subtasks": []}',
      "Please also add rate limiting",
    );
    expect(prompt).toContain("Previous plan");
    expect(prompt).toContain('{"subtasks": []}');
    expect(prompt).toContain("Developer feedback");
    expect(prompt).toContain("Please also add rate limiting");
  });

  it("includes CLAUDE.md in revision when provided", () => {
    const prompt = buildPlannerRevisionPrompt(
      "Add auth",
      "https://github.com/user/repo",
      ["src/"],
      "node",
      "{}",
      "feedback",
      "Use pnpm",
    );
    expect(prompt).toContain("CLAUDE.md");
    expect(prompt).toContain("Use pnpm");
  });
});
