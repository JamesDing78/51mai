import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ApiError,
  clearCsrfToken,
  getSession,
  logout as logoutRequest,
  setCsrfToken,
  type AuthSession,
  type AuthUser,
} from './client';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'error';

interface AuthError {
  message: string;
  network: boolean;
}

export interface AuthContextValue {
  user: AuthUser | null;
  status: AuthStatus;
  error: AuthError | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  setSession: (session: AuthSession) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function errorState(error: unknown): AuthError {
  return {
    message: error instanceof ApiError && error.isNetwork ? '暂时无法确认登录状态，请重试。' : '暂时无法确认登录状态，请重试。',
    network: error instanceof ApiError ? error.isNetwork : true,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [error, setError] = useState<AuthError | null>(null);
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const cancelPending = useCallback(() => {
    requestId.current += 1;
    controller.current?.abort();
    controller.current = null;
  }, []);

  const setSession = useCallback((session: AuthSession) => {
    cancelPending();
    setCsrfToken(session.csrfToken);
    setUser(session.user);
    setError(null);
    setStatus('authenticated');
  }, [cancelPending]);

  const refresh = useCallback(async () => {
    cancelPending();
    const currentId = requestId.current;
    const nextController = new AbortController();
    controller.current = nextController;
    setStatus('loading');
    setError(null);
    try {
      const session = await getSession(nextController.signal);
      if (currentId !== requestId.current) return;
      setCsrfToken(session.csrfToken);
      setUser(session.user);
      setStatus('authenticated');
    } catch (caught) {
      if (nextController.signal.aborted || currentId !== requestId.current) return;
      if (caught instanceof ApiError && caught.status === 401) {
        clearCsrfToken();
        setUser(null);
        setStatus('anonymous');
        return;
      }
      setUser(null);
      setStatus('error');
      setError(errorState(caught));
    } finally {
      if (currentId === requestId.current) controller.current = null;
    }
  }, [cancelPending]);

  const logout = useCallback(async () => {
    cancelPending();
    try {
      await logoutRequest();
      clearCsrfToken();
      setUser(null);
      setError(null);
      setStatus('anonymous');
    } catch (caught) {
      setError({ message: '退出失败，请重试。', network: caught instanceof ApiError && caught.isNetwork });
      throw caught;
    }
  }, [cancelPending]);

  useEffect(() => {
    void refresh();
    return () => cancelPending();
  }, [cancelPending, refresh]);

  const value = useMemo<AuthContextValue>(() => ({ user, status, error, refresh, logout, setSession }), [error, logout, refresh, setSession, status, user]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
