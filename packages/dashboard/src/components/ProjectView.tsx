import { useEffect, useState, useCallback } from "react";
import {
  listTasks,
  createTask,
  updateProject,
  type Project,
  type Task,
  type AutonomyLevel,
} from "../api.js";
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
  const [selectedDeps, setSelectedDeps] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [showTaskForm, setShowTaskForm] = useState(false);

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
      await createTask(
        project.id,
        description,
        backlog,
        selectedDeps.length > 0 ? selectedDeps : undefined,
      );
      setDescription("");
      setBacklog(false);
      setSelectedDeps([]);
      setShowTaskForm(false);
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
    <div className="max-w-3xl mx-auto px-10 py-12">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs text-[#555] mb-6">
        <button onClick={onBack} className="hover:text-[#999] transition-colors">
          Projects
        </button>
        <span>/</span>
        <span className="text-[#999]">{project.name}</span>
      </div>

      {/* Page header */}
      <div className="mb-8">
        <div className="text-4xl mb-3">📁</div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-[#e5e5e5] tracking-tight">{project.name}</h1>
            <a
              href={project.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-[#666] hover:text-[#999] transition-colors mt-1 inline-block"
            >
              {project.repoUrl} ↗
            </a>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 mt-1">
            <span className="text-xs text-[#555]">Autonomy</span>
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
              className="px-2.5 py-1.5 bg-[#2d2d2d] border border-[#3d3d3d] rounded-md text-xs text-[#e5e5e5] focus:outline-none focus:border-[#555] transition-colors cursor-pointer"
            >
              <option value="supervised">Supervised</option>
              <option value="moderate">Moderate (≤3 files)</option>
              <option value="high">High (≤10 files)</option>
              <option value="full">Full auto</option>
            </select>
          </div>
        </div>
      </div>

      {/* Task form */}
      <div className="mb-8">
        {!showTaskForm ? (
          <button
            onClick={() => setShowTaskForm(true)}
            className="flex items-center gap-2 text-[#666] hover:text-[#999] text-sm transition-colors group"
          >
            <span className="w-5 h-5 rounded border border-dashed border-[#444] flex items-center justify-center group-hover:border-[#666] transition-colors text-[#555] group-hover:text-[#999]">
              +
            </span>
            New task
          </button>
        ) : (
          <form onSubmit={handleSubmit} className="notion-panel p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[#e5e5e5]">New Task</h3>
              <button
                type="button"
                onClick={() => { setShowTaskForm(false); setError(""); }}
                className="text-[#555] hover:text-[#999] text-xs transition-colors"
              >
                Cancel
              </button>
            </div>
            <textarea
              placeholder="Describe what you want Phil to do..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              rows={3}
              autoFocus
              className="w-full bg-transparent border border-[#3d3d3d] rounded-md px-3 py-2.5 text-sm text-[#e5e5e5] placeholder-[#555] focus:outline-none focus:border-[#555] transition-colors resize-none"
            />
            {error && <p className="text-red-400 text-xs">{error}</p>}
            {tasks.length > 0 && (
              <details className="text-sm">
                <summary className="text-[#666] cursor-pointer hover:text-[#999] text-xs transition-colors select-none">
                  Dependencies {selectedDeps.length > 0 && `(${selectedDeps.length} selected)`}
                </summary>
                <div className="mt-2 max-h-32 overflow-y-auto space-y-1 pl-1">
                  {tasks
                    .filter((t) => t.status !== "cancelled" && t.status !== "closed")
                    .map((t) => (
                      <label
                        key={t.id}
                        className="flex items-center gap-2 text-xs text-[#999] cursor-pointer hover:text-[#e5e5e5] transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={selectedDeps.includes(t.id)}
                          onChange={(e) => {
                            setSelectedDeps((prev) =>
                              e.target.checked
                                ? [...prev, t.id]
                                : prev.filter((d) => d !== t.id),
                            );
                          }}
                          className="rounded border-[#555] accent-blue-600"
                        />
                        <span className="truncate">{t.description.slice(0, 60)}</span>
                        <span className="text-[#555] flex-shrink-0">({t.status})</span>
                      </label>
                    ))}
                </div>
              </details>
            )}
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={submitting}
                onClick={() => setBacklog(false)}
                className="notion-btn-primary"
              >
                {submitting && !backlog ? "Submitting..." : "Submit task"}
              </button>
              <button
                type="submit"
                disabled={submitting}
                onClick={() => setBacklog(true)}
                className="notion-btn-secondary"
              >
                {submitting && backlog ? "Saving..." : "Save to backlog"}
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Tasks section */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="text-[11px] font-semibold text-[#555] uppercase tracking-widest">
            Tasks {tasks.length > 0 && `· ${tasks.length}`}
          </div>
          {tasks.length > 0 && <ViewToggle viewMode={viewMode} onChange={setViewMode} />}
        </div>

        {tasks.length === 0 && (
          <p className="text-[#555] text-sm py-8 text-center">No tasks yet. Create one above.</p>
        )}

        {tasks.length > 0 && viewMode === "list" && (
          <div className="notion-panel overflow-hidden">
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
          <KanbanBoard tasks={tasks} onTaskClick={(id) => setSelectedTaskId(id)} />
        )}

        {tasks.length > 0 && viewMode === "graph" && (
          <DependencyGraph tasks={tasks} onTaskClick={(id) => setSelectedTaskId(id)} />
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
    { mode: "list",   label: "List",   icon: "M4 6h16M4 12h16M4 18h16" },
    { mode: "kanban", label: "Board",  icon: "M9 4H5a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V5a1 1 0 00-1-1zm0 10H5a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1v-4a1 1 0 00-1-1zm10-10h-4a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V5a1 1 0 00-1-1zm0 10h-4a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1v-4a1 1 0 00-1-1z" },
    { mode: "graph",  label: "Graph",  icon: "M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" },
  ];

  return (
    <div className="flex bg-[#2d2d2d] rounded-md p-0.5 gap-0.5">
      {modes.map(({ mode, label, icon }) => (
        <button
          key={mode}
          onClick={() => onChange(mode)}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            viewMode === mode
              ? "bg-[#3d3d3d] text-[#e5e5e5]"
              : "text-[#666] hover:text-[#999]"
          }`}
          title={label}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d={icon} />
          </svg>
          {label}
        </button>
      ))}
    </div>
  );
}
