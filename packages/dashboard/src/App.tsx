import { useEffect, useState, useCallback, useRef } from "react";
import { listProjects, deleteProject, type Project } from "./api.js";
import { NewProjectForm } from "./components/NewProjectForm.js";
import { ProjectView } from "./components/ProjectView.js";
import { SettingsPanel } from "./components/SettingsPanel.js";

type View = { type: "projects" } | { type: "project"; project: Project } | { type: "settings" };

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
    const data = view.type === "project"
      ? { type: "project", projectId: view.project.id }
      : { type: view.type };
    localStorage.setItem(ROUTE_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
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

  // Restore project view after projects load
  useEffect(() => {
    const r = storedRoute.current;
    if (r?.type === "project" && r.projectId && projects.length > 0) {
      const project = projects.find((p) => p.id === r.projectId);
      if (project) {
        storedRoute.current = null; // only restore once
        setView({ type: "project", project });
      }
    }
  }, [projects]);

  if (view.type === "settings") {
    return (
      <div className="min-h-screen max-w-6xl mx-auto p-6 space-y-6">
        <Header onSettings={() => navigate({ type: "settings" })} />
        <SettingsPanel onBack={() => navigate({ type: "projects" })} />
      </div>
    );
  }

  if (view.type === "project") {
    return (
      <div className="min-h-screen max-w-6xl mx-auto p-6 space-y-6">
        <Header onSettings={() => navigate({ type: "settings" })} />
        <ProjectView
          project={view.project}
          onBack={() => { navigate({ type: "projects" }); refresh(); }}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen max-w-6xl mx-auto p-6 space-y-6">
      <Header onSettings={() => navigate({ type: "settings" })} />

      <NewProjectForm onCreated={refresh} />

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">
          Projects {projects.length > 0 && `(${projects.length})`}
        </h2>
        {projects.length === 0 && (
          <p className="text-gray-500 text-sm">No projects yet. Add one above.</p>
        )}
        {projects.map((project) => (
          <div
            key={project.id}
            onClick={() => navigate({ type: "project", project })}
            className="p-4 bg-gray-900 rounded-lg border border-gray-800 hover:border-gray-600 cursor-pointer transition-colors group"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{project.name}</p>
                <p className="text-sm text-gray-400 mt-0.5">{project.repoUrl}</p>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete project "${project.name}" and all its tasks?`)) {
                    deleteProject(project.id).then(refresh);
                  }
                }}
                className="text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity text-sm px-2"
              >
                Delete
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Created {new Date(project.createdAt).toLocaleDateString()}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function Header({ onSettings }: { onSettings: () => void }) {
  return (
    <header className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">Phil</h1>
        <span className="text-sm text-gray-500">AI Coding Agent</span>
      </div>
      <button
        onClick={onSettings}
        className="text-sm text-gray-400 hover:text-white"
      >
        Settings
      </button>
    </header>
  );
}
