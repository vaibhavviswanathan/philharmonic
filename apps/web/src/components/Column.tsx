import { useState } from 'react';
import { TaskCard } from './TaskCard';
import { useBoard } from '../lib/store';
import type { TaskDto, TaskStatus } from '../lib/api';

const TITLES: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  running: 'Running',
  review: 'Review',
  done: 'Done',
  cancelled: 'Cancelled',
};

export function Column({
  status,
  tasks,
  projectSlug,
}: {
  status: TaskStatus;
  tasks: TaskDto[];
  projectSlug: string;
}) {
  const transition = useBoard((s) => s.transition);
  const [hover, setHover] = useState(false);
  const [draggingFrom, setDraggingFrom] = useState<string | null>(null);

  return (
    <div
      className={`column ${hover ? 'hover' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setHover(true);
      }}
      onDragLeave={() => setHover(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setHover(false);
        const taskId = e.dataTransfer.getData('text/plain');
        if (!taskId) return;
        try {
          await transition(taskId, status);
        } catch (err) {
          alert(`Couldn't move task: ${err instanceof Error ? err.message : String(err)}`);
        }
      }}
    >
      <header className={`col-header status-${status}`}>
        <span>{TITLES[status]}</span>
        <span className="count">{tasks.length}</span>
      </header>
      <div className="col-body">
        {tasks.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            projectSlug={projectSlug}
            onDragStart={() => setDraggingFrom(t.id)}
            onDragEnd={() => setDraggingFrom(null)}
          />
        ))}
        {tasks.length === 0 ? <p className="empty">—</p> : null}
      </div>
      {draggingFrom ? null : null}
    </div>
  );
}
