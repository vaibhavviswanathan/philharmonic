import { describe, it, expect } from "vitest";
import {
  CreateProjectSchema,
  UpdateProjectSchema,
  CreateTaskSchema,
  UpdateSettingsSchema,
  SandboxStatusUpdateSchema,
  SandboxLogSchema,
} from "./api.js";

describe("CreateProjectSchema", () => {
  it("accepts valid input", () => {
    const result = CreateProjectSchema.parse({
      name: "My Project",
      repoUrl: "https://github.com/user/repo",
    });
    expect(result.name).toBe("My Project");
    expect(result.repoUrl).toBe("https://github.com/user/repo");
  });

  it("rejects empty name", () => {
    expect(() =>
      CreateProjectSchema.parse({ name: "", repoUrl: "https://github.com/user/repo" }),
    ).toThrow();
  });

  it("rejects name exceeding 200 chars", () => {
    expect(() =>
      CreateProjectSchema.parse({ name: "x".repeat(201), repoUrl: "https://github.com/user/repo" }),
    ).toThrow();
  });

  it("rejects invalid URL", () => {
    expect(() =>
      CreateProjectSchema.parse({ name: "Project", repoUrl: "not-a-url" }),
    ).toThrow();
  });

  it("rejects missing fields", () => {
    expect(() => CreateProjectSchema.parse({})).toThrow();
    expect(() => CreateProjectSchema.parse({ name: "Project" })).toThrow();
  });
});

describe("UpdateProjectSchema", () => {
  it("accepts valid autonomy levels", () => {
    for (const level of ["supervised", "moderate", "high", "full"] as const) {
      const result = UpdateProjectSchema.parse({ autonomyLevel: level });
      expect(result.autonomyLevel).toBe(level);
    }
  });

  it("rejects invalid autonomy level", () => {
    expect(() =>
      UpdateProjectSchema.parse({ autonomyLevel: "yolo" }),
    ).toThrow();
  });

  it("accepts empty object (all fields optional)", () => {
    const result = UpdateProjectSchema.parse({});
    expect(result).toEqual({});
  });

  it("accepts name update without autonomy", () => {
    const result = UpdateProjectSchema.parse({ name: "New Name" });
    expect(result.name).toBe("New Name");
    expect(result.autonomyLevel).toBeUndefined();
  });
});

describe("CreateTaskSchema", () => {
  it("accepts valid input with required fields", () => {
    const result = CreateTaskSchema.parse({
      projectId: "proj-1",
      description: "Fix the login bug",
    });
    expect(result.projectId).toBe("proj-1");
    expect(result.description).toBe("Fix the login bug");
    expect(result.backlog).toBeUndefined();
    expect(result.dependsOn).toBeUndefined();
  });

  it("accepts optional fields", () => {
    const result = CreateTaskSchema.parse({
      projectId: "proj-1",
      description: "Add feature",
      backlog: true,
      dependsOn: ["task-1", "task-2"],
    });
    expect(result.backlog).toBe(true);
    expect(result.dependsOn).toEqual(["task-1", "task-2"]);
  });

  it("accepts empty dependsOn array", () => {
    const result = CreateTaskSchema.parse({
      projectId: "proj-1",
      description: "Some task",
      dependsOn: [],
    });
    expect(result.dependsOn).toEqual([]);
  });

  it("rejects empty description", () => {
    expect(() =>
      CreateTaskSchema.parse({ projectId: "proj-1", description: "" }),
    ).toThrow();
  });

  it("rejects description exceeding 2000 chars", () => {
    expect(() =>
      CreateTaskSchema.parse({ projectId: "proj-1", description: "x".repeat(2001) }),
    ).toThrow();
  });

  it("rejects empty projectId", () => {
    expect(() =>
      CreateTaskSchema.parse({ projectId: "", description: "task" }),
    ).toThrow();
  });
});

describe("UpdateSettingsSchema", () => {
  it("accepts all optional", () => {
    expect(UpdateSettingsSchema.parse({})).toEqual({});
  });

  it("accepts api key and token", () => {
    const result = UpdateSettingsSchema.parse({
      anthropicApiKey: "sk-ant-123",
      githubToken: "ghp_abc",
    });
    expect(result.anthropicApiKey).toBe("sk-ant-123");
    expect(result.githubToken).toBe("ghp_abc");
  });
});

describe("SandboxStatusUpdateSchema", () => {
  it("accepts valid status update", () => {
    const result = SandboxStatusUpdateSchema.parse({
      sandboxId: "sb-1",
      status: "completed",
      prUrl: "https://github.com/user/repo/pull/1",
      prNumber: 1,
    });
    expect(result.status).toBe("completed");
    expect(result.prNumber).toBe(1);
  });

  it("rejects invalid status", () => {
    expect(() =>
      SandboxStatusUpdateSchema.parse({ sandboxId: "sb-1", status: "invalid" }),
    ).toThrow();
  });

  it("accepts all valid statuses", () => {
    const statuses = ["started", "subtask_started", "subtask_completed", "subtask_failed", "completed", "failed"];
    for (const status of statuses) {
      expect(SandboxStatusUpdateSchema.parse({ sandboxId: "sb-1", status }).status).toBe(status);
    }
  });
});

describe("SandboxLogSchema", () => {
  it("defaults level to info", () => {
    const result = SandboxLogSchema.parse({ sandboxId: "sb-1", message: "hello" });
    expect(result.level).toBe("info");
  });

  it("accepts explicit level", () => {
    const result = SandboxLogSchema.parse({ sandboxId: "sb-1", message: "err", level: "error" });
    expect(result.level).toBe("error");
  });
});
