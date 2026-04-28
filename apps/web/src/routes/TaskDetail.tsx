import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type ArtifactDto, type EventDto, type RunDto, type TaskDto, type TaskStatus } from '../lib/api';
import { useBoard, useProjects } from '../lib/store';

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
  const { transition } = useBoard();

  const [task, setTask] = useState<TaskDto | null>(null);
  const [latestRun, setLatestRun] = useState<RunDto | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactDto[]>([]);
  const [events, setEvents] = useState<EventDto[]>([]);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);

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
        setTask(found);
        const detail = await api.getTask(found.id);
        setLatestRun(detail.latestRun);
        if (detail.latestRun) {
          try {
            const runDetail = await api.getRun(detail.latestRun.id);
            setArtifacts(runDetail.artifacts);
          } catch {
            /* artifacts are best-effort */
          }
        }
        const ev = await api.listEvents(found.id);
        setEvents(ev.events);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [project, number]);

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

  async function move(to: TaskStatus) {
    if (!task) return;
    try {
      await transition(task.id, to);
      const detail = await api.getTask(task.id);
      setTask(detail.task);
      setLatestRun(detail.latestRun);
      const ev = await api.listEvents(task.id);
      setEvents(ev.events);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  async function postComment(e: React.FormEvent) {
    e.preventDefault();
    if (!comment.trim() || !task) return;
    const { event } = await api.postComment(task.id, comment);
    setEvents((prev) => [event, ...prev]);
    setComment('');
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
            <span className={`status-pill status-${task.status}`}>{task.status}</span>{' '}
            · filed by {task.createdBy}
          </p>
        </div>
        <div className="actions">
          {actions.map((a) => (
            <button key={a.to} onClick={() => move(a.to)}>
              {a.label}
            </button>
          ))}
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

      {artifacts.length > 0 ? (
        <section className="proof">
          <h2>Proof of work</h2>
          <ul>
            {artifacts.map((a) => (
              <li key={a.id}>
                <a
                  href={api.artifactUrl(latestRun!.id, a.id)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className={`artifact-kind kind-${a.kind}`}>{a.kind}</span>{' '}
                  {a.caption ?? a.r2Key.split('/').pop() ?? 'artifact'}
                  <span className="muted"> · {Math.ceil(a.sizeBytes / 1024)} KB</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {task.description ? (
        <section className="task-body">
          <pre>{task.description}</pre>
        </section>
      ) : null}

      <section className="comment-form">
        <form onSubmit={postComment}>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Add a comment…"
            rows={3}
          />
          <button type="submit" disabled={!comment.trim()}>
            Post
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

function EventBody({ event }: { event: EventDto }) {
  switch (event.type) {
    case 'comment':
      return <p>{(event.payload.body as string) ?? ''}</p>;
    case 'status_change':
      return (
        <p className="muted">
          moved <code>{event.payload.from as string}</code> → <code>{event.payload.to as string}</code>
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
