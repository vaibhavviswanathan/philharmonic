import { useEffect, useState } from 'react';
import { api, type TaskDto } from '../lib/api';

/**
 * Minimal "add a blocker" picker. Lists every task in the same project except
 * self, current blockers, and terminal-state tasks (done/cancelled — those are
 * already resolved so adding them would be a no-op).
 *
 * On select, calls POST /api/tasks/:id/dependencies and reports back via
 * onAdded so the parent can refresh.
 */
export function DependencyPicker({
  task,
  currentBlockerIds,
  onClose,
  onAdded,
}: {
  task: TaskDto;
  currentBlockerIds: Set<string>;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [candidates, setCandidates] = useState<TaskDto[] | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const { tasks } = await api.listTasks(task.projectId);
      setCandidates(
        tasks.filter(
          (t) =>
            t.id !== task.id &&
            !currentBlockerIds.has(t.id) &&
            t.status !== 'done' &&
            t.status !== 'cancelled',
        ),
      );
    })();
  }, [task.projectId, task.id, currentBlockerIds]);

  async function add(blocker: TaskDto) {
    setSubmitting(blocker.id);
    setError(null);
    try {
      await api.addDependency(task.id, blocker.id);
      onAdded();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(null);
    }
  }

  const filtered = candidates?.filter(
    (t) =>
      t.title.toLowerCase().includes(filter.toLowerCase()) ||
      t.identifier.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal dep-picker" onClick={(e) => e.stopPropagation()}>
        <h2>Add a blocker</h2>
        <input
          autoFocus
          placeholder="Search by ID or title…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {!candidates ? (
          <p className="muted">Loading…</p>
        ) : filtered && filtered.length === 0 ? (
          <p className="muted">No eligible tasks.</p>
        ) : (
          <ul className="dep-options">
            {filtered?.slice(0, 30).map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => add(t)}
                  disabled={submitting === t.id}
                  className="ghost wide"
                >
                  <code>{t.identifier}</code> {t.title}
                  <span className={`status-pill status-${t.status}`}>{t.status}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {error ? <p className="error">{error}</p> : null}
        <div className="actions">
          <button type="button" onClick={onClose} className="ghost">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
