/**
 * Project list. Empty in M1 — wired to /api/projects in M2.
 */

export function Projects() {
  return (
    <section className="page">
      <h1>Projects</h1>
      <p className="muted">
        No projects yet. Create one in M2 — this list reads from <code>/api/projects</code>.
      </p>
    </section>
  );
}
