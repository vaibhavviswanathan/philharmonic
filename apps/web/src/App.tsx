/**
 * Root component. Boots by hitting /api/me; shows PostDeploySetup if Access
 * isn't configured, an error screen if the request failed, or the routed app
 * once authenticated.
 */

import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth, useProjects } from './lib/store';
import { Board } from './routes/Board';
import { PostDeploySetup } from './routes/PostDeploySetup';
import { ProjectSettings } from './routes/ProjectSettings';
import { Projects } from './routes/Projects';
import { RootLayout } from './routes/RootLayout';
import { RunViewer } from './routes/RunViewer';
import { TaskDetail } from './routes/TaskDetail';

export function App() {
  const auth = useAuth((s) => s.auth);
  const refresh = useAuth((s) => s.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (auth.status === 'loading') {
    return <div className="splash">Loading…</div>;
  }
  if (auth.status === 'setup_required') {
    return <PostDeploySetup hint={auth.hint} />;
  }
  if (auth.status === 'unauthenticated') {
    return (
      <div className="splash error">
        <h1>Sign-in required</h1>
        <p>{auth.message}</p>
        <p className="muted">
          If you reached this page, Cloudflare Access should have shown its login screen first. Try
          refreshing.
        </p>
      </div>
    );
  }

  return (
    <Routes>
      <Route element={<RootLayout />}>
        <Route path="/" element={<Home />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:slug" element={<Board />} />
        <Route path="/projects/:slug/tasks/:number" element={<TaskDetail />} />
        <Route path="/projects/:slug/tasks/:number/runs/:runId" element={<RunViewer />} />
        <Route path="/projects/:slug/settings" element={<ProjectSettings />} />
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Route>
    </Routes>
  );
}

/**
 * `/` — redirects to the board when exactly one project exists (after the
 * project list loads); otherwise to the project list. SPEC §9.1.
 */
function Home() {
  const { byId, loaded, load } = useProjects();
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!loaded) {
      load().catch(() => setLoadFailed(true));
    }
  }, [loaded, load]);

  if (loadFailed) return <Navigate to="/projects" replace />;
  if (!loaded) {
    return (
      <section className="page">
        <p className="muted">Loading…</p>
      </section>
    );
  }
  const projects = Object.values(byId);
  const only = projects.length === 1 ? projects[0] : undefined;
  if (only) {
    return <Navigate to={`/projects/${only.slug}`} replace />;
  }
  return <Navigate to="/projects" replace />;
}
