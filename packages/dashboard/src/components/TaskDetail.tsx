import { useEffect, useState, useRef } from "react";
import { getTask, resolveTask, subscribeToEvents, type Task, type PhilEvent } from "../api.js";
import { StatusBadge } from "./StatusBadge.js";
import { ChatPanel } from "./ChatPanel.js";

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
      if (
        event.type === "task_status_changed" ||
        event.type === "conflict_detected" ||
        event.type === "conflict_resolved" ||
        event.type === "review_fix_started" ||
        event.type === "review_fix_completed"
      ) {
        getTask(taskId).then(setTask);
      }
      if (event.type === "conflict_detected") {
        const files = (event.data.overlappingFiles as string[]) ?? [];
        setLogs((prev) => [
          ...prev,
          `[CONFLICT] Blocked by task ${event.data.blockingTaskId} — overlapping files: ${files.join(", ")}`,
        ]);
      }
      if (event.type === "rebase_required") {
        setLogs((prev) => [
          ...prev,
          `[REBASE] PR #${event.data.mergedPrNumber} merged — rebase needed`,
        ]);
      }
      if (event.type === "review_received") {
        setLogs((prev) => [
          ...prev,
          `[REVIEW] ${event.data.author}: ${(event.data.body as string)?.slice(0, 100)}`,
        ]);
      }
      if (event.type === "review_fix_started") {
        setLogs((prev) => [
          ...prev,
          `[FIXING] Processing ${event.data.reviewCount} review comment(s)...`,
        ]);
      }
      if (event.type === "review_fix_completed") {
        setLogs((prev) => [
          ...prev,
          `[FIXED] Review cycle ${event.data.cycles} complete`,
        ]);
      }
    });
    return unsub;
  }, [taskId]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  if (!task) return <div className="p-4">Loading...</div>;

  const isReviewPhase = task.status === "reviewing" || task.status === "fixing";

  return (
    <div className="space-y-4">
      <button
        onClick={onBack}
        className="text-sm text-gray-400 hover:text-white"
      >
        &larr; Back
      </button>

      <div className="p-4 bg-gray-900 rounded-lg border border-gray-800">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <StatusBadge status={task.status} />
            <span className="text-xs text-gray-500 font-mono">{task.id}</span>
            {task.reviewCycles ? (
              <span className="text-xs text-purple-400">
                {task.reviewCycles} review cycle{task.reviewCycles > 1 ? "s" : ""}
              </span>
            ) : null}
          </div>
          {isReviewPhase && (
            <button
              onClick={() => {
                if (confirm("Mark this task as resolved? This will destroy the sandbox.")) {
                  resolveTask(task.id).then(() => getTask(taskId).then(setTask));
                }
              }}
              className="px-3 py-1 bg-green-700 hover:bg-green-600 rounded text-xs font-medium"
            >
              Resolve & Close
            </button>
          )}
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
        {task.status === "blocked" && task.blockedBy && (
          <p className="mt-2 text-sm text-orange-400">
            Blocked by task <span className="font-mono">{task.blockedBy}</span> (touch-set conflict)
          </p>
        )}
        {isReviewPhase && (
          <p className="mt-2 text-sm text-purple-400">
            Sandbox is alive — add PR review comments or send messages below. The agent will automatically fix them.
          </p>
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

      {/* Chat panel — show for reviewing/fixing tasks, or any task with a PR */}
      {(isReviewPhase || task.prUrl) && (
        <ChatPanel taskId={taskId} />
      )}

      <div className="p-4 bg-gray-900 rounded-lg border border-gray-800">
        <h3 className="text-sm font-semibold mb-2">Agent Logs</h3>
        <div className="bg-black rounded p-3 max-h-96 overflow-y-auto font-mono text-xs space-y-0.5">
          {logs.length === 0 && (
            <p className="text-gray-600">Waiting for agent output...</p>
          )}
          {logs.map((log, i) => (
            <div
              key={i}
              className={`text-gray-300 ${
                log.startsWith("[CONFLICT]")
                  ? "text-orange-400"
                  : log.startsWith("[REBASE]")
                    ? "text-yellow-400"
                    : log.startsWith("[REVIEW]")
                      ? "text-purple-400"
                      : log.startsWith("[FIXING]")
                        ? "text-purple-300"
                        : log.startsWith("[FIXED]")
                          ? "text-green-400"
                          : log.startsWith("[ESCALATION]")
                            ? "text-yellow-300"
                            : ""
              }`}
            >
              {log}
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>
      </div>
    </div>
  );
}
