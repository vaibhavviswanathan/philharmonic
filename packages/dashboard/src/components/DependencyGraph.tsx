import { useMemo } from "react";
import type { Task } from "../api.js";

const STATUS_COLORS: Record<string, { fill: string; stroke: string }> = {
  queued: { fill: "#374151", stroke: "#4B5563" },
  planning: { fill: "#1E3A5F", stroke: "#2563EB" },
  planned: { fill: "#312E81", stroke: "#6366F1" },
  blocked: { fill: "#7C2D12", stroke: "#EA580C" },
  running: { fill: "#713F12", stroke: "#CA8A04" },
  success: { fill: "#14532D", stroke: "#16A34A" },
  failed: { fill: "#7F1D1D", stroke: "#DC2626" },
  cancelled: { fill: "#374151", stroke: "#6B7280" },
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
          // Draw from bottom of "from" to top of "to"
          const x1 = from.x + NODE_W / 2;
          const y1 = from.y + NODE_H;
          const x2 = to.x + NODE_W / 2;
          const y2 = to.y;
          const midY = (y1 + y2) / 2;

          return (
            <g key={i}>
              <path
                d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                fill="none"
                stroke="#4B5563"
                strokeWidth="2"
                strokeDasharray={edge.from === "conflict" ? "4 4" : "none"}
                markerEnd="url(#arrowhead)"
              />
              {edge.label && (
                <text
                  x={(x1 + x2) / 2}
                  y={midY - 4}
                  textAnchor="middle"
                  fill="#9CA3AF"
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

        {/* Touch-set conflict edges (orange dashed) */}
        {tasks
          .filter((t) => t.blockedBy)
          .map((t) => {
            const blocked = nodes.find((n) => n.id === t.id);
            const blocker = nodes.find((n) => n.id === t.blockedBy);
            if (!blocked || !blocker) return null;

            const NODE_W = 220;
            const NODE_H = 72;
            const x1 = blocker.x + NODE_W;
            const y1 = blocker.y + NODE_H / 2;
            const x2 = blocked.x;
            const y2 = blocked.y + NODE_H / 2;
            const midX = (x1 + x2) / 2;

            return (
              <g key={`conflict-${t.id}`}>
                <path
                  d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke="#EA580C"
                  strokeWidth="2"
                  strokeDasharray="6 3"
                  markerEnd="url(#arrowhead)"
                  opacity={0.7}
                />
                <text
                  x={midX}
                  y={Math.min(y1, y2) - 6}
                  textAnchor="middle"
                  fill="#EA580C"
                  fontSize="10"
                  fontWeight="500"
                >
                  conflict
                </text>
              </g>
            );
          })}
      </svg>

      <div className="flex items-center gap-4 mt-3 justify-center">
        <Legend color="#4B5563" label="Dependency" dashed={false} />
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
 * Simple layered graph layout.
 * Groups tasks by status into layers, positions them vertically.
 * Tasks with blockedBy relationships get edges.
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
  const GAP_Y = 40;
  const PADDING = 30;

  // Assign layers based on status progression
  const statusOrder = [
    "queued",
    "planning",
    "planned",
    "blocked",
    "running",
    "success",
    "failed",
    "cancelled",
  ];

  // Group tasks by their status layer
  const layers = new Map<number, Task[]>();
  for (const task of tasks) {
    const layer = statusOrder.indexOf(task.status);
    const idx = layer >= 0 ? layer : 0;
    const list = layers.get(idx) ?? [];
    list.push(task);
    layers.set(idx, list);
  }

  // Build subtask dependency edges within a task
  const edges: Edge[] = [];

  // Build blockedBy edges
  for (const task of tasks) {
    if (task.blockedBy && tasks.find((t) => t.id === task.blockedBy)) {
      edges.push({ from: task.blockedBy, to: task.id, label: "blocks" });
    }
  }

  // Position nodes: arrange by creation time within each column
  // Use a simple grid: one column per unique status that has tasks
  const activeLayers = [...layers.entries()]
    .filter(([, list]) => list.length > 0)
    .sort(([a], [b]) => a - b);

  const nodes: Node[] = [];
  let maxCol = 0;
  let maxRow = 0;

  for (let col = 0; col < activeLayers.length; col++) {
    const [, list] = activeLayers[col];
    for (let row = 0; row < list.length; row++) {
      nodes.push({
        id: list[row].id,
        task: list[row],
        x: PADDING + col * (NODE_W + GAP_X),
        y: PADDING + row * (NODE_H + GAP_Y),
      });
      maxRow = Math.max(maxRow, row);
    }
    maxCol = col;
  }

  const width = PADDING * 2 + (maxCol + 1) * (NODE_W + GAP_X);
  const height = PADDING * 2 + (maxRow + 1) * (NODE_H + GAP_Y);

  return { nodes, edges, width: Math.max(width, 300), height: Math.max(height, 200) };
}
