/**
 * Project settings: edit name, repo URL, default branch, concurrency limit,
 * and WORKFLOW.md in a plain textarea (SPEC §9.1 — Monaco was dropped in v2).
 * Saves via PATCH /api/projects/:id.
 */

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useProjects } from '../lib/store';

export function ProjectSettings() {
  const { slug } = useParams();
  const { bySlug, loaded: projectsLoaded, load: loadProjects, upsert } = useProjects();

  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [concurrencyLimit, setConcurrencyLimit] = useState(2);
  const [workflowMd, setWorkflowMd] = useState('');
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectsLoaded) void loadProjects();
  }, [projectsLoaded, loadProjects]);

  const project = slug ? bySlug[slug] : undefined;

  // Populate the form from a fresh GET once we know the project id (the list
  // payload carries workflowMd too, but a fresh read avoids stale edits).
  useEffect(() => {
    if (!project || loadedProjectId === project.id) return;
    void (async () => {
      try {
        const { project: fresh } = await api.getProject(project.id);
        setName(fresh.name);
        setRepoUrl(fresh.repoUrl);
        setDefaultBranch(fresh.defaultBranch);
        setConcurrencyLimit(fresh.concurrencyLimit);
        setWorkflowMd(fresh.workflowMd);
        setLoadedProjectId(fresh.id);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [project, loadedProjectId]);

  if (loadError) {
    return (
      <section className="page">
        <p className="error">{loadError}</p>
      </section>
    );
  }
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
  if (loadedProjectId !== project.id) {
    return (
      <section className="page">
        <p className="muted">Loading…</p>
      </section>
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!project || saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      const { project: updated } = await api.updateProject(project.id, {
        name,
        repoUrl,
        defaultBranch,
        concurrencyLimit,
        workflowMd,
      });
      upsert(updated);
      setFeedback({ kind: 'ok', text: 'Saved.' });
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="page settings">
      <Link to={`/projects/${project.slug}`} className="back">
        ← Board
      </Link>
      <header className="page-header">
        <h1>Settings · {project.name}</h1>
      </header>

      <form className="settings-form" onSubmit={save}>
        <div className="settings-grid">
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            Repo URL
            <input
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/org/repo"
              required
            />
          </label>
          <label>
            Default branch
            <input
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              required
            />
          </label>
          <label>
            Concurrency limit
            <input
              type="number"
              min={1}
              max={20}
              value={concurrencyLimit}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (!Number.isNaN(n)) setConcurrencyLimit(n);
              }}
              required
            />
          </label>
        </div>

        <label>
          WORKFLOW.md
          <span className="muted field-hint">
            The prompt template rendered into every agent run.
          </span>
          <textarea
            className="workflow-editor"
            value={workflowMd}
            onChange={(e) => setWorkflowMd(e.target.value)}
            spellCheck={false}
            rows={24}
          />
        </label>

        <div className="settings-actions">
          {feedback ? (
            <span className={feedback.kind === 'ok' ? 'save-ok' : 'error'}>{feedback.text}</span>
          ) : null}
          <button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </section>
  );
}
