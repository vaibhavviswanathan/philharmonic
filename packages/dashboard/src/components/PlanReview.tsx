import { useState } from "react";
import { approvePlan, sendPlanFeedback, type Task } from "../api.js";

export function PlanReview({
  task,
  onUpdate,
}: {
  task: Task;
  onUpdate: () => void;
}) {
  const [feedback, setFeedback] = useState("");
  const [approving, setApproving] = useState(false);
  const [sending, setSending] = useState(false);

  const isRevising = task.status === "planning";

  async function handleApprove() {
    setApproving(true);
    try {
      await approvePlan(task.id);
      onUpdate();
    } catch (err) {
      alert(`Approve failed: ${(err as Error).message}`);
    } finally {
      setApproving(false);
    }
  }

  async function handleFeedback(e: React.FormEvent) {
    e.preventDefault();
    if (!feedback.trim()) return;
    setSending(true);
    try {
      await sendPlanFeedback(task.id, feedback.trim());
      setFeedback("");
      onUpdate();
    } catch (err) {
      alert(`Feedback failed: ${(err as Error).message}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="notion-panel p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-[#555] uppercase tracking-widest">
          {isRevising ? "Revising Plan" : "Execution Plan"}
        </h3>
        {!isRevising && (
          <button
            onClick={handleApprove}
            disabled={approving}
            className="notion-btn-primary bg-green-600 hover:bg-green-500"
          >
            {approving ? "Approving..." : "Approve & Execute"}
          </button>
        )}
      </div>

      {isRevising && (
        <div className="flex items-center gap-2 text-sm text-yellow-400">
          <svg className="animate-spin h-3.5 w-3.5 flex-shrink-0" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Claude is revising the plan based on your feedback...
        </div>
      )}

      {task.planMarkdown && (
        <div className="bg-[#111] rounded-md p-4 text-sm text-[#999] whitespace-pre-wrap font-mono leading-relaxed overflow-auto max-h-96 text-xs">
          {task.planMarkdown}
        </div>
      )}

      {task.subtasks.length > 0 && (
        <div>
          <h4 className="text-[10px] font-semibold text-[#555] uppercase tracking-widest mb-2">Subtasks</h4>
          <div className="space-y-1.5">
            {task.subtasks.map((s, i) => (
              <div key={s.id} className="flex items-start gap-2.5 text-sm">
                <span className="text-[#555] font-mono text-xs mt-0.5 w-4 flex-shrink-0 text-right">{i + 1}.</span>
                <div className="min-w-0">
                  <span className="text-[#e5e5e5] text-sm">{s.description}</span>
                  {s.fileTargets.length > 0 && (
                    <div className="text-xs text-[#555] font-mono mt-0.5">
                      {s.fileTargets.join(", ")}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {task.touchSet.length > 0 && (
        <div>
          <h4 className="text-[10px] font-semibold text-[#555] uppercase tracking-widest mb-2">Files to modify</h4>
          <div className="flex flex-wrap gap-1">
            {task.touchSet.map((f) => (
              <span
                key={f}
                className="px-2 py-0.5 bg-[#2d2d2d] border border-[#3d3d3d] rounded text-xs font-mono text-[#999]"
              >
                {f}
              </span>
            ))}
          </div>
        </div>
      )}

      {task.branchName && (
        <div className="text-xs text-[#555]">
          Branch: <code className="font-mono text-[#666]">{task.branchName}</code>
        </div>
      )}

      {!isRevising && (
        <form onSubmit={handleFeedback} className="flex gap-2 pt-1">
          <input
            type="text"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Request changes to the plan..."
            className="flex-1 bg-[#2d2d2d] border border-[#3d3d3d] rounded-md px-3 py-1.5 text-sm text-[#e5e5e5] placeholder-[#555] focus:outline-none focus:border-[#555] transition-colors"
          />
          <button
            type="submit"
            disabled={sending || !feedback.trim()}
            className="notion-btn-secondary"
          >
            {sending ? "..." : "Revise"}
          </button>
        </form>
      )}
    </div>
  );
}
