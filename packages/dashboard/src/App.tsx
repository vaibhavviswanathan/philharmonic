import { useEffect, useState, useCallback, useRef } from "react";
import { listProjects, deleteProject, createProject, type Project } from "./api.js";
import { ProjectView } from "./components/ProjectView.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { Sidebar } from "./components/Sidebar.js";
import { type View } from "./types.js";

const ROUTE_KEY = "phil-dashboard-route";

function loadStoredRoute(): { type: string; projectId?: string } | null {
  try {
    const stored = localStorage.getItem(ROUTE_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

function saveRoute(view: View) {
  try {
    const data =
      view.type === "project"
        ? { type: "project", projectId: view.project.id }
        : { type: view.type };
    localStorage.setItem(ROUTE_KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const storedRoute = useRef(loadStoredRoute());
  const [view, setView] = useState<View>(() => {
    const r = storedRoute.current;
    if (r?.type === "settings") return { type: "settings" };
    return { type: "projects" };
  });

  const navigate = useCallback((v: View) => {
    saveRoute(v);
    setView(v);
  }, []);

  const refresh = useCallback(() => {
    listProjects().then(setProjects).catch(console.error);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const r = storedRoute.current;
    if (r?.type === "project" && r.projectId && projects.length > 0) {
      const project = projects.find((p) => p.id === r.projectId);
      if (project) {
        storedRoute.current = null;
        setView({ type: "project", project });
      }
    }
  }, [projects]);

  return (
    <div className="flex h-screen bg-[#191919] text-[#e5e5e5] overflow-hidden">
      <Sidebar
        projects={projects}
        view={view}
        onNavigate={navigate}
        onDeleteProject={(id) => deleteProject(id).then(refresh)}
      />
      <main className="flex-1 overflow-y-auto">
        {view.type === "settings" && (
          <SettingsPanel onBack={() => navigate({ type: "projects" })} />
        )}
        {view.type === "project" && (
          <ProjectView
            project={view.project}
            onBack={() => {
              navigate({ type: "projects" });
              refresh();
            }}
          />
        )}
        {view.type === "projects" && (
          <ProjectsHome
            projects={projects}
            onNavigate={navigate}
            onRefresh={refresh}
            onDeleteProject={(id) => deleteProject(id).then(refresh)}
          />
        )}
      </main>
    </div>
  );
}

function ProjectsHome({
  projects,
  onNavigate,
  onRefresh,
  onDeleteProject,
}: {
  projects: Project[];
  onNavigate: (v: View) => void;
  onRefresh: () => void;
  onDeleteProject: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await createProject(name, repoUrl);
      setName("");
      setRepoUrl("");
      setShowForm(false);
      onRefresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-10 py-12">
      {/* Page header */}
      <div className="mb-8">
        <div className="text-4xl mb-3">🤖</div>
        <h1 className="text-3xl font-bold text-[#e5e5e5] tracking-tight">Projects</h1>
        <p className="text-[#666] text-sm mt-1">Delegate coding tasks to Phil, your AI agent.</p>
      </div>

      {/* New project */}
      <div className="mb-8">
        {!showForm ? (
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-2 text-[#666] hover:text-[#999] text-sm transition-colors group"
          >
            <span className="w-5 h-5 rounded border border-dashed border-[#444] flex items-center justify-center group-hover:border-[#666] transition-colors text-[#555] group-hover:text-[#999]">
              +
            </span>
            New project
          </button>
        ) : (
          <form
            onSubmit={handleCreate}
            className="notion-panel p-5 space-y-4"
          >
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-sm font-semibold text-[#e5e5e5]">New Project</h3>
              <button
                type="button"
                onClick={() => { setShowForm(false); setError(""); }}
                className="text-[#555] hover:text-[#999] text-xs transition-colors"
              >
                Cancel
              </button>
            </div>
            <div className="space-y-3">
              <input
                type="text"
                placeholder="Project name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
                className="notion-input"
              />
              <input
                type="url"
                placeholder="https://github.com/org/repo"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                required
                className="notion-input"
              />
            </div>
            {error && <p className="text-red-400 text-xs">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="notion-btn-primary"
            >
              {loading ? "Creating..." : "Create project"}
            </button>
          </form>
        )}
      </div>

      {/* Projects list */}
      {projects.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-[#555] uppercase tracking-widest mb-2 px-1">
            All projects
          </div>
          <div className="notion-panel overflow-hidden">
            {projects.map((project, i) => (
              <div
                key={project.id}
                onClick={() => onNavigate({ type: "project", project })}
                className={`group flex items-center gap-3 px-4 py-3 hover:bg-[#2d2d2d] cursor-pointer transition-colors ${
                  i < projects.length - 1 ? "border-b border-[#3d3d3d]" : ""
                }`}
              >
                <span className="text-xl flex-shrink-0">📁</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[#e5e5e5] truncate">{project.name}</p>
                  <p className="text-xs text-[#666] truncate mt-0.5">{project.repoUrl}</p>
                </div>
                <div className="flex items-center gap-3 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                  <span className="text-xs text-[#555]">
                    {new Date(project.createdAt).toLocaleDateString()}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Delete "${project.name}" and all its tasks?`)) {
                        onDeleteProject(project.id);
                      }
                    }}
                    className="text-[#555] hover:text-red-400 text-xs transition-colors px-1.5 py-0.5 rounded hover:bg-[#3d3d3d]"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {projects.length === 0 && !showForm && (
        <div className="text-center py-16 text-[#555]">
          <p className="text-sm">No projects yet. Create one to get started.</p>
        </div>
      )}
    </div>
  );
}
