/**
 * Kanban board for a project. Empty in M1 — populated in M2 with columns:
 * Backlog · Ready · Running · Review · Done. Drag-and-drop drives status
 * transitions via /api/tasks/:id/transition.
 */

import { useParams } from 'react-router-dom';

export function Board() {
  const { slug } = useParams();
  return (
    <section className="page">
      <h1>Board · {slug}</h1>
      <p className="muted">Kanban columns and live updates land in M2 + M3.</p>
    </section>
  );
}
