import { Link } from 'react-router-dom';
import type { TaskDto } from '../lib/api';

const PRIORITY_LABEL = ['urgent', 'high', 'normal', 'low'] as const;

export function TaskCard({
  task,
  projectSlug,
  onDragStart,
  onDragEnd,
}: {
  task: TaskDto;
  projectSlug: string;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  return (
    <Link
      to={`/projects/${projectSlug}/tasks/${task.number}`}
      className={`task-card ${task.status === 'blocked' ? 'is-blocked' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', task.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <div className="task-id">
        {task.status === 'blocked' ? <span className="lock" title="Blocked by another task">🔒</span> : null}
        {task.identifier}
      </div>
      <div className="task-title">{task.title}</div>
      <div className="task-meta">
        <span className={`priority p-${task.priority}`}>
          {PRIORITY_LABEL[task.priority] ?? 'normal'}
        </span>
        {task.assignee ? <span className="assignee">{task.assignee}</span> : null}
      </div>
    </Link>
  );
}
