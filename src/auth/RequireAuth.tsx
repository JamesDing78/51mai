import type { ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { safeReturnTo, type AuthRole } from './client';

export function RequireAuth({ role, children }: { role?: AuthRole; children: ReactNode }) {
  const { user, status, error, refresh } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <main className="shell page-space"><p role="status" aria-live="polite">正在确认登录状态…</p></main>;
  }

  if (status === 'error') {
    return <main className="shell page-space"><div className="auth-feedback error" role="alert">{error?.message ?? '暂时无法确认登录状态，请重试。'}</div><button className="primary" type="button" onClick={() => void refresh()}>重试</button></main>;
  }

  if (status === 'anonymous' || !user) {
    const returnTo = safeReturnTo(`${location.pathname}${location.search}${location.hash}`, '/ucenter');
    return <Navigate replace to={`/login?returnTo=${encodeURIComponent(returnTo)}`} />;
  }

  if (role && user.role !== role) {
    return <main className="shell page-space"><div className="auth-feedback error" role="alert">无权限访问管理后台。</div><p>当前账号没有管理员权限。</p><p><Link to="/">返回商城</Link> · <Link to="/ucenter">返回个人中心</Link></p></main>;
  }

  return <>{children}</>;
}
