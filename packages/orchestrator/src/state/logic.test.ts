import { describe, it, expect } from "vitest";
import type { AutonomyLevel } from "@phil/shared";

/**
 * Extract and test the pure auto-approve logic from task-do.ts.
 * This mirrors the exact logic in planSingleTask.
 */
function shouldAutoApprove(autonomy: AutonomyLevel, fileCount: number): boolean {
  return (
    autonomy === "full" ||
    (autonomy === "high" && fileCount <= 10) ||
    (autonomy === "moderate" && fileCount <= 3)
  );
}

/**
 * Extract and test the DAG dependency check logic from alarm().
 * Returns true if all dependencies are met (all "success").
 */
function areDependenciesMet(
  dependsOn: string[],
  getTaskStatus: (id: string) => string | null,
): boolean {
  return dependsOn.every((depId) => {
    const status = getTaskStatus(depId);
    return status === "success";
  });
}

describe("shouldAutoApprove", () => {
  describe("supervised (default)", () => {
    it("never auto-approves", () => {
      expect(shouldAutoApprove("supervised", 0)).toBe(false);
      expect(shouldAutoApprove("supervised", 1)).toBe(false);
      expect(shouldAutoApprove("supervised", 100)).toBe(false);
    });
  });

  describe("moderate", () => {
    it("auto-approves when fileCount <= 3", () => {
      expect(shouldAutoApprove("moderate", 0)).toBe(true);
      expect(shouldAutoApprove("moderate", 1)).toBe(true);
      expect(shouldAutoApprove("moderate", 3)).toBe(true);
    });

    it("does not auto-approve when fileCount > 3", () => {
      expect(shouldAutoApprove("moderate", 4)).toBe(false);
      expect(shouldAutoApprove("moderate", 10)).toBe(false);
    });
  });

  describe("high", () => {
    it("auto-approves when fileCount <= 10", () => {
      expect(shouldAutoApprove("high", 0)).toBe(true);
      expect(shouldAutoApprove("high", 5)).toBe(true);
      expect(shouldAutoApprove("high", 10)).toBe(true);
    });

    it("does not auto-approve when fileCount > 10", () => {
      expect(shouldAutoApprove("high", 11)).toBe(false);
      expect(shouldAutoApprove("high", 50)).toBe(false);
    });
  });

  describe("full", () => {
    it("always auto-approves regardless of file count", () => {
      expect(shouldAutoApprove("full", 0)).toBe(true);
      expect(shouldAutoApprove("full", 1)).toBe(true);
      expect(shouldAutoApprove("full", 100)).toBe(true);
      expect(shouldAutoApprove("full", 1000)).toBe(true);
    });
  });
});

describe("areDependenciesMet", () => {
  it("returns true for empty dependencies", () => {
    expect(areDependenciesMet([], () => null)).toBe(true);
  });

  it("returns true when all deps are success", () => {
    const statuses: Record<string, string> = { "t1": "success", "t2": "success" };
    expect(areDependenciesMet(["t1", "t2"], (id) => statuses[id] ?? null)).toBe(true);
  });

  it("returns false when any dep is not success", () => {
    const statuses: Record<string, string> = { "t1": "success", "t2": "running" };
    expect(areDependenciesMet(["t1", "t2"], (id) => statuses[id] ?? null)).toBe(false);
  });

  it("returns false when dep is failed", () => {
    const statuses: Record<string, string> = { "t1": "failed" };
    expect(areDependenciesMet(["t1"], (id) => statuses[id] ?? null)).toBe(false);
  });

  it("returns false when dep task does not exist", () => {
    expect(areDependenciesMet(["nonexistent"], () => null)).toBe(false);
  });

  it("returns false when dep is planned (not yet started)", () => {
    expect(areDependenciesMet(["t1"], () => "planned")).toBe(false);
  });

  it("returns false for cancelled deps", () => {
    expect(areDependenciesMet(["t1"], () => "cancelled")).toBe(false);
  });

  it("handles single dependency", () => {
    expect(areDependenciesMet(["t1"], () => "success")).toBe(true);
    expect(areDependenciesMet(["t1"], () => "running")).toBe(false);
  });

  it("handles mixed statuses correctly", () => {
    const statuses: Record<string, string> = {
      "t1": "success",
      "t2": "success",
      "t3": "blocked",
    };
    expect(areDependenciesMet(["t1", "t2", "t3"], (id) => statuses[id] ?? null)).toBe(false);
    expect(areDependenciesMet(["t1", "t2"], (id) => statuses[id] ?? null)).toBe(true);
  });
});

/**
 * Extract and test the touch-set overlap inference logic from planSingleTask.
 */
interface TaskRow {
  id: string;
  touchSet: string[];
  status: string;
  createdAt: string;
}

function inferDependencies(
  taskId: string,
  touchSet: string[],
  createdAt: string,
  otherTasks: TaskRow[],
): string[] {
  if (touchSet.length === 0) return [];

  const terminalStatuses = ["success", "failed", "cancelled", "closed"];
  const touchSetLookup = new Set(touchSet);
  const deps: string[] = [];

  for (const other of otherTasks) {
    if (other.id === taskId) continue;
    if (terminalStatuses.includes(other.status)) continue;
    if (other.touchSet.length === 0) continue;

    const hasOverlap = other.touchSet.some((f) => touchSetLookup.has(f));
    if (!hasOverlap) continue;

    // Only depend on tasks created before this one
    if (other.createdAt < createdAt) {
      deps.push(other.id);
    }
  }

  return deps;
}

describe("inferDependencies", () => {
  it("returns empty for no touch set", () => {
    expect(inferDependencies("t2", [], "2026-01-02", [
      { id: "t1", touchSet: ["src/a.ts"], status: "planned", createdAt: "2026-01-01" },
    ])).toEqual([]);
  });

  it("returns empty when no other tasks exist", () => {
    expect(inferDependencies("t1", ["src/a.ts"], "2026-01-01", [])).toEqual([]);
  });

  it("detects overlapping touch sets", () => {
    const result = inferDependencies("t2", ["src/a.ts", "src/b.ts"], "2026-01-02", [
      { id: "t1", touchSet: ["src/a.ts", "src/c.ts"], status: "planned", createdAt: "2026-01-01" },
    ]);
    expect(result).toEqual(["t1"]);
  });

  it("ignores tasks with no overlap", () => {
    const result = inferDependencies("t2", ["src/a.ts"], "2026-01-02", [
      { id: "t1", touchSet: ["src/b.ts", "src/c.ts"], status: "planned", createdAt: "2026-01-01" },
    ]);
    expect(result).toEqual([]);
  });

  it("ignores terminal tasks (success, failed, cancelled, closed)", () => {
    const otherTasks: TaskRow[] = [
      { id: "t1", touchSet: ["src/a.ts"], status: "success", createdAt: "2026-01-01" },
      { id: "t2", touchSet: ["src/a.ts"], status: "failed", createdAt: "2026-01-01" },
      { id: "t3", touchSet: ["src/a.ts"], status: "cancelled", createdAt: "2026-01-01" },
      { id: "t4", touchSet: ["src/a.ts"], status: "closed", createdAt: "2026-01-01" },
    ];
    const result = inferDependencies("t5", ["src/a.ts"], "2026-01-02", otherTasks);
    expect(result).toEqual([]);
  });

  it("only depends on tasks created BEFORE this one (no circular deps)", () => {
    const result = inferDependencies("t1", ["src/a.ts"], "2026-01-01", [
      { id: "t2", touchSet: ["src/a.ts"], status: "planned", createdAt: "2026-01-02" },
    ]);
    expect(result).toEqual([]);
  });

  it("handles multiple overlapping tasks", () => {
    const result = inferDependencies("t3", ["src/a.ts", "src/b.ts"], "2026-01-03", [
      { id: "t1", touchSet: ["src/a.ts"], status: "running", createdAt: "2026-01-01" },
      { id: "t2", touchSet: ["src/b.ts"], status: "planned", createdAt: "2026-01-02" },
    ]);
    expect(result).toEqual(["t1", "t2"]);
  });

  it("includes running and reviewing tasks as dependencies", () => {
    const otherTasks: TaskRow[] = [
      { id: "t1", touchSet: ["src/a.ts"], status: "running", createdAt: "2026-01-01" },
      { id: "t2", touchSet: ["src/a.ts"], status: "reviewing", createdAt: "2026-01-01" },
      { id: "t3", touchSet: ["src/a.ts"], status: "blocked", createdAt: "2026-01-01" },
    ];
    const result = inferDependencies("t4", ["src/a.ts"], "2026-01-02", otherTasks);
    expect(result).toEqual(["t1", "t2", "t3"]);
  });

  it("skips self", () => {
    const result = inferDependencies("t1", ["src/a.ts"], "2026-01-01", [
      { id: "t1", touchSet: ["src/a.ts"], status: "planned", createdAt: "2026-01-01" },
    ]);
    expect(result).toEqual([]);
  });

  it("skips tasks with empty touch sets", () => {
    const result = inferDependencies("t2", ["src/a.ts"], "2026-01-02", [
      { id: "t1", touchSet: [], status: "planned", createdAt: "2026-01-01" },
    ]);
    expect(result).toEqual([]);
  });
});
