/**
 * Task detail page: title, description, activity feed, proof-of-work artifacts,
 * and the action buttons described in SPEC §9.1. Stub in M1.
 */

import { useParams } from 'react-router-dom';

export function TaskDetail() {
  const { slug, number } = useParams();
  return (
    <section className="page">
      <h1>
        {slug} · PHIL-{number}
      </h1>
      <p className="muted">Task detail lands in M2.</p>
    </section>
  );
}
