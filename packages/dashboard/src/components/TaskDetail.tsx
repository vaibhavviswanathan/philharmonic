import { useEffect, useState, useRef } from "react";
import {
  getTask,
  getLogs,
  getContext,
  mergeTask,
  closeTask,
  cancelTask,
  startTask,
  exposePort,
  subscribeToEvents,
  type Task,
  type PhilEvent,
  type ContextEntry,
} from "../api.js";
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

  if (!task) {
    return (
      <div className="max-w-3xl mx-auto px-10 py-12">
        <div className="text-[#555] text-sm animate-pulse">Loading task...</div>
      </div>
    );
  }

  const isReviewPhase = task.status === "reviewing" || task.status === "fixing";

  return (
    <div className="max-w-3xl mx-auto px-10 py-12 space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs text-[#555]">
        <button onClick={onBack} className="hover:text-[#999] transition-colors">
          Project
        </button>
        <span>/</span>
        <span className="text-[#999] font-mono">{task.id.slice(0, 8)}</span>
      </div>

      {/* Page header */}
      <div>
        <div className="flex items-center gap-3 mb-3">
          <StatusBadge status={task.status} />
          {task.reviewCycles ? (
            <span className="text-xs text-purple-400">
              {task.reviewCycles} review cycle{task.reviewCycles > 1 ? "s" : ""}
            </span>
          ) : null}
          <span className="text-xs text-[#555] font-mono ml-auto">{task.id}</span>
        </div>
        <h1 className="text-2xl font-bold text-[#e5e5e5] tracking-tight leading-snug">
          {task.description}
        </h1>
        <p className="text-sm text-[#666] mt-2">{task.repoUrl}</p>
        {task.branchName && (
          <code className="text-xs text-[#555] mt-1 block font-mono">{task.branchName}</code>
        )}
      </div>

      {/* Actions bar */}
      <div className="flex items-center gap-2 flex-wrap">
        {task.prUrl && (
          <a
            href={task.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="notion-btn-secondary text-blue-400 hover:text-blue-300"
          >
            View PR ↗
          </a>
        )}
        {task.previewUrl && !["cancelled", "closed", "failed"].includes(task.status) && (
          <button
            onClick={async () => {
              try {
                const freshUrl = await exposePort(task.id, 8080);
                window.open(freshUrl, "_blank");
                getTask(taskId).then(setTask);
              } catch {
                window.open(task.previewUrl!, "_blank");
              }
            }}
            className="notion-btn-secondary text-indigo-400 hover:text-indigo-300"
          >
            Live Preview ↗
          </button>
        )}
        {isReviewPhase && task.prUrl && (
          <button
            onClick={() => {
              if (confirm("Merge this PR and close the task?")) {
                mergeTask(task.id)
                  .then(() => getTask(taskId).then(setTask))
                  .catch((err) => alert(`Merge failed: ${err.message}`));
              }
            }}
            className="notion-btn-primary bg-green-600 hover:bg-green-500"
          >
            Approve &amp; Merge
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
            className="notion-btn-ghost text-red-400 hover:text-red-300 hover:bg-red-500/10"
          >
            Close PR
          </button>
        )}
        {["planning", "planned", "queued", "running", "blocked"].includes(task.status) && (
          <button
            onClick={() => {
              if (confirm("Cancel this task?")) {
                cancelTask(task.id)
                  .then(() => getTask(taskId).then(setTask))
                  .catch((err) => alert(`Cancel failed: ${err.message}`));
              }
            }}
            className="notion-btn-ghost text-red-400 hover:text-red-300 hover:bg-red-500/10"
          >
            Cancel
          </button>
        )}
        {task.status === "backlog" && (
          <button
            onClick={() => {
              startTask(task.id)
                .then(() => getTask(taskId).then(setTask))
                .catch((err) => alert(`Start failed: ${(err as Error).message}`));
            }}
            className="notion-btn-primary"
          >
            Start Planning
          </button>
        )}
      </div>

      {/* Status notes */}
      {task.status === "blocked" && task.blockedBy && (
        <div className="flex items-center gap-2 text-sm text-orange-400 bg-orange-500/10 border border-orange-500/20 rounded-lg px-4 py-3">
          <span>⚠</span>
          <span>Blocked by task <code className="font-mono text-xs">{task.blockedBy}</code></span>
        </div>
      )}
      {isReviewPhase && (
        <div className="flex items-center gap-2 text-sm text-purple-400 bg-purple-500/10 border border-purple-500/20 rounded-lg px-4 py-3">
          <span>💬</span>
          <span>Sandbox is active — add PR review comments or send messages below. The agent will auto-fix them.</span>
        </div>
      )}
      {task.error && (
        <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">
          {task.error}
        </div>
      )}

      {/* Plan review */}
      {(task.status === "planned" || (task.status === "planning" && task.planMarkdown)) && (
        <PlanReview task={task} onUpdate={() => getTask(taskId).then(setTask)} />
      )}

      {/* Subtasks */}
      {task.subtasks.length > 0 &&
        task.status !== "planned" &&
        task.status !== "planning" && (
          <div className="notion-panel p-5">
            <h3 className="text-xs font-semibold text-[#555] uppercase tracking-widest mb-3">Subtasks</h3>
            <div className="space-y-2">
              {task.subtasks.map((s) => (
                <div key={s.id} className="flex items-center gap-3 text-sm">
                  <StatusBadge status={s.status} />
                  <span className="text-[#e5e5e5]">{s.description}</span>
                </div>
              ))}
            </div>
          </div>
        )}

      {/* Chat */}
      {(isReviewPhase || task.prUrl) && <ChatPanel taskId={taskId} />}

      {/* Context inspector */}
      {["reviewing", "fixing", "success", "failed", "closed"].includes(task.status) && (
        <ContextInspector taskId={taskId} />
      )}

      {/* Logs */}
      <div className="notion-panel p-5">
        <h3 className="text-xs font-semibold text-[#555] uppercase tracking-widest mb-3">Agent Logs</h3>
        <div className="bg-[#111] rounded-md p-4 max-h-96 overflow-y-auto font-mono text-xs space-y-0.5">
          {logs.length === 0 && (
            <p className="text-[#444]">Waiting for agent output...</p>
          )}
          {logs.map((log, i) => (
            <div
              key={i}
              className={`leading-relaxed ${
                log.startsWith("[CONFLICT]") ? "text-orange-400"
                : log.startsWith("[REBASE]")  ? "text-yellow-400"
                : log.startsWith("[REVIEW]")  ? "text-purple-400"
                : log.startsWith("[FIXING]")  ? "text-purple-300"
                : log.startsWith("[FIXED]")   ? "text-green-400"
                : log.startsWith("[ESCALATION]") ? "text-yellow-300"
                : "text-[#999]"
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
    <div className="notion-panel p-5">
      <button
        onClick={() => {
          setOpen(!open);
          load();
        }}
        className="flex items-center gap-2 text-xs font-semibold text-[#555] uppercase tracking-widest w-full text-left hover:text-[#999] transition-colors"
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
        Agent Context
        {context && (
          <span className="font-normal text-[#555] ml-1">({context.length} entries)</span>
        )}
      </button>
      {open && (
        <div className="mt-4 max-h-[500px] overflow-y-auto space-y-1.5">
          {!context && <p className="text-[#555] text-xs">Loading...</p>}
          {context && context.length === 0 && (
            <p className="text-[#555] text-xs">No context captured for this task.</p>
          )}
          {context?.map((entry, i) => (
            <div
              key={i}
              className={`text-xs font-mono p-3 rounded-md ${
                entry.type === "tool"
                  ? "bg-blue-500/5 border border-blue-500/15"
                  : entry.type === "result"
                    ? "bg-green-500/5 border border-green-500/15"
                    : "bg-[#2d2d2d] border border-[#3d3d3d]"
              }`}
            >
              <span
                className={`font-semibold text-[10px] uppercase tracking-wider ${
                  entry.type === "tool"
                    ? "text-blue-400"
                    : entry.type === "result"
                      ? "text-green-400"
                      : "text-[#666]"
                }`}
              >
                {entry.type}
              </span>
              <pre className="mt-1.5 text-[#999] whitespace-pre-wrap break-all leading-relaxed">
                {entry.content}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
