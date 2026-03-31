import { useMemo } from "react";
import type { Task } from "../api.js";

const STATUS_COLORS: Record<string, { fill: string; stroke: string }> = {
  backlog: { fill: "#1F2937", stroke: "#374151" },
  queued: { fill: "#374151", stroke: "#4B5563" },
  planning: { fill: "#1E3A5F", stroke: "#2563EB" },
  planned: { fill: "#312E81", stroke: "#6366F1" },
  blocked: { fill: "#7C2D12", stroke: "#EA580C" },
  running: { fill: "#713F12", stroke: "#CA8A04" },
  reviewing: { fill: "#4A1D6A", stroke: "#A855F7" },
  fixing: { fill: "#4A1D6A", stroke: "#C084FC" },
  success: { fill: "#14532D", stroke: "#16A34A" },
  failed: { fill: "#7F1D1D", stroke: "#DC2626" },
  cancelled: { fill: "#374151", stroke: "#6B7280" },
  closed: { fill: "#374151", stroke: "#6B7280" },
};

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

export function DependencyGraph({
  tasks,
  onTaskClick,
}: {
  tasks: Task[];
  onTaskClick: (taskId: string) => void;
}) {
  const { nodes, edges, width, height } = useMemo(
    () => layoutGraph(tasks),
    [tasks],
  );

  if (tasks.length === 0) {
    return (
      <p className="text-gray-500 text-sm">No tasks to visualize.</p>
    );
  }

  return (
    <div className="bg-gray-900/50 rounded-lg border border-gray-800 p-4 overflow-auto">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="mx-auto"
      >
        <defs>
          <marker
            id="arrowhead"
            markerWidth="8"
            markerHeight="6"
            refX="8"
            refY="3"
            orient="auto"
          >
            <polygon points="0 0, 8 3, 0 6" fill="#6B7280" />
          </marker>
        </defs>

        {/* Edges */}
        {edges.map((edge, i) => {
          const from = nodes.find((n) => n.id === edge.from);
          const to = nodes.find((n) => n.id === edge.to);
          if (!from || !to) return null;

          const NODE_W = 220;
          const NODE_H = 72;

          // Smart edge routing: pick the closest sides
          const fromCx = from.x + NODE_W / 2;
          const fromCy = from.y + NODE_H / 2;
          const toCx = to.x + NODE_W / 2;
          const toCy = to.y + NODE_H / 2;

          const dx = toCx - fromCx;
          const dy = toCy - fromCy;

          let x1: number, y1: number, x2: number, y2: number;
          let path: string;

          if (Math.abs(dy) >= Math.abs(dx)) {
            // Primarily vertical: connect bottom→top
            if (dy >= 0) {
              x1 = fromCx; y1 = from.y + NODE_H;
              x2 = toCx;   y2 = to.y;
            } else {
              x1 = fromCx; y1 = from.y;
              x2 = toCx;   y2 = to.y + NODE_H;
            }
            const midY = (y1 + y2) / 2;
            path = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
          } else {
            // Primarily horizontal: connect right→left
            if (dx >= 0) {
              x1 = from.x + NODE_W; y1 = fromCy;
              x2 = to.x;            y2 = toCy;
            } else {
              x1 = from.x;          y1 = fromCy;
              x2 = to.x + NODE_W;   y2 = toCy;
            }
            const midX = (x1 + x2) / 2;
            path = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
          }

          const isConflict = edge.label === "blocks";
          const color = isConflict ? "#EA580C" : "#6366F1";

          return (
            <g key={i}>
              <path
                d={path}
                fill="none"
                stroke={color}
                strokeWidth="2"
                strokeDasharray={isConflict ? "6 3" : "none"}
                markerEnd="url(#arrowhead)"
                opacity={0.8}
              />
              {edge.label && (
                <text
                  x={(x1 + x2) / 2}
                  y={Math.min(y1, y2) - 6}
                  textAnchor="middle"
                  fill={color}
                  fontSize="10"
                >
                  {edge.label}
                </text>
              )}
            </g>
          );
        })}

        {/* Nodes */}
        {nodes.map((node) => {
          const colors = STATUS_COLORS[node.task.status] ?? STATUS_COLORS.queued;
          const NODE_W = 220;
          const NODE_H = 72;

          return (
            <g
              key={node.id}
              onClick={() => onTaskClick(node.id)}
              className="cursor-pointer"
            >
              <rect
                x={node.x}
                y={node.y}
                width={NODE_W}
                height={NODE_H}
                rx={8}
                fill={colors.fill}
                stroke={colors.stroke}
                strokeWidth={2}
              />
              {/* Status pill */}
              <rect
                x={node.x + 8}
                y={node.y + 8}
                width={
                  node.task.status.length * 6.5 + 12
                }
                height={16}
                rx={4}
                fill={colors.stroke}
                opacity={0.3}
              />
              <text
                x={node.x + 14}
                y={node.y + 20}
                fill={colors.stroke}
                fontSize="10"
                fontWeight="600"
              >
                {node.task.status}
              </text>
              {/* Description */}
              <foreignObject
                x={node.x + 8}
                y={node.y + 30}
                width={NODE_W - 16}
                height={34}
              >
                <div
                  style={{
                    color: "#D1D5DB",
                    fontSize: "11px",
                    lineHeight: "1.3",
                    overflow: "hidden",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {node.task.description}
                </div>
              </foreignObject>
            </g>
          );
        })}

        {/* Conflict edges are now rendered in the unified edges loop above */}
      </svg>

      <div className="flex items-center gap-4 mt-3 justify-center">
        <Legend color="#6366F1" label="Dependency" dashed={false} />
        <Legend color="#EA580C" label="Conflict" dashed={true} />
        {Object.entries(STATUS_COLORS).map(([status, colors]) => (
          <div key={status} className="flex items-center gap-1">
            <div
              className="w-3 h-3 rounded-sm"
              style={{ background: colors.fill, border: `1px solid ${colors.stroke}` }}
            />
            <span className="text-[10px] text-gray-400">{status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Legend({
  color,
  label,
  dashed,
}: {
  color: string;
  label: string;
  dashed: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      <svg width="20" height="10">
        <line
          x1="0"
          y1="5"
          x2="20"
          y2="5"
          stroke={color}
          strokeWidth="2"
          strokeDasharray={dashed ? "4 2" : "none"}
        />
      </svg>
      <span className="text-[10px] text-gray-400">{label}</span>
    </div>
  );
}

/**
 * Dependency-aware layered graph layout.
 * Uses topological depth for row placement (dependencies flow top→bottom).
 * Tasks at the same depth are spread horizontally.
 */
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

  // Build edges
  const edges: Edge[] = [];
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  // Explicit dependency edges
  for (const task of tasks) {
    if (task.dependsOn) {
      for (const depId of task.dependsOn) {
        if (taskMap.has(depId)) {
          edges.push({ from: depId, to: task.id, label: "depends" });
        }
      }
    }
  }

  // blockedBy edges (touch-set conflicts)
  for (const task of tasks) {
    if (task.blockedBy && taskMap.has(task.blockedBy)) {
      edges.push({ from: task.blockedBy, to: task.id, label: "blocks" });
    }
  }

  // Compute topological depth — tasks with no deps/blockers are row 0
  const depth = new Map<string, number>();
  function getDepth(id: string, visited: Set<string>): number {
    if (depth.has(id)) return depth.get(id)!;
    if (visited.has(id)) return 0; // cycle guard
    visited.add(id);

    const task = taskMap.get(id);
    if (!task) return 0;

    let maxParent = -1;
    // dependsOn parents
    for (const depId of task.dependsOn ?? []) {
      if (taskMap.has(depId)) {
        maxParent = Math.max(maxParent, getDepth(depId, visited));
      }
    }
    // blockedBy parent
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

  // Group tasks by depth row
  const rows = new Map<number, Task[]>();
  for (const task of tasks) {
    const d = depth.get(task.id) ?? 0;
    const list = rows.get(d) ?? [];
    list.push(task);
    rows.set(d, list);
  }

  // Sort rows, position nodes
  const sortedRows = [...rows.entries()].sort(([a], [b]) => a - b);
  const nodes: Node[] = [];
  let maxCol = 0;

  for (const [, list] of sortedRows) {
    // Sort within row by status, then creation time for stability
    const statusOrder: Record<string, number> = {
      backlog: 0, queued: 1, planning: 2, planned: 3, blocked: 4,
      running: 5, reviewing: 6, fixing: 7, success: 8, failed: 9,
      cancelled: 10, closed: 11,
    };
    list.sort((a, b) => (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0));
  }

  for (let row = 0; row < sortedRows.length; row++) {
    const [, list] = sortedRows[row];
    // Center the row
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

  // Compute bounding box
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
