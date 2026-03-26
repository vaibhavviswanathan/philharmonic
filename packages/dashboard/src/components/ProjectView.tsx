import { useEffect, useState, useCallback } from "react";
import { listTasks, createTask, type Project, type Task } from "../api.js";
import { TaskCard } from "./TaskCard.js";
import { TaskDetail } from "./TaskDetail.js";

export function ProjectView({
  project,
  onBack,
}: {
  project: Project;
  onBack: () => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    listTasks(project.id).then(setTasks).catch(console.error);
  }, [project.id]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await createTask(project.id, description);
      setDescription("");
      refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (selectedTaskId) {
    return (
      <TaskDetail
        taskId={selectedTaskId}
        onBack={() => setSelectedTaskId(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-sm text-gray-400 hover:text-white">
        &larr; Projects
      </button>

      <div className="p-4 bg-gray-900 rounded-lg border border-gray-800">
        <h2 className="text-lg font-semibold">{project.name}</h2>
        <p className="text-sm text-gray-400 mt-1">{project.repoUrl}</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3 p-4 bg-gray-900 rounded-lg border border-gray-800">
        <h3 className="text-sm font-semibold">New Task</h3>
        <textarea
          placeholder="Describe what you want Phil to do..."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
          rows={3}
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm focus:outline-none focus:border-blue-500"
        />
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-sm font-medium"
        >
          {submitting ? "Submitting..." : "Submit Task"}
        </button>
      </form>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">
          Tasks {tasks.length > 0 && `(${tasks.length})`}
        </h3>
        {tasks.length === 0 && (
          <p className="text-gray-500 text-sm">No tasks yet. Submit one above.</p>
        )}
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            onClick={() => setSelectedTaskId(task.id)}
          />
        ))}
      </div>
    </div>
  );
}
