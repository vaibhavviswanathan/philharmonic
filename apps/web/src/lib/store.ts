/**
 * Zustand auth store. Tracks the result of `/api/me` so the app can route
 * between PostDeploySetup, the kanban board, and an error state.
 *
 * Project / run / event stores land in M2 + M3.
 */

import { create } from 'zustand';
import { api, type MeResponse } from './api';

type AuthState =
  | { status: 'loading' }
  | { status: 'setup_required'; hint: string }
  | { status: 'unauthenticated'; message: string }
  | { status: 'authenticated'; email: string; displayName: string };

interface AuthStore {
  auth: AuthState;
  refresh: () => Promise<void>;
}

export const useAuth = create<AuthStore>((set) => ({
  auth: { status: 'loading' },
  refresh: async () => {
    set({ auth: { status: 'loading' } });
    try {
      const res: MeResponse = await api.me();
      if ('setupRequired' in res && res.setupRequired) {
        set({ auth: { status: 'setup_required', hint: res.hint } });
        return;
      }
      set({
        auth: { status: 'authenticated', email: res.email, displayName: res.displayName },
      });
    } catch (err) {
      set({
        auth: {
          status: 'unauthenticated',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  },
}));
