import { useState } from "react";
import { rebaseTask } from "../api.js";

export function RebaseButton({
  taskId,
  onRebase,
}: {
  taskId: string;
  onRebase?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    setLoading(true);
    setError(null);
    try {
      await rebaseTask(taskId);
      onRebase?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create rebase task");
    } finally {
      setLoading(false);
    }
  }

  return (
    <span className="flex flex-col gap-1">
      <button
        onClick={handleClick}
        disabled={loading}
        className="text-xs text-orange-400 hover:text-orange-300 disabled:opacity-50 disabled:cursor-not-allowed"
        title="Create a task to rebase this branch onto main"
      >
        {loading ? "Scheduling..." : "Rebase"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </span>
  );
}
