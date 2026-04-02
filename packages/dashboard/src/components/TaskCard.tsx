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
      className="p-4 bg-gray-900 rounded-lg border border-gray-800 hover:border-gray-600 cursor-pointer transition-colors"
    >
      <div className="flex items-center justify-between mb-2">
        <StatusBadge status={task.status} />
        <span className="text-xs text-gray-500">
          {new Date(task.createdAt).toLocaleString()}
        </span>
      </div>
      <p className="text-sm font-medium mb-1 truncate">{task.description}</p>
      <p className="text-xs text-gray-500 truncate">{task.repoUrl}</p>
      {task.dependsOn && task.dependsOn.length > 0 && (
        <p className="text-xs text-orange-400 mt-1">
          {task.status === "blocked" ? "Blocked by" : "Depends on"} {task.dependsOn.length} task{task.dependsOn.length > 1 ? "s" : ""}
        </p>
      )}
      {task.subtasks.length > 0 && (
        <div className="mt-2 flex gap-1">
          {task.subtasks.map((s) => (
            <div
              key={s.id}
              className={`h-1.5 flex-1 rounded ${
                s.status === "success"
                  ? "bg-green-500"
                  : s.status === "running"
                    ? "bg-yellow-500"
                    : s.status === "failed"
                      ? "bg-red-500"
                      : "bg-gray-700"
              }`}
            />
          ))}
        </div>
      )}
      <div className="flex items-center gap-3 mt-2">
        {task.prUrl && (
          <a
            href={task.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-xs text-blue-400 hover:underline"
          >
            View PR
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
            Preview
          </a>
        )}
      </div>
    </div>
  );
}
