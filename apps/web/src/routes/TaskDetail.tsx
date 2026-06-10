import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DependencyPicker } from '../components/DependencyPicker';
import { Markdown } from '../components/Markdown';
import {
  type ArtifactDto,
  type EventDto,
  type RunDto,
  type TaskDto,
  type TaskStatus,
  api,
} from '../lib/api';
import { useBoard, useProjects } from '../lib/store';
import { connectProjectStream } from '../lib/ws';

const ACTIVE_RUN_STATUSES = ['queued', 'preparing', 'running', 'landing'];

const STATUS_ACTIONS: Partial<Record<TaskStatus, { label: string; to: TaskStatus }[]>> = {
  backlog: [{ label: 'Run now', to: 'ready' }],
  ready: [{ label: 'Pause', to: 'backlog' }],
  review: [
    { label: 'Approve & merge', to: 'done' },
    { label: 'Send back', to: 'ready' },
  ],
};

export function TaskDetail() {
  const { slug, number } = useParams();
  const { bySlug, loaded: projectsLoaded, load: loadProjects } = useProjects();

  const [task, setTask] = useState<TaskDto | null>(null);
  const [latestRun, setLatestRun] = useState<RunDto | null>(null);
  const [runs, setRuns] = useState<RunDto[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactDto[]>([]);
  const [blockers, setBlockers] = useState<TaskDto[]>([]);
  const [blocking, setBlocking] = useState<TaskDto[]>([]);
  const [events, setEvents] = useState<EventDto[]>([]);
  const [comment, setComment] = useState('');
  const [commentError, setCommentError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);

  /**
   * Full refresh from the API. Self-contained on purpose: every action on
   * this page calls the API directly and applies the result locally, so deep
   * links work without the board store ever having been loaded (SPEC §9.1).
   */
  const loadDetail = useCallback(async (taskId: string) => {
    const detail = await api.getTask(taskId);
    setTask(detail.task);
    setLatestRun(detail.latestRun);
    setBlockers(detail.blockers);
    setBlocking(detail.blocking);
    // Keep the board store in sync when it happens to be loaded.
    if (useBoard.getState().projectId === detail.task.projectId) {
      useBoard.getState().upsertTask(detail.task);
    }
    const [ev, runList] = await Promise.all([api.listEvents(taskId), api.listRuns(taskId)]);
    setEvents(ev.events);
    setRuns(runList.runs.slice().sort((a, b) => b.createdAt - a.createdAt));
    if (detail.latestRun) {
      try {
        const runDetail = await api.getRun(detail.latestRun.id);
        setArtifacts(runDetail.artifacts);
      } catch {
        /* artifacts are best-effort */
      }
    } else {
      setArtifacts([]);
    }
  }, []);

  useEffect(() => {
    if (!projectsLoaded) void loadProjects();
  }, [projectsLoaded, loadProjects]);

  const project = slug ? bySlug[slug] : undefined;

  useEffect(() => {
    if (!project || !number) return;
    void (async () => {
      try {
        const { tasks } = await api.listTasks(project.id);
        const found = tasks.find((t) => t.number === Number.parseInt(number, 10));
        if (!found) {
          setError('Task not found');
          return;
        }
        await loadDetail(found.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [project, number, loadDetail]);

  // Live updates: subscribe to the project stream while the page is open
  // (SPEC §9.1) so agent comments and status changes appear without a reload.
  const taskId = task?.id;
  useEffect(() => {
    if (!project || !taskId) return;
    const conn = connectProjectStream(
      project.slug,
      (m) => {
        switch (m.type) {
          case 'task.created':
          case 'task.updated': {
            const t = m.task as unknown as TaskDto;
            if (t.id === taskId) setTask(t);
            break;
          }
          case 'event.created': {
            if (m.taskId !== taskId) break;
            const ev = m.event as unknown as EventDto;
            setEvents((prev) => (prev.some((e) => e.id === ev.id) ? prev : [ev, ...prev]));
            break;
          }
          case 'run.created':
          case 'run.updated': {
            const r = m.run as unknown as RunDto;
            if (r.taskId !== taskId) break;
            setRuns((prev) => {
              const i = prev.findIndex((p) => p.id === r.id);
              if (i === -1) return [r, ...prev];
              const next = prev.slice();
              next[i] = r;
              return next;
            });
            setLatestRun((prev) =>
              !prev || prev.id === r.id || r.createdAt >= prev.createdAt ? r : prev,
            );
            break;
          }
          default:
            break;
        }
      },
      () => {
        // Reconnected: refetch to fill the gap.
        void loadDetail(taskId).catch(() => {});
      },
    );
    return () => conn.close();
  }, [project, taskId, loadDetail]);

  if (error) {
    return (
      <section className="page">
        <p className="error">{error}</p>
      </section>
    );
  }
  if (!task || !project) {
    return (
      <section className="page">
        <p className="muted">Loading…</p>
      </section>
    );
  }

  const actions = STATUS_ACTIONS[task.status] ?? [];
  const canCancelRun =
    task.status === 'running' &&
    latestRun !== null &&
    ACTIVE_RUN_STATUSES.includes(latestRun.status);

  async function move(to: TaskStatus) {
    if (!task || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      // Direct API call + local apply — never depends on the board store.
      const { task: updated } = await api.transitionTask(task.id, to);
      setTask(updated);
      if (useBoard.getState().projectId === updated.projectId) {
        useBoard.getState().upsertTask(updated);
      }
      await loadDetail(updated.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  }

  async function cancelRun() {
    if (!task || !latestRun || actionBusy) return;
    if (!confirm('Cancel this run? The sandbox will be destroyed.')) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await api.cancelRun(latestRun.id);
      await loadDetail(task.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  }

  async function postComment(e: React.FormEvent) {
    e.preventDefault();
    if (!comment.trim() || !task || posting) return;
    setPosting(true);
    setCommentError(null);
    try {
      const { event } = await api.postComment(task.id, comment);
      setEvents((prev) => (prev.some((p) => p.id === event.id) ? prev : [event, ...prev]));
      setComment('');
    } catch (err) {
      // Keep the draft; surface the failure inline (SPEC §9.3).
      setCommentError(err instanceof Error ? err.message : String(err));
    } finally {
      setPosting(false);
    }
  }

  return (
    <section className="page task-detail">
      <Link to={`/projects/${project.slug}`} className="back">
        ← Board
      </Link>
      <header className="task-header">
        <div>
          <code className="task-id">{task.identifier}</code>
          <h1>{task.title}</h1>
          <p className="muted">
            <span className={`status-pill status-${task.status}`}>{task.status}</span> · filed by{' '}
            {task.createdBy}
          </p>
        </div>
        <div className="actions">
          {actions.map((a) => (
            <button type="button" key={a.to} disabled={actionBusy} onClick={() => move(a.to)}>
              {a.label}
            </button>
          ))}
          {canCancelRun ? (
            <button type="button" className="danger" disabled={actionBusy} onClick={cancelRun}>
              Cancel run
            </button>
          ) : null}
          {latestRun ? (
            <Link
              to={`/projects/${project.slug}/tasks/${task.number}/runs/${latestRun.id}`}
              className="ghost"
            >
              Run viewer
            </Link>
          ) : null}
        </div>
      </header>
      {actionError ? <p className="error action-error">{actionError}</p> : null}

      {task.status === 'blocked' && blockers.length === 0 ? (
        <p className="parked-notice">
          Manually parked — will not auto-resume. Move it back to Ready (or Backlog) when it should
          run again.
        </p>
      ) : null}

      {latestRun && artifacts.length > 0 ? (
        <section className="proof">
          <h2>Proof of work</h2>
          <ul>
            {artifacts.map((a) => (
              <li key={a.id}>
                <a href={api.artifactUrl(latestRun.id, a.id)} target="_blank" rel="noreferrer">
                  <span className={`artifact-kind kind-${a.kind}`}>{a.kind}</span>{' '}
                  {a.caption ?? a.r2Key.split('/').pop() ?? 'artifact'}
                  <span className="muted"> · {Math.ceil(a.sizeBytes / 1024)} KB</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="dependencies">
        <div className="deps-col">
          <header>
            <h3>Blocked by</h3>
            <button type="button" className="ghost small" onClick={() => setShowPicker(true)}>
              + Add blocker
            </button>
          </header>
          {blockers.length === 0 ? (
            <p className="muted">No blockers.</p>
          ) : (
            <ul className="dep-list">
              {blockers.map((b) => (
                <BlockerRow
                  key={b.id}
                  task={b}
                  projectSlug={project.slug}
                  onRemove={async () => {
                    await api.removeDependency(task.id, b.id);
                    await loadDetail(task.id);
                  }}
                />
              ))}
            </ul>
          )}
        </div>
        <div className="deps-col">
          <h3>Blocking</h3>
          {blocking.length === 0 ? (
            <p className="muted">Nothing depends on this.</p>
          ) : (
            <ul className="dep-list">
              {blocking.map((b) => (
                <li key={b.id}>
                  <Link to={`/projects/${project.slug}/tasks/${b.number}`}>
                    <code>{b.identifier}</code> {b.title}
                  </Link>
                  <span className={`status-pill status-${b.status}`}>{b.status}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {showPicker ? (
        <DependencyPicker
          task={task}
          currentBlockerIds={new Set(blockers.map((b) => b.id))}
          onClose={() => setShowPicker(false)}
          onAdded={() => loadDetail(task.id)}
        />
      ) : null}

      {task.description ? (
        <section className="task-body">
          <Markdown>{task.description}</Markdown>
        </section>
      ) : null}

      {runs.length > 0 ? (
        <section className="runs">
          <h2>Runs</h2>
          <ul className="run-list">
            {runs.map((r) => (
              <li key={r.id}>
                <Link to={`/projects/${project.slug}/tasks/${task.number}/runs/${r.id}`}>
                  <code>{r.id.slice(0, 8)}</code>
                </Link>
                <span className={`status-pill run-status-${r.status}`}>{r.status}</span>
                <span className="muted">{new Date(r.createdAt).toLocaleString()}</span>
                {r.prUrl ? (
                  <a href={r.prUrl} target="_blank" rel="noreferrer">
                    PR ↗
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="comment-form">
        <form onSubmit={postComment}>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Add a comment… (markdown supported)"
            rows={3}
          />
          {commentError ? <p className="error">Couldn't post comment: {commentError}</p> : null}
          <button type="submit" disabled={!comment.trim() || posting}>
            {posting ? 'Posting…' : 'Post'}
          </button>
        </form>
      </section>

      <section className="feed">
        <h2>Activity</h2>
        {events.length === 0 ? (
          <p className="muted">No events yet.</p>
        ) : (
          <ol>
            {events.map((e) => (
              <li key={e.id} className={`event event-${e.type}`}>
                <header>
                  <strong>{e.author}</strong>
                  <span className="muted">
                    {' · '}
                    {new Date(e.createdAt).toLocaleString()}
                  </span>
                </header>
                <EventBody event={e} />
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}

function BlockerRow({
  task,
  projectSlug,
  onRemove,
}: {
  task: TaskDto;
  projectSlug: string;
  onRemove: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <li>
      <Link to={`/projects/${projectSlug}/tasks/${task.number}`}>
        <code>{task.identifier}</code> {task.title}
      </Link>
      <span className={`status-pill status-${task.status}`}>{task.status}</span>
      <button
        type="button"
        className="ghost small"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onRemove();
          } finally {
            setBusy(false);
          }
        }}
        title="Remove this blocker"
      >
        ×
      </button>
    </li>
  );
}

function EventBody({ event }: { event: EventDto }) {
  switch (event.type) {
    case 'comment':
      return <Markdown>{(event.payload.body as string) ?? ''}</Markdown>;
    case 'status_change':
      return (
        <p className="muted">
          moved <code>{event.payload.from as string}</code> →{' '}
          <code>{event.payload.to as string}</code>
        </p>
      );
    case 'agent_action':
      return <p className="muted">agent: {(event.payload.summary as string) ?? ''}</p>;
    case 'proof':
      return <p className="muted">attached proof: {(event.payload.kind as string) ?? ''}</p>;
    case 'system':
      return <p className="muted">{(event.payload.message as string) ?? ''}</p>;
    default:
      return null;
  }
}
