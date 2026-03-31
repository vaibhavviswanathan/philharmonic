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
    <div className="p-4 bg-gray-900 rounded-lg border border-gray-800">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">
          {isRevising ? "Revising Plan..." : "Execution Plan"}
        </h3>
        {!isRevising && (
          <button
            onClick={handleApprove}
            disabled={approving}
            className="px-4 py-1.5 bg-green-600 hover:bg-green-500 disabled:opacity-50 rounded text-sm font-medium"
          >
            {approving ? "Approving..." : "Approve & Execute"}
          </button>
        )}
      </div>

      {isRevising && (
        <div className="mb-3 flex items-center gap-2 text-sm text-yellow-400">
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Claude is revising the plan based on your feedback...
        </div>
      )}

      {task.planMarkdown && (
        <div className="bg-black rounded p-4 mb-3 text-sm text-gray-300 whitespace-pre-wrap font-mono leading-relaxed overflow-auto max-h-96">
          {task.planMarkdown}
        </div>
      )}

      {task.subtasks.length > 0 && (
        <div className="mb-3">
          <h4 className="text-xs font-semibold text-gray-400 mb-2">Subtasks</h4>
          <div className="space-y-1.5">
            {task.subtasks.map((s, i) => (
              <div key={s.id} className="flex items-start gap-2 text-sm">
                <span className="text-gray-500 font-mono text-xs mt-0.5">{i + 1}.</span>
                <div>
                  <span className="text-gray-300">{s.description}</span>
                  {s.fileTargets.length > 0 && (
                    <div className="text-xs text-gray-500 font-mono mt-0.5">
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
        <div className="mb-3">
          <h4 className="text-xs font-semibold text-gray-400 mb-1">Files to be modified</h4>
          <div className="flex flex-wrap gap-1">
            {task.touchSet.map((f) => (
              <span key={f} className="px-1.5 py-0.5 bg-gray-800 rounded text-xs font-mono text-gray-400">
                {f}
              </span>
            ))}
          </div>
        </div>
      )}

      {task.branchName && (
        <div className="mb-3 text-xs text-gray-500">
          Branch: <span className="font-mono">{task.branchName}</span>
        </div>
      )}

      {!isRevising && (
        <form onSubmit={handleFeedback} className="flex gap-2">
          <input
            type="text"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Give feedback on the plan... (e.g. 'use a different approach', 'also add tests')"
            className="flex-1 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
          <button
            type="submit"
            disabled={sending || !feedback.trim()}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-sm font-medium"
          >
            {sending ? "..." : "Revise"}
          </button>
        </form>
      )}
    </div>
  );
}
// v2
