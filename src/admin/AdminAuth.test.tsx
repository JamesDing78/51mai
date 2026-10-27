import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { AdminDashboard, AdminLogin } from './AdminPages';

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function LocationText() {
  const location = useLocation();
  return <output aria-label="当前路径">{location.pathname}</output>;
}

function renderAdmin(page: React.ReactNode, initialEntry = '/admin/login') {
  return render(<AuthProvider><MemoryRouter initialEntries={[initialEntry]}>{page}<LocationText /></MemoryRouter></AuthProvider>);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('管理员真实认证接入', () => {
  it('管理员登录使用真实form并防止重复提交', async () => {
    const user = userEvent.setup();
    let resolveLogin: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === '/api/auth/session') return Promise.resolve(response(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } }));
      if (String(input) === '/api/admin/login') return new Promise<Response>((resolve) => { resolveLogin = resolve; });
      return Promise.resolve(response(404, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAdmin(<AdminLogin />, '/admin/login?returnTo=%2Fadmin%2Fproducts');

    await user.type(await screen.findByLabelText('管理员账号'), 'admin');
    await user.type(screen.getByLabelText('管理员密码'), 'valid-pass-1');
    const submit = screen.getByRole('button', { name: '登录后台' });
    await user.click(submit);
    await user.click(submit);
    expect(screen.getByRole('button', { name: '登录中…' })).toBeDisabled();
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/admin/login')).toHaveLength(1);
    resolveLogin?.(response(200, { data: { user: { id: 'a-1', username: 'admin', role: 'admin' }, csrfToken: 'csrf-admin' } }));
    await waitFor(() => expect(screen.getByLabelText('当前路径')).toHaveTextContent('/admin/products'));
  });

  it('已登录customer访问后台登录明确拒绝', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, { data: { user: { id: 'u-1', username: 'customer', role: 'customer' }, csrfToken: 'csrf-user' } })));
    renderAdmin(<AdminLogin />);

    expect(await screen.findByRole('alert')).toHaveTextContent('无权限访问管理后台');
    expect(screen.queryByLabelText('管理员账号')).not.toBeInTheDocument();
  });

  it('后台顶部显示真实用户名并在服务端退出成功后离开后台', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === '/api/auth/session') return Promise.resolve(response(200, { data: { user: { id: 'a-1', username: 'real-admin', role: 'admin' }, csrfToken: 'csrf-admin' } }));
      if (String(input) === '/api/auth/logout') return Promise.resolve(response(204));
      return Promise.resolve(response(404, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAdmin(<AdminDashboard />, '/admin');

    expect(await screen.findByText('real-admin')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '退出' }));
    await waitFor(() => expect(screen.getByLabelText('当前路径')).toHaveTextContent('/admin/login'));
    const logoutCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/auth/logout');
    expect(logoutCall).toBeDefined();
    const logoutInit = logoutCall?.[1] as RequestInit;
    const logoutHeaders = new Headers(logoutInit.headers);
    expect(logoutHeaders.get('Content-Type')).toBe('application/json');
    expect(logoutHeaders.get('X-CSRF-Token')).toBe('csrf-admin');
    expect(logoutInit.body).toBe('{}');
  });

  it('管理员凭证错误显示通用凭证提示', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === '/api/auth/session') return Promise.resolve(response(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } }));
      if (String(input) === '/api/admin/login') return Promise.resolve(response(401, { error: { code: 'AUTHENTICATION_FAILED', message: 'Invalid credentials' } }));
      return Promise.resolve(response(404, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAdmin(<AdminLogin />);

    await user.type(await screen.findByLabelText('管理员账号'), 'admin');
    await user.type(screen.getByLabelText('管理员密码'), 'wrong-pass');
    await user.click(screen.getByRole('button', { name: '登录后台' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('管理员账号或密码不正确');
  });

  it.each([
    ['服务暂不可用', () => Promise.resolve(response(503, { error: { code: 'SERVICE_UNAVAILABLE', message: 'service unavailable' } }))],
    ['网络故障', () => Promise.reject(new TypeError('network down'))],
  ])('管理员登录%s显示可重试提示', async (_label, loginResponse) => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === '/api/auth/session') return Promise.resolve(response(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } }));
      if (String(input) === '/api/admin/login') return loginResponse();
      return Promise.resolve(response(404, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAdmin(<AdminLogin />);

    await user.type(await screen.findByLabelText('管理员账号'), 'admin');
    await user.type(screen.getByLabelText('管理员密码'), 'valid-pass-1');
    await user.click(screen.getByRole('button', { name: '登录后台' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('暂时无法登录后台，请稍后重试');
    expect(alert).not.toHaveTextContent('管理员账号或密码不正确');
  });
});
