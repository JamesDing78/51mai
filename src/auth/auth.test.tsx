import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from './AuthProvider';
import { RequireAuth } from './RequireAuth';
import { clearCsrfToken, loginRedirect, logout, setCsrfToken } from './client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sessionResponse(user: { id: string; username: string; role: 'customer' | 'admin' }): Response {
  return jsonResponse(200, { data: { user, csrfToken: 'csrf-session' } });
}

function renderProtected(initialEntry: string, role?: 'customer' | 'admin') {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/login" element={<h1>登录页</h1>} />
          <Route path="*" element={<RequireAuth role={role}><div>受保护内容</div></RequireAuth>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCsrfToken();
});

describe('认证客户端与路由边界', () => {
  it('同源请求携带cookie凭证和内存CSRF，而不写入本地存储', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    setCsrfToken('csrf-in-memory');

    await logout();

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(requestInit.headers);
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-CSRF-Token')).toBe('csrf-in-memory');
    expect(requestInit.body).toBe('{}');
    expect(window.localStorage.length).toBe(0);
  });

  it('customer返回路径按pathname拒绝带query/hash的管理路径，但保留商品购买参数', () => {
    expect(loginRedirect('/admin?tab=products', 'customer')).toBe('/ucenter');
    expect(loginRedirect('/admin#top', 'customer')).toBe('/ucenter');
    expect(loginRedirect('/admin/products?tab=pending#top', 'customer')).toBe('/ucenter');
    expect(loginRedirect('/products/p-001?spec=sku-1&quantity=2#buy', 'customer')).toBe('/products/p-001?spec=sku-1&quantity=2#buy');
  });

  it('匿名访问受保护页只跳转登录，不闪现受保护内容', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, {
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    })));

    renderProtected('/orders?spec=sku-1&quantity=2#pay');

    expect(screen.queryByText('受保护内容')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '登录页' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
  });

  it('初始session网络失败显示可重试错误而不当作匿名', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network down'));
    vi.stubGlobal('fetch', fetchMock);

    renderProtected('/orders');

    expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法确认登录状态，请重试');
    expect(screen.queryByText('受保护内容')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('customer访问admin只显示无权限，不渲染后台内容', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sessionResponse({ id: 'u-1', username: 'customer-1', role: 'customer' })));

    renderProtected('/admin', 'admin');

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('无权限访问管理后台'));
    expect(screen.queryByText('受保护内容')).not.toBeInTheDocument();
  });

  it('网络错误重试后收到401才进入登录页', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderProtected('/checkout');

    await user.click(await screen.findByRole('button', { name: '重试' }));
    expect(await screen.findByRole('heading', { name: '登录页' })).toBeInTheDocument();
  });
});
