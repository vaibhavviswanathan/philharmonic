import { useEffect, useState, useRef } from "react";
import { getTask, subscribeToEvents, type Task, type PhilEvent } from "../api.js";
import { StatusBadge } from "./StatusBadge.js";

export function TaskDetail({
  taskId,
  onBack,
}: {
  taskId: string;
  onBack: () => void;
}) {
  const [task, setTask] = useState<Task | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getTask(taskId).then(setTask);
    const interval = setInterval(() => {
      getTask(taskId).then(setTask);
    }, 3000);
    return () => clearInterval(interval);
  }, [taskId]);

  useEffect(() => {
    const unsub = subscribeToEvents((event: PhilEvent) => {
      if (event.taskId !== taskId) return;

      if (event.type === "agent_log") {
        const msg = (event.data.message as string) ?? JSON.stringify(event.data);
        setLogs((prev) => [...prev, msg]);
      }
      if (event.type === "task_status_changed") {
        getTask(taskId).then(setTask);
      }
    });
    return unsub;
  }, [taskId]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  if (!task) return <div className="p-4">Loading...</div>;

  return (
    <div className="space-y-4">
      <button
        onClick={onBack}
        className="text-sm text-gray-400 hover:text-white"
      >
        &larr; Back
      </button>

      <div className="p-4 bg-gray-900 rounded-lg border border-gray-800">
        <div className="flex items-center gap-3 mb-2">
          <StatusBadge status={task.status} />
          <span className="text-xs text-gray-500 font-mono">{task.id}</span>
        </div>
        <p className="font-medium mb-1">{task.description}</p>
        <p className="text-sm text-gray-400">{task.repoUrl}</p>
        {task.branchName && (
          <p className="text-xs text-gray-500 mt-1 font-mono">{task.branchName}</p>
        )}
        {task.prUrl && (
          <a
            href={task.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-sm text-blue-400 hover:underline"
          >
            View Pull Request
          </a>
        )}
        {task.error && (
          <p className="mt-2 text-sm text-red-400">{task.error}</p>
        )}
      </div>

      {task.subtasks.length > 0 && (
        <div className="p-4 bg-gray-900 rounded-lg border border-gray-800">
          <h3 className="text-sm font-semibold mb-2">Subtasks</h3>
          <div className="space-y-2">
            {task.subtasks.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-sm">
                <StatusBadge status={s.status} />
                <span>{s.description}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="p-4 bg-gray-900 rounded-lg border border-gray-800">
        <h3 className="text-sm font-semibold mb-2">Agent Logs</h3>
        <div className="bg-black rounded p-3 max-h-96 overflow-y-auto font-mono text-xs space-y-0.5">
          {logs.length === 0 && (
            <p className="text-gray-600">Waiting for agent output...</p>
          )}
          {logs.map((log, i) => (
            <div key={i} className="text-gray-300">
              {log}
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>
      </div>
    </div>
  );
}
