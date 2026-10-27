import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NewLegalPage from './NewLegalPage';

function policyResponse(): Response {
  return new Response(JSON.stringify({ data: {
    termsVersion: 'terms-v1',
    privacyVersion: 'privacy-v1',
    termsUrl: '/terms',
    privacyUrl: '/privacy',
  } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('本站协议页面', () => {
  it('从真实policies读取版本并保留回登录returnTo', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(policyResponse()));
    render(<MemoryRouter initialEntries={['/terms?returnTo=%2Fproducts%2Fp-001%3Fquantity%3D2']}><NewLegalPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: '用户协议' })).toBeInTheDocument();
    expect(screen.getByText('当前版本：terms-v1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '返回登录' })).toHaveAttribute('href', '/login?returnTo=%2Fproducts%2Fp-001%3Fquantity%3D2');
    expect(screen.getByText(/购买前请核对商品名称、规格、数量和价格/)).toBeInTheDocument();
  });

  it('policies加载失败时不编造版本', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));
    render(<MemoryRouter initialEntries={['/privacy']}><NewLegalPage /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('协议暂时无法加载，请稍后重试');
    expect(screen.queryByText(/当前版本：/)).not.toBeInTheDocument();
  });
});
