import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useProjects } from '../lib/store';
import { NewProjectModal } from '../components/NewProjectModal';

export function Projects() {
  const { byId, loaded, load } = useProjects();
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const projects = Object.values(byId).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <section className="page">
      <header className="page-header">
        <h1>Projects</h1>
        <button onClick={() => setShowModal(true)}>+ New project</button>
      </header>

      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : projects.length === 0 ? (
        <p className="muted">
          No projects yet. Click <strong>New project</strong> to add one.
        </p>
      ) : (
        <ul className="project-list">
          {projects.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.slug}`}>
                <h3>{p.name}</h3>
                <code>{p.repoUrl}</code>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {showModal ? <NewProjectModal onClose={() => setShowModal(false)} /> : null}
    </section>
  );
}
