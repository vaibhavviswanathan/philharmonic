import { useState } from "react";
import { type Project } from "../api.js";
import { type View } from "../types.js";

export function Sidebar({
  projects,
  view,
  onNavigate,
  onDeleteProject,
}: {
  projects: Project[];
  view: View;
  onNavigate: (v: View) => void;
  onDeleteProject: (id: string) => void;
}) {
  const activeProjectId = view.type === "project" ? view.project.id : null;

  return (
    <aside className="w-[240px] flex-shrink-0 bg-[#202020] border-r border-[#3d3d3d] flex flex-col h-full overflow-hidden select-none">
      {/* Workspace header */}
      <div className="flex items-center gap-2.5 px-3.5 py-3 border-b border-[#3d3d3d]">
        <div className="w-6 h-6 bg-blue-600 rounded-md flex items-center justify-center flex-shrink-0 shadow-sm">
          <span className="text-white text-[11px] font-bold">P</span>
        </div>
        <div className="flex-1 min-w-0">
          <span className="font-semibold text-sm text-[#e5e5e5] truncate block">Phil</span>
        </div>
        <span className="text-[10px] text-[#555] bg-[#2d2d2d] px-1.5 py-0.5 rounded font-medium">AI</span>
      </div>

      {/* Top nav items */}
      <div className="px-1.5 pt-2 pb-1 space-y-0.5">
        <NavItem
          icon={
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
          }
          label="Home"
          active={view.type === "projects"}
          onClick={() => onNavigate({ type: "projects" })}
        />
      </div>

      {/* Projects section */}
      <div className="flex-1 overflow-y-auto px-1.5 pt-3 pb-2">
        {projects.length > 0 && (
          <div className="mb-1 px-2">
            <span className="text-[10px] font-semibold text-[#555] uppercase tracking-widest">Projects</span>
          </div>
        )}
        <div className="space-y-0.5">
          {projects.map((project) => (
            <SidebarProject
              key={project.id}
              project={project}
              isActive={activeProjectId === project.id}
              onNavigate={onNavigate}
              onDelete={onDeleteProject}
            />
          ))}
        </div>
      </div>

      {/* Bottom */}
      <div className="px-1.5 pb-2 pt-1 border-t border-[#3d3d3d] space-y-0.5">
        <NavItem
          icon={
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          }
          label="Settings"
          active={view.type === "settings"}
          onClick={() => onNavigate({ type: "settings" })}
        />
      </div>
    </aside>
  );
}

function NavItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors text-left ${
        active
          ? "bg-[#2d2d2d] text-[#e5e5e5]"
          : "text-[#999] hover:bg-[#2d2d2d] hover:text-[#e5e5e5]"
      }`}
    >
      <span className="flex-shrink-0 opacity-80">{icon}</span>
      <span className="text-[13px]">{label}</span>
    </button>
  );
}

function SidebarProject({
  project,
  isActive,
  onNavigate,
  onDelete,
}: {
  project: Project;
  isActive: boolean;
  onNavigate: (v: View) => void;
  onDelete: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className={`group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors ${
        isActive ? "bg-[#2d2d2d] text-[#e5e5e5]" : "text-[#999] hover:bg-[#2d2d2d] hover:text-[#e5e5e5]"
      }`}
      onClick={() => onNavigate({ type: "project", project })}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="text-[14px] flex-shrink-0 opacity-80">📁</span>
      <span className="text-[13px] truncate flex-1">{project.name}</span>
      {hovered && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`Delete "${project.name}" and all its tasks?`)) {
              onDelete(project.id);
            }
          }}
          className="flex-shrink-0 w-4 h-4 flex items-center justify-center text-[#666] hover:text-red-400 rounded transition-colors"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
            <path d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}
