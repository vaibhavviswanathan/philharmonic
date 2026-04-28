/**
 * Project settings: edit name, repo URL, default branch, concurrency limit,
 * and WORKFLOW.md (Monaco editor in M8). Stub in M1.
 */

import { useParams } from 'react-router-dom';

export function ProjectSettings() {
  const { slug } = useParams();
  return (
    <section className="page">
      <h1>Settings · {slug}</h1>
      <p className="muted">Project settings land in M2; WORKFLOW.md editor in M8.</p>
    </section>
  );
}
