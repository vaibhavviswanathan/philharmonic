/**
 * Root component. Boots by hitting /api/me; shows PostDeploySetup if Access
 * isn't configured, an error screen if the request failed, or the routed app
 * once authenticated.
 */

import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/store';
import { PostDeploySetup } from './routes/PostDeploySetup';
import { RootLayout } from './routes/RootLayout';
import { Projects } from './routes/Projects';
import { Board } from './routes/Board';
import { TaskDetail } from './routes/TaskDetail';
import { RunViewer } from './routes/RunViewer';
import { ProjectSettings } from './routes/ProjectSettings';

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
          If you reached this page, Cloudflare Access should have shown its login screen first.
          Try refreshing.
        </p>
      </div>
    );
  }

  return (
    <Routes>
      <Route element={<RootLayout />}>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:slug" element={<Board />} />
        <Route path="/projects/:slug/tasks/:number" element={<TaskDetail />} />
        <Route
          path="/projects/:slug/tasks/:number/runs/:runId"
          element={<RunViewer />}
        />
        <Route path="/projects/:slug/settings" element={<ProjectSettings />} />
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Route>
    </Routes>
  );
}
