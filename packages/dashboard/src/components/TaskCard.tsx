import { resolvePreviewUrl, type Task } from "../api.js";
import { StatusBadge } from "./StatusBadge.js";

export function TaskCard({
  task,
  onClick,
}: {
  task: Task;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className="group flex items-start gap-3 px-4 py-3 hover:bg-[#2d2d2d] cursor-pointer transition-colors border-b border-[#3d3d3d] last:border-b-0"
    >
      {/* Status column */}
      <div className="flex-shrink-0 mt-0.5 w-24">
        <StatusBadge status={task.status} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[#e5e5e5] truncate font-medium">{task.description}</p>
        {task.subtasks.length > 0 && (
          <div className="flex gap-0.5 mt-1.5 max-w-[160px]">
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
        <div className="flex items-center gap-3 mt-1">
          {task.prUrl && (
            <a
              href={task.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-xs text-blue-400 hover:underline"
            >
              PR ↗
            </a>
          )}
          {task.previewUrl && (
            <a
              href={resolvePreviewUrl(task.previewUrl)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-xs text-indigo-400 hover:underline"
            >
              Preview ↗
            </a>
          )}
        </div>
      </div>

      {/* Date */}
      <div className="flex-shrink-0 text-xs text-[#555] opacity-0 group-hover:opacity-100 transition-opacity mt-0.5">
        {new Date(task.createdAt).toLocaleDateString()}
      </div>
    </div>
  );
}
