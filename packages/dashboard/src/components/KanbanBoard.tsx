import { resolvePreviewUrl, type Task } from "../api.js";
import { StatusBadge } from "./StatusBadge.js";

const COLUMNS: { status: string; label: string; color: string }[] = [
  { status: "backlog", label: "Backlog", color: "border-gray-500" },
  { status: "queued", label: "Queued", color: "border-gray-600" },
  { status: "planning", label: "Planning", color: "border-blue-600" },
  { status: "planned", label: "Planned", color: "border-indigo-600" },
  { status: "blocked", label: "Blocked", color: "border-orange-600" },
  { status: "running", label: "Running", color: "border-yellow-600" },
  { status: "reviewing", label: "Reviewing", color: "border-purple-600" },
  { status: "fixing", label: "Fixing", color: "border-purple-500" },
  { status: "success", label: "Done", color: "border-green-600" },
  { status: "failed", label: "Failed", color: "border-red-600" },
  { status: "cancelled", label: "Cancelled", color: "border-gray-500" },
  { status: "closed", label: "Closed", color: "border-gray-400" },
];

export function KanbanBoard({
  tasks,
  onTaskClick,
}: {
  tasks: Task[];
  onTaskClick: (taskId: string) => void;
}) {
  const grouped = new Map<string, Task[]>();
  for (const col of COLUMNS) grouped.set(col.status, []);
  for (const task of tasks) {
    const list = grouped.get(task.status);
    if (list) list.push(task);
    else grouped.set(task.status, [task]);
  }

  // Only show columns that have tasks or are "active" statuses
  const activeColumns = COLUMNS.filter(
    (col) =>
      (grouped.get(col.status)?.length ?? 0) > 0 ||
      ["queued", "running", "success", "failed"].includes(col.status),
  );

  return (
    <div className="flex gap-3 overflow-x-auto pb-3">
      {activeColumns.map((col) => (
        <div
          key={col.status}
          className={`flex-shrink-0 w-64 bg-[#252525] rounded-lg border-t-2 border border-[#3d3d3d] ${col.color}`}
        >
          <div className="px-3 py-2.5 border-b border-[#3d3d3d]">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[#999]">
                {col.label}
              </span>
              <span className="text-[10px] text-[#555] bg-[#2d2d2d] px-1.5 py-0.5 rounded font-medium">
                {grouped.get(col.status)?.length ?? 0}
              </span>
            </div>
          </div>
          <div className="p-2 space-y-2 min-h-[120px]">
            {(grouped.get(col.status) ?? []).map((task) => (
              <KanbanCard
                key={task.id}
                task={task}
                onClick={() => onTaskClick(task.id)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function KanbanCard({
  task,
  onClick,
}: {
  task: Task;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className="p-3 bg-[#2d2d2d] rounded-md border border-[#3d3d3d] hover:border-[#555] cursor-pointer transition-colors"
    >
      <p className="text-xs font-medium text-[#e5e5e5] mb-1.5 line-clamp-2 leading-relaxed">
        {task.description}
      </p>
      {task.subtasks.length > 0 && (
        <div className="flex gap-0.5 mb-1.5">
          {task.subtasks.map((s) => (
            <div
              key={s.id}
              className={`h-1 flex-1 rounded-full ${
                s.status === "success"
                  ? "bg-green-500"
                  : s.status === "running"
                    ? "bg-yellow-500"
                    : s.status === "failed"
                      ? "bg-red-500"
                      : "bg-[#3d3d3d]"
              }`}
            />
          ))}
        </div>
      )}
      <div className="flex items-center justify-between">
        <StatusBadge status={task.status} />
        {task.blockedBy && (
          <span className="text-[10px] text-orange-400 truncate ml-1">
            blocked
          </span>
        )}
      </div>
      {task.branchName && task.branchName !== `phil/${task.id.slice(0, 8)}` && (
        <p className="text-[10px] text-[#555] mt-1 font-mono truncate">
          {task.branchName}
        </p>
      )}
      <div className="flex items-center gap-2 mt-1">
        {task.prUrl && (
          <a
            href={task.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-[10px] text-blue-400 hover:underline"
          >
            PR
          </a>
        )}
        {task.previewUrl && !["cancelled", "closed", "failed"].includes(task.status) && (
          <a
            href={resolvePreviewUrl(task.previewUrl)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-[10px] text-indigo-400 hover:underline"
          >
            Preview
          </a>
        )}
      </div>
    </div>
  );
}
