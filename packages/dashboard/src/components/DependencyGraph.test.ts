import { describe, it, expect } from "vitest";
import type { Task } from "../api.js";

// --- Extracted logic from DependencyGraph.tsx for unit testing ---

interface Node {
  id: string;
  task: Task;
  x: number;
  y: number;
}

interface Edge {
  from: string;
  to: string;
  label?: string;
}

function layoutGraph(tasks: Task[]): {
  nodes: Node[];
  edges: Edge[];
  width: number;
  height: number;
} {
  const NODE_W = 220;
  const NODE_H = 72;
  const GAP_X = 40;
  const GAP_Y = 50;
  const PADDING = 30;

  const edges: Edge[] = [];
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  for (const task of tasks) {
    if (task.dependsOn) {
      for (const depId of task.dependsOn) {
        if (taskMap.has(depId)) {
          edges.push({ from: depId, to: task.id, label: "depends" });
        }
      }
    }
  }

  for (const task of tasks) {
    if (task.blockedBy && taskMap.has(task.blockedBy)) {
      edges.push({ from: task.blockedBy, to: task.id, label: "blocks" });
    }
  }

  const depth = new Map<string, number>();
  function getDepth(id: string, visited: Set<string>): number {
    if (depth.has(id)) return depth.get(id)!;
    if (visited.has(id)) return 0;
    visited.add(id);

    const task = taskMap.get(id);
    if (!task) return 0;

    let maxParent = -1;
    for (const depId of task.dependsOn ?? []) {
      if (taskMap.has(depId)) {
        maxParent = Math.max(maxParent, getDepth(depId, visited));
      }
    }
    if (task.blockedBy && taskMap.has(task.blockedBy)) {
      maxParent = Math.max(maxParent, getDepth(task.blockedBy, visited));
    }

    const d = maxParent + 1;
    depth.set(id, d);
    return d;
  }

  for (const task of tasks) {
    getDepth(task.id, new Set());
  }

  const rows = new Map<number, Task[]>();
  for (const task of tasks) {
    const d = depth.get(task.id) ?? 0;
    const list = rows.get(d) ?? [];
    list.push(task);
    rows.set(d, list);
  }

  const sortedRows = [...rows.entries()].sort(([a], [b]) => a - b);
  const nodes: Node[] = [];
  let maxCol = 0;

  const statusOrder: Record<string, number> = {
    backlog: 0, queued: 1, planning: 2, planned: 3, blocked: 4,
    running: 5, reviewing: 6, fixing: 7, success: 8, failed: 9,
    cancelled: 10, closed: 11,
  };

  for (const [, list] of sortedRows) {
    list.sort((a, b) => (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0));
  }

  for (let row = 0; row < sortedRows.length; row++) {
    const [, list] = sortedRows[row];
    const rowWidth = list.length * (NODE_W + GAP_X) - GAP_X;
    const totalWidth = Math.max(tasks.length, list.length) * (NODE_W + GAP_X);
    const offsetX = (totalWidth - rowWidth) / 2;

    for (let col = 0; col < list.length; col++) {
      nodes.push({
        id: list[col].id,
        task: list[col],
        x: PADDING + offsetX + col * (NODE_W + GAP_X),
        y: PADDING + row * (NODE_H + GAP_Y),
      });
      maxCol = Math.max(maxCol, col);
    }
  }

  let maxX = 0;
  let maxY = 0;
  for (const n of nodes) {
    maxX = Math.max(maxX, n.x + NODE_W);
    maxY = Math.max(maxY, n.y + NODE_H);
  }

  return {
    nodes,
    edges,
    width: Math.max(maxX + PADDING, 300),
    height: Math.max(maxY + PADDING, 200),
  };
}

// --- Helpers ---

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    projectId: "proj-1",
    repoUrl: "https://github.com/user/repo",
    description: `Task ${overrides.id}`,
    status: "planned",
    branchName: `phil/${overrides.id}`,
    subtasks: [],
    touchSet: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function nodeById(nodes: Node[], id: string): Node {
  const n = nodes.find((n) => n.id === id);
  if (!n) throw new Error(`Node ${id} not found`);
  return n;
}

// --- Tests ---

describe("layoutGraph", () => {
  describe("empty and single task", () => {
    it("returns empty layout for no tasks", () => {
      const result = layoutGraph([]);
      expect(result.nodes).toEqual([]);
      expect(result.edges).toEqual([]);
      expect(result.width).toBeGreaterThanOrEqual(300);
      expect(result.height).toBeGreaterThanOrEqual(200);
    });

    it("places a single task", () => {
      const result = layoutGraph([makeTask({ id: "t1" })]);
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].id).toBe("t1");
      expect(result.edges).toEqual([]);
    });
  });

  describe("edge generation", () => {
    it("creates dependency edges from dependsOn", () => {
      const tasks = [
        makeTask({ id: "t1" }),
        makeTask({ id: "t2", dependsOn: ["t1"] }),
      ];
      const result = layoutGraph(tasks);
      expect(result.edges).toEqual([
        { from: "t1", to: "t2", label: "depends" },
      ]);
    });

    it("creates conflict edges from blockedBy", () => {
      const tasks = [
        makeTask({ id: "t1", status: "running" }),
        makeTask({ id: "t2", status: "blocked", blockedBy: "t1" }),
      ];
      const result = layoutGraph(tasks);
      expect(result.edges).toEqual([
        { from: "t1", to: "t2", label: "blocks" },
      ]);
    });

    it("ignores dependsOn referencing tasks not in the list", () => {
      const tasks = [
        makeTask({ id: "t2", dependsOn: ["t-missing"] }),
      ];
      const result = layoutGraph(tasks);
      expect(result.edges).toEqual([]);
    });

    it("ignores blockedBy referencing tasks not in the list", () => {
      const tasks = [
        makeTask({ id: "t2", blockedBy: "t-missing" }),
      ];
      const result = layoutGraph(tasks);
      expect(result.edges).toEqual([]);
    });

    it("creates multiple dependency edges", () => {
      const tasks = [
        makeTask({ id: "t1" }),
        makeTask({ id: "t2" }),
        makeTask({ id: "t3", dependsOn: ["t1", "t2"] }),
      ];
      const result = layoutGraph(tasks);
      expect(result.edges).toHaveLength(2);
      expect(result.edges).toContainEqual({ from: "t1", to: "t3", label: "depends" });
      expect(result.edges).toContainEqual({ from: "t2", to: "t3", label: "depends" });
    });
  });

  describe("topological depth (row placement)", () => {
    it("places independent tasks at the same depth (same y)", () => {
      const tasks = [
        makeTask({ id: "t1" }),
        makeTask({ id: "t2" }),
        makeTask({ id: "t3" }),
      ];
      const result = layoutGraph(tasks);
      const ys = result.nodes.map((n) => n.y);
      // All should be at the same y since no dependencies
      expect(new Set(ys).size).toBe(1);
    });

    it("places dependent task below its dependency", () => {
      const tasks = [
        makeTask({ id: "t1" }),
        makeTask({ id: "t2", dependsOn: ["t1"] }),
      ];
      const result = layoutGraph(tasks);
      const n1 = nodeById(result.nodes, "t1");
      const n2 = nodeById(result.nodes, "t2");
      expect(n2.y).toBeGreaterThan(n1.y);
    });

    it("handles chain: A → B → C places at increasing depths", () => {
      const tasks = [
        makeTask({ id: "A" }),
        makeTask({ id: "B", dependsOn: ["A"] }),
        makeTask({ id: "C", dependsOn: ["B"] }),
      ];
      const result = layoutGraph(tasks);
      const nA = nodeById(result.nodes, "A");
      const nB = nodeById(result.nodes, "B");
      const nC = nodeById(result.nodes, "C");
      expect(nB.y).toBeGreaterThan(nA.y);
      expect(nC.y).toBeGreaterThan(nB.y);
    });

    it("handles diamond: A → B, A → C, B+C → D", () => {
      const tasks = [
        makeTask({ id: "A" }),
        makeTask({ id: "B", dependsOn: ["A"] }),
        makeTask({ id: "C", dependsOn: ["A"] }),
        makeTask({ id: "D", dependsOn: ["B", "C"] }),
      ];
      const result = layoutGraph(tasks);
      const nA = nodeById(result.nodes, "A");
      const nB = nodeById(result.nodes, "B");
      const nC = nodeById(result.nodes, "C");
      const nD = nodeById(result.nodes, "D");

      // A at row 0
      // B and C at row 1 (same depth)
      expect(nB.y).toBe(nC.y);
      expect(nB.y).toBeGreaterThan(nA.y);
      // D at row 2
      expect(nD.y).toBeGreaterThan(nB.y);
    });

    it("blockedBy also affects depth", () => {
      const tasks = [
        makeTask({ id: "t1", status: "running" }),
        makeTask({ id: "t2", status: "blocked", blockedBy: "t1" }),
      ];
      const result = layoutGraph(tasks);
      const n1 = nodeById(result.nodes, "t1");
      const n2 = nodeById(result.nodes, "t2");
      expect(n2.y).toBeGreaterThan(n1.y);
    });
  });

  describe("cycle handling", () => {
    it("handles circular dependencies without infinite loop", () => {
      const tasks = [
        makeTask({ id: "t1", dependsOn: ["t2"] }),
        makeTask({ id: "t2", dependsOn: ["t1"] }),
      ];
      // Should not throw or hang
      const result = layoutGraph(tasks);
      expect(result.nodes).toHaveLength(2);
    });
  });

  describe("status sorting within rows", () => {
    it("sorts tasks within a row by status order", () => {
      const tasks = [
        makeTask({ id: "t1", status: "success" }),
        makeTask({ id: "t2", status: "queued" }),
        makeTask({ id: "t3", status: "running" }),
      ];
      const result = layoutGraph(tasks);
      // All at same depth (no deps), sorted: queued < running < success
      const ids = result.nodes.map((n) => n.id);
      expect(ids).toEqual(["t2", "t3", "t1"]);
    });
  });

  describe("dimensions", () => {
    it("minimum dimensions are 300x200", () => {
      const result = layoutGraph([]);
      expect(result.width).toBeGreaterThanOrEqual(300);
      expect(result.height).toBeGreaterThanOrEqual(200);
    });

    it("grows with more tasks", () => {
      const small = layoutGraph([makeTask({ id: "t1" })]);
      const large = layoutGraph([
        makeTask({ id: "t1" }),
        makeTask({ id: "t2", dependsOn: ["t1"] }),
        makeTask({ id: "t3", dependsOn: ["t2"] }),
      ]);
      expect(large.height).toBeGreaterThan(small.height);
    });
  });
});
