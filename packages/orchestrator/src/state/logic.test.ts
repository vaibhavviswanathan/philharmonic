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
