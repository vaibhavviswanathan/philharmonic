import { useEffect, useState, useCallback } from "react";
import { listTasks, createTask, updateProject, type Project, type Task, type AutonomyLevel } from "../api.js";
import { TaskCard } from "./TaskCard.js";
import { TaskDetail } from "./TaskDetail.js";
import { KanbanBoard } from "./KanbanBoard.js";
import { DependencyGraph } from "./DependencyGraph.js";

type ViewMode = "list" | "kanban" | "graph";

export function ProjectView({
  project: initialProject,
  onBack,
}: {
  project: Project;
  onBack: () => void;
}) {
  const [project, setProject] = useState(initialProject);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [backlog, setBacklog] = useState(false);
  const [error, setError] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("list");

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
      await createTask(project.id, description, backlog);
      setDescription("");
      setBacklog(false);
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
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold">{project.name}</h2>
            <p className="text-sm text-gray-400 mt-1">{project.repoUrl}</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400">Autonomy:</label>
            <select
              value={project.autonomyLevel ?? "supervised"}
              onChange={async (e) => {
                const level = e.target.value as AutonomyLevel;
                try {
                  const updated = await updateProject(project.id, { autonomyLevel: level });
                  setProject(updated);
                } catch (err) {
                  console.error("Failed to update autonomy:", err);
                }
              }}
              className="px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white focus:outline-none focus:border-blue-500"
            >
              <option value="supervised">Supervised</option>
              <option value="moderate">Moderate (&le;3 files)</option>
              <option value="high">High (&le;10 files)</option>
              <option value="full">Full auto</option>
            </select>
          </div>
        </div>
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
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={submitting}
            onClick={() => setBacklog(false)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-sm font-medium"
          >
            {submitting && !backlog ? "Submitting..." : "Submit Task"}
          </button>
          <button
            type="submit"
            disabled={submitting}
            onClick={() => setBacklog(true)}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 rounded text-sm font-medium"
          >
            {submitting && backlog ? "Saving..." : "Save to Backlog"}
          </button>
        </div>
      </form>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            Tasks {tasks.length > 0 && `(${tasks.length})`}
          </h3>
          <ViewToggle viewMode={viewMode} onChange={setViewMode} />
        </div>

        {tasks.length === 0 && (
          <p className="text-gray-500 text-sm">No tasks yet. Submit one above.</p>
        )}

        {tasks.length > 0 && viewMode === "list" && (
          <div className="space-y-3">
            {tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onClick={() => setSelectedTaskId(task.id)}
              />
            ))}
          </div>
        )}

        {tasks.length > 0 && viewMode === "kanban" && (
          <KanbanBoard
            tasks={tasks}
            onTaskClick={(id) => setSelectedTaskId(id)}
          />
        )}

        {tasks.length > 0 && viewMode === "graph" && (
          <DependencyGraph
            tasks={tasks}
            onTaskClick={(id) => setSelectedTaskId(id)}
          />
        )}
      </div>
    </div>
  );
}

function ViewToggle({
  viewMode,
  onChange,
}: {
  viewMode: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  const modes: { mode: ViewMode; label: string; icon: string }[] = [
    { mode: "list", label: "List", icon: "M4 6h16M4 12h16M4 18h16" },
    { mode: "kanban", label: "Kanban", icon: "M9 4H5a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V5a1 1 0 00-1-1zm0 10H5a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1v-4a1 1 0 00-1-1zm10-10h-4a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V5a1 1 0 00-1-1zm0 10h-4a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1v-4a1 1 0 00-1-1z" },
    { mode: "graph", label: "Graph", icon: "M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" },
  ];

  return (
    <div className="flex bg-gray-800 rounded-md p-0.5 gap-0.5">
      {modes.map(({ mode, label, icon }) => (
        <button
          key={mode}
          onClick={() => onChange(mode)}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            viewMode === mode
              ? "bg-gray-700 text-white"
              : "text-gray-400 hover:text-gray-200"
          }`}
          title={label}
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d={icon} />
          </svg>
          {label}
        </button>
      ))}
    </div>
  );
}
