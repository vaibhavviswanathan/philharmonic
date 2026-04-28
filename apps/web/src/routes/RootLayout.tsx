/**
 * App shell with a top bar showing the signed-in user. Child routes render
 * inside `<main>`. Real navigation (project switcher, etc.) lands in M2.
 */

import { Link, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/store';

export function RootLayout() {
  const auth = useAuth((s) => s.auth);
  const displayName =
    auth.status === 'authenticated' ? auth.displayName : '…';

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          🎼 Philharmonic
        </Link>
        <div className="user">{displayName}</div>
      </header>
      <Outlet />
    </div>
  );
}
