import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useBoard, useProjects } from '../lib/store';
import { Column } from '../components/Column';
import { NewTaskModal } from '../components/NewTaskModal';
import { connectProjectStream } from '../lib/ws';
import type { TaskStatus } from '../lib/api';

const COLUMNS: TaskStatus[] = ['backlog', 'blocked', 'ready', 'running', 'review', 'done'];

export function Board() {
  const { slug } = useParams();
  const { bySlug, loaded: projectsLoaded, load: loadProjects } = useProjects();
  const { tasks, projectId, loaded, load } = useBoard();
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    if (!projectsLoaded) void loadProjects();
  }, [projectsLoaded, loadProjects]);

  const project = slug ? bySlug[slug] : undefined;

  useEffect(() => {
    if (project && projectId !== project.id) {
      void load(project.id);
    }
  }, [project, projectId, load]);

  useEffect(() => {
    if (!project) return;
    const apply = useBoard.getState().applyWsMessage;
    const conn = connectProjectStream(project.slug, apply, () => {
      // On reconnect, refetch tasks so we don't miss messages from the gap.
      void useBoard.getState().load(project.id);
    });
    return () => conn.close();
  }, [project]);

  if (!project) {
    if (projectsLoaded) {
      return (
        <section className="page">
          <p className="muted">
            Project <code>{slug}</code> not found. <Link to="/projects">Back to projects</Link>
          </p>
        </section>
      );
    }
    return (
      <section className="page">
        <p className="muted">Loading…</p>
      </section>
    );
  }

  const tasksByStatus: Record<TaskStatus, typeof tasks[string][]> = {
    backlog: [],
    blocked: [],
    ready: [],
    running: [],
    review: [],
    done: [],
    cancelled: [],
  };
  for (const t of Object.values(tasks)) tasksByStatus[t.status].push(t);
  for (const status of COLUMNS) {
    tasksByStatus[status].sort((a, b) => a.priority - b.priority || b.createdAt - a.createdAt);
  }

  return (
    <section className="page">
      <header className="page-header">
        <h1>{project.name}</h1>
        <div className="board-actions">
          <Link to={`/projects/${project.slug}/settings`} className="ghost">
            Settings
          </Link>
          <button onClick={() => setShowModal(true)}>+ New task</button>
        </div>
      </header>

      {!loaded ? (
        <p className="muted">Loading tasks…</p>
      ) : (
        <div className="board">
          {COLUMNS.map((status) => (
            <Column
              key={status}
              status={status}
              tasks={tasksByStatus[status]}
              projectSlug={project.slug}
            />
          ))}
        </div>
      )}

      {showModal ? (
        <NewTaskModal projectId={project.id} onClose={() => setShowModal(false)} />
      ) : null}
    </section>
  );
}
