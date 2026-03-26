import { useEffect, useState, useCallback } from "react";
import { listProjects, deleteProject, type Project } from "./api.js";
import { NewProjectForm } from "./components/NewProjectForm.js";
import { ProjectView } from "./components/ProjectView.js";
import { SettingsPanel } from "./components/SettingsPanel.js";

type View = { type: "projects" } | { type: "project"; project: Project } | { type: "settings" };

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [view, setView] = useState<View>({ type: "projects" });

  const refresh = useCallback(() => {
    listProjects().then(setProjects).catch(console.error);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (view.type === "settings") {
    return (
      <div className="min-h-screen max-w-3xl mx-auto p-6 space-y-6">
        <Header onSettings={() => {}} />
        <SettingsPanel onBack={() => setView({ type: "projects" })} />
      </div>
    );
  }

  if (view.type === "project") {
    return (
      <div className="min-h-screen max-w-3xl mx-auto p-6 space-y-6">
        <Header onSettings={() => setView({ type: "settings" })} />
        <ProjectView
          project={view.project}
          onBack={() => { setView({ type: "projects" }); refresh(); }}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen max-w-3xl mx-auto p-6 space-y-6">
      <Header onSettings={() => setView({ type: "settings" })} />

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
            onClick={() => setView({ type: "project", project })}
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
