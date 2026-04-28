import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type ArtifactDto, type RunDto } from '../lib/api';
import { connectProjectStream } from '../lib/ws';
import { useProjects } from '../lib/store';

export function RunViewer() {
  const { slug, number, runId } = useParams();
  const { bySlug, loaded: projectsLoaded, load: loadProjects } = useProjects();
  const project = slug ? bySlug[slug] : undefined;

  const [run, setRun] = useState<RunDto | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactDto[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const logBox = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!projectsLoaded) void loadProjects();
  }, [projectsLoaded, loadProjects]);

  useEffect(() => {
    if (!runId) return;
    void (async () => {
      try {
        const detail = await api.getRun(runId);
        setRun(detail.run);
        setArtifacts(detail.artifacts);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [runId]);

  useEffect(() => {
    if (!project || !runId) return;
    const conn = connectProjectStream(project.slug, (m) => {
      if (m.type === 'run.log' && m.runId === runId) {
        setLogs((prev) => [...prev, ...m.lines]);
      }
      if (m.type === 'run.updated' && m.run.id === runId) {
        setRun(m.run);
      }
    });
    // Opt-in to log streaming for this run.
    conn.send({ type: 'subscribe.run', runId });
    return () => {
      conn.send({ type: 'unsubscribe.run', runId });
      conn.close();
    };
  }, [project, runId]);

  useEffect(() => {
    if (!autoScroll || !logBox.current) return;
    logBox.current.scrollTop = logBox.current.scrollHeight;
  }, [logs, autoScroll]);

  function onLogScroll() {
    if (!logBox.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logBox.current;
    setAutoScroll(scrollTop + clientHeight >= scrollHeight - 20);
  }

  async function cancel() {
    if (!run) return;
    if (!confirm('Cancel this run? The sandbox will be destroyed.')) return;
    try {
      await api.cancelRun(run.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  if (error) {
    return (
      <section className="page">
        <p className="error">{error}</p>
      </section>
    );
  }
  if (!run || !project) {
    return (
      <section className="page">
        <p className="muted">Loading…</p>
      </section>
    );
  }

  const active = ['queued', 'preparing', 'running', 'landing'].includes(run.status);

  return (
    <section className="page run-viewer">
      <Link to={`/projects/${project.slug}/tasks/${number}`} className="back">
        ← Task PHIL-{number}
      </Link>

      <header className="run-header">
        <div>
          <h1>Run {run.id.slice(0, 8)}</h1>
          <p className="muted">
            <span className={`status-pill run-status-${run.status}`}>{run.status}</span>{' '}
            · started {run.startedAt ? new Date(run.startedAt).toLocaleTimeString() : '—'}
            {run.endedAt ? ` · ended ${new Date(run.endedAt).toLocaleTimeString()}` : ''}
          </p>
        </div>
        <div className="run-actions">
          {run.prUrl ? (
            <a href={run.prUrl} target="_blank" rel="noreferrer" className="ghost">
              Open PR ↗
            </a>
          ) : null}
          {active ? (
            <button className="danger" onClick={cancel}>
              Cancel run
            </button>
          ) : null}
        </div>
      </header>

      {run.errorMessage ? (
        <pre className="error-message">{run.errorMessage}</pre>
      ) : null}

      <section className="logs">
        <header>
          <h2>Live agent log</h2>
          {!autoScroll ? (
            <button onClick={() => setAutoScroll(true)} className="ghost small">
              ↓ jump to latest
            </button>
          ) : null}
        </header>
        <div className="log-box" ref={logBox} onScroll={onLogScroll}>
          {logs.length === 0 ? (
            <p className="muted">
              {active ? 'Waiting for output…' : 'No log lines streamed for this run.'}
            </p>
          ) : (
            <pre>{logs.join('\n')}</pre>
          )}
        </div>
      </section>

      {artifacts.length > 0 ? (
        <section className="artifacts">
          <h2>Proof of work</h2>
          <ul>
            {artifacts.map((a) => (
              <li key={a.id}>
                <a
                  href={api.artifactUrl(run.id, a.id)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className={`artifact-kind kind-${a.kind}`}>{a.kind}</span>
                  <span className="artifact-meta">
                    {a.caption ?? a.r2Key.split('/').pop() ?? 'artifact'}
                    <span className="muted"> · {Math.ceil(a.sizeBytes / 1024)} KB</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
