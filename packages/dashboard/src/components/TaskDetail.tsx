import { useEffect, useState, useRef } from "react";
import { getTask, getLogs, getContext, mergeTask, closeTask, cancelTask, startTask, resolvePreviewUrl, subscribeToEvents, type Task, type PhilEvent, type ContextEntry } from "../api.js";
import { StatusBadge } from "./StatusBadge.js";
import { ChatPanel } from "./ChatPanel.js";
import { PlanReview } from "./PlanReview.js";

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
    getLogs(taskId).then((entries) => {
      setLogs(entries.map((e) => e.message));
    });
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
          <div className="flex gap-2">
            {isReviewPhase && task.prUrl && (
              <button
                onClick={() => {
                  if (confirm("Merge this PR and close the task?")) {
                    mergeTask(task.id)
                      .then(() => getTask(taskId).then(setTask))
                      .catch((err) => alert(`Merge failed: ${err.message}`));
                  }
                }}
                className="px-3 py-1 bg-green-600 hover:bg-green-500 rounded text-xs font-medium"
              >
                Approve & Merge
              </button>
            )}
            {isReviewPhase && (
              <button
                onClick={() => {
                  if (confirm("Close this task and its PR? This cannot be undone.")) {
                    closeTask(task.id)
                      .then(() => getTask(taskId).then(setTask))
                      .catch((err) => alert(`Close failed: ${err.message}`));
                  }
                }}
                className="px-3 py-1 bg-red-600 hover:bg-red-500 rounded text-xs font-medium"
              >
                Close
              </button>
            )}
            {(task.status === "planning" || task.status === "planned" || task.status === "queued" || task.status === "running" || task.status === "blocked") && (
              <button
                onClick={() => {
                  if (confirm("Cancel this task?")) {
                    cancelTask(task.id)
                      .then(() => getTask(taskId).then(setTask))
                      .catch((err) => alert(`Cancel failed: ${err.message}`));
                  }
                }}
                className="px-3 py-1 bg-red-600 hover:bg-red-500 rounded text-xs font-medium"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
        <p className="font-medium mb-1">{task.description}</p>
        <p className="text-sm text-gray-400">{task.repoUrl}</p>
        {task.branchName && (
          <p className="text-xs text-gray-500 mt-1 font-mono">{task.branchName}</p>
        )}
        <div className="flex items-center gap-3 mt-2">
          {task.prUrl && (
            <a
              href={task.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-400 hover:underline"
            >
              View Pull Request
            </a>
          )}
          {task.previewUrl && !["cancelled", "closed", "failed"].includes(task.status) && (
            <a
              href={resolvePreviewUrl(task.previewUrl)}
              target="_blank"
              rel="noopener noreferrer"
              className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 rounded text-xs font-medium"
            >
              Live Preview
            </a>
          )}
        </div>
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
        {task.status === "backlog" && (
          <div className="mt-3">
            <button
              onClick={() => {
                startTask(task.id)
                  .then(() => getTask(taskId).then(setTask))
                  .catch((err) => alert(`Start failed: ${(err as Error).message}`));
              }}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm font-medium"
            >
              Start Planning
            </button>
            <p className="mt-1 text-xs text-gray-500">Move this task out of backlog and begin planning.</p>
          </div>
        )}
        {task.error && (
          <p className="mt-2 text-sm text-red-400">{task.error}</p>
        )}
      </div>

      {/* Plan review — show when task is planned or being revised */}
      {(task.status === "planned" || (task.status === "planning" && task.planMarkdown)) && (
        <PlanReview task={task} onUpdate={() => getTask(taskId).then(setTask)} />
      )}

      {/* Subtasks — show during execution (running, reviewing, etc.) */}
      {task.subtasks.length > 0 && task.status !== "planned" && task.status !== "planning" && (
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

      {/* Context Inspector — show for completed/reviewing tasks */}
      {["reviewing", "fixing", "success", "failed", "closed"].includes(task.status) && (
        <ContextInspector taskId={taskId} />
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

function ContextInspector({ taskId }: { taskId: string }) {
  const [context, setContext] = useState<ContextEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = () => {
    if (loaded) return;
    setLoaded(true);
    getContext(taskId).then(setContext);
  };

  return (
    <div className="p-4 bg-gray-900 rounded-lg border border-gray-800">
      <button
        onClick={() => { setOpen(!open); load(); }}
        className="flex items-center gap-2 text-sm font-semibold w-full text-left"
      >
        <svg
          className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={3}
        >
          <path d="M9 5l7 7-7 7" />
        </svg>
        Agent Context Inspector
        {context && <span className="text-xs text-gray-500 font-normal ml-2">({context.length} entries)</span>}
      </button>
      {open && (
        <div className="mt-3 max-h-[500px] overflow-y-auto space-y-1.5">
          {!context && <p className="text-gray-500 text-xs">Loading...</p>}
          {context && context.length === 0 && <p className="text-gray-500 text-xs">No context captured for this task.</p>}
          {context?.map((entry, i) => (
            <div key={i} className={`text-xs font-mono p-2 rounded ${
              entry.type === "tool" ? "bg-blue-950/50 border border-blue-900/50" :
              entry.type === "result" ? "bg-green-950/50 border border-green-900/50" :
              "bg-gray-800/50 border border-gray-700/50"
            }`}>
              <span className={`font-semibold ${
                entry.type === "tool" ? "text-blue-400" :
                entry.type === "result" ? "text-green-400" :
                "text-gray-400"
              }`}>
                {entry.type === "tool" ? "Tool" : entry.type === "result" ? "Result" : "Text"}
              </span>
              <pre className="mt-1 text-gray-300 whitespace-pre-wrap break-all">{entry.content}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

