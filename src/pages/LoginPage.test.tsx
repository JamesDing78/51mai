import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import LoginPage from './LoginPage';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function policyResponse(): Response {
  return jsonResponse(200, {
    data: {
      termsVersion: 'terms-v1',
      privacyVersion: 'privacy-v1',
      termsUrl: '/terms',
      privacyUrl: '/privacy',
    },
  });
}

function anonymousFetch(extra: (url: string, init: RequestInit) => Response | Promise<Response> = () => jsonResponse(404, {})) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/session') return Promise.resolve(jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } }));
    if (url === '/api/auth/policies') return Promise.resolve(policyResponse());
    return Promise.resolve(extra(url, init ?? {}));
  });
}

function LocationText() {
  const location = useLocation();
  return <output aria-label="当前路径">{location.pathname}{location.search}{location.hash}</output>;
}

function renderLogin(initialEntry = '/login') {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LoginPage />
        <LocationText />
      </MemoryRouter>
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('F05 登录与注册', () => {
  it('默认展示账号密码登录并移除未确认的第三方登录入口', async () => {
    vi.stubGlobal('fetch', anonymousFetch());
    renderLogin();

    expect(screen.getByRole('heading', { name: '欢迎来到 51mai' })).toBeInTheDocument();
    expect(screen.getByLabelText('账号 / 手机号 / 邮箱')).toBeInTheDocument();
    expect(screen.getByLabelText('密码')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '注册' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '微信登录' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '支付宝登录' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Google 登录' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('密码')).toBeInTheDocument());
  });

  it('密码登录调用真实API并将服务端错误展示为可理解提示', async () => {
    const user = userEvent.setup();
    const fetchMock = anonymousFetch((url) => url === '/api/auth/login'
      ? jsonResponse(401, { error: { code: 'AUTHENTICATION_FAILED', message: 'Invalid credentials' } })
      : jsonResponse(404, {}));
    vi.stubGlobal('fetch', fetchMock);
    renderLogin();

    await user.type(screen.getByLabelText('账号 / 手机号 / 邮箱'), 'demo-user');
    await user.type(screen.getByLabelText('密码'), 'valid-pass-1');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('账号或密码不正确');
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
  });

  it('验证码登录要求当前协议同意，发送失败不显示已发送或开始假倒计时', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', anonymousFetch((url) => url === '/api/auth/challenges'
      ? jsonResponse(503, { error: { code: 'SERVICE_UNAVAILABLE', message: 'Verification service unavailable' } })
      : jsonResponse(404, {})));
    renderLogin();

    await user.click(screen.getByRole('tab', { name: '验证码登录' }));
    expect(await screen.findByText('未注册的手机号/邮箱验证后将创建本站账号并登录')).toBeInTheDocument();
    expect(screen.getByLabelText('同意用户协议和隐私政策')).not.toBeChecked();
    await user.type(screen.getByLabelText('手机号或邮箱'), 'demo@example.com');
    await user.click(screen.getByRole('button', { name: '获取验证码' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('验证码服务暂不可用，请稍后重试');
    expect(screen.queryByText(/验证码请求已受理/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '获取验证码' })).toBeEnabled();

    await user.type(screen.getByLabelText('6位验证码'), '123456');
    await user.click(screen.getByRole('button', { name: '登录' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请先获取验证码');
  });

  it('验证码登录认证失败提示重新获取验证码而不是密码错误', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', anonymousFetch((url) => {
      if (url === '/api/auth/challenges') return jsonResponse(202, { data: { challengeId: 'challenge-1' } });
      if (url === '/api/auth/code-login') return jsonResponse(401, { error: { code: 'AUTHENTICATION_FAILED', message: 'Invalid credentials' } });
      return jsonResponse(404, {});
    }));
    renderLogin();

    await user.click(screen.getByRole('tab', { name: '验证码登录' }));
    await user.type(screen.getByLabelText('手机号或邮箱'), 'demo@example.com');
    await user.click(screen.getByRole('button', { name: '获取验证码' }));
    expect(await screen.findByText('验证码请求已受理，请留意手机或邮箱。')).toBeInTheDocument();
    await user.click(screen.getByLabelText('同意用户协议和隐私政策'));
    await user.type(screen.getByLabelText('6位验证码'), '123456');
    await user.click(screen.getByRole('button', { name: '登录' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('验证码错误或已失效，请重新获取');
    expect(alert).not.toHaveTextContent('密码');
  });

  it('注册默认未同意协议，成功后保留商品returnTo且不发送推荐人字段', async () => {
    const user = userEvent.setup();
    const fetchMock = anonymousFetch((url, init) => {
      if (url === '/api/auth/register') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body.referrerId).toBeUndefined();
        return jsonResponse(201, { data: { user: { id: 'u-1', username: 'demo-user', role: 'customer' }, csrfToken: 'csrf-1' } });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    renderLogin('/login?returnTo=%2Fproducts%2Fp-001%3Fspec%3Dsku%26quantity%3D2%23buy');

    await user.click(screen.getByRole('tab', { name: '注册' }));
    await user.type(screen.getByLabelText('注册账号'), 'demo-user');
    await user.type(screen.getByLabelText('新密码'), 'valid-pass-1');
    await user.type(screen.getByLabelText('确认新密码'), 'valid-pass-1');
    await user.type(screen.getByLabelText('推荐人ID'), 'REF-001');
    await user.click(screen.getByRole('button', { name: '注册' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请先阅读并同意');

    await user.click(screen.getByLabelText('同意用户协议和隐私政策'));
    await user.click(screen.getByRole('button', { name: '注册' }));
    await waitFor(() => expect(screen.getByLabelText('当前路径')).toHaveTextContent('/products/p-001?spec=sku&quantity=2#buy'));
  });

  it('注册请求未完成时按钮禁用且连续提交只发送一次', async () => {
    const user = userEvent.setup();
    let resolveRegister: ((response: Response) => void) | undefined;
    const fetchMock = anonymousFetch((url) => {
      if (url === '/api/auth/register') return new Promise<Response>((resolve) => { resolveRegister = resolve; });
      return jsonResponse(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    renderLogin();

    await user.click(screen.getByRole('tab', { name: '注册' }));
    await user.type(screen.getByLabelText('注册账号'), 'demo-user');
    await user.type(screen.getByLabelText('新密码'), 'valid-pass-1');
    await user.type(screen.getByLabelText('确认新密码'), 'valid-pass-1');
    await user.click(screen.getByLabelText('同意用户协议和隐私政策'));
    const submit = screen.getByRole('button', { name: '注册' });
    await user.click(submit);
    await user.click(submit);
    expect(screen.getByRole('button', { name: '注册中…' })).toBeDisabled();
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/auth/register')).toHaveLength(1);
    resolveRegister?.(jsonResponse(201, { data: { user: { id: 'u-1', username: 'demo-user', role: 'customer' }, csrfToken: 'csrf-1' } }));
    await waitFor(() => expect(screen.getByLabelText('当前路径')).toHaveTextContent('/ucenter'));
  });

  it('找回密码要求验证码与新密码确认，并使用reset-password合同', async () => {
    const user = userEvent.setup();
    const fetchMock = anonymousFetch((url) => url === '/api/auth/reset-password'
      ? jsonResponse(204, undefined)
      : jsonResponse(404, {}));
    vi.stubGlobal('fetch', fetchMock);
    renderLogin();

    await user.click(screen.getByRole('button', { name: '忘记密码？' }));
    expect(screen.getByRole('button', { name: '重置密码' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重置密码' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请输入6位数字验证码');
    expect(screen.getByRole('alert')).toHaveTextContent('密码长度为 8–20 位');
  });
});
