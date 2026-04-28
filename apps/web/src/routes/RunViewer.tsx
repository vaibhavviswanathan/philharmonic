/**
 * Run viewer: live agent log, embedded sandbox preview iframe, PR link with
 * CI status. Stub in M1; agent + log streaming in M5/M6.
 */

import { useParams } from 'react-router-dom';

export function RunViewer() {
  const { slug, number, runId } = useParams();
  return (
    <section className="page">
      <h1>
        Run {runId} · {slug} PHIL-{number}
      </h1>
      <p className="muted">Live agent log + preview iframe land in M5/M6.</p>
    </section>
  );
}
