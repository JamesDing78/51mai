import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { categories as sourceCategories, products as sourceProducts } from './data';

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const catalogCategories=sourceCategories.filter(([name])=>name!=='全部分类').map(([name,icon],i)=>({id:`c${i}`,name,icon,sortOrder:i+1}));
const catalogProducts=sourceProducts.slice(0,12).map(p=>({id:p.id,name:p.name,description:p.description,image:p.image,icon:p.icon,marketPriceCents:p.marketPrice?Math.round(p.marketPrice*100):null,deliveryType:p.deliveryType,status:'active',category:p.category,categories:p.categories,categoryIds:[],priceCents:Math.round(p.price*100),stock:p.stock,specs:p.specs.map(x=>({id:x.id,name:x.name,priceCents:Math.round(p.price*100),stock:x.stock,status:'active'}))}));
const catalogProductP002=catalogProducts.find(p=>p.id==='p-002')!;

function anonymousFetch() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/auth/session') return Promise.resolve(response(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } }));
    if (url === '/api/auth/policies') return Promise.resolve(response(200, { data: { termsVersion: 'terms-v1', privacyVersion: 'privacy-v1', termsUrl: '/terms', privacyUrl: '/privacy' } }));
    if (url === '/api/catalog') return Promise.resolve(response(200,{data:{categories:catalogCategories,products:catalogProducts}}));
    if (url === '/api/catalog/products/p-002') return Promise.resolve(response(200,{data:catalogProductP002}));
    return Promise.resolve(response(404, {}));
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', anonymousFetch());
  window.history.pushState({}, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState({}, '', '/');
});

describe('F01 首页与应用路由', () => {
  it('首页以加盟权益为主视觉并将搜索降级为辅助入口', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: /成为合伙人/ })).toBeInTheDocument();
    expect(screen.getAllByText(/赠送同款货源站/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('searchbox', { name: '搜索商品' })).toBeInTheDocument();
    expect(screen.getByText('热门搜索')).toBeInTheDocument();
  });

  it('前台不展示开发需求和实现说明', () => {
    render(<App />);
    const body = document.body.textContent ?? '';
    for (const phrase of ['持续同步', '审核后可售', '演示数据', '当前开发状态', '合伙人购买价 × 1.25']) expect(body).not.toContain(phrase);
  });

  it('展示品牌主张、搜索、分类和热门商品', async () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: '成为合伙人' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: '搜索商品' })).toBeInTheDocument();
    expect(screen.getByText('选择分类')).toBeInTheDocument();
    expect(screen.getByText('商品列表')).toBeInTheDocument();
    expect((await screen.findAllByRole('article')).length).toBeGreaterThanOrEqual(4);
  });

  it('允许用户输入搜索词并提交', async () => {
    const user = userEvent.setup();
    render(<App />);
    const search = screen.getByRole('searchbox', { name: '搜索商品' });
    await user.type(search, '雷帝AI');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    expect(screen.getByText('正在搜索：雷帝AI')).toBeInTheDocument();
  });

  it('提供移动端核心导航的可访问标签', () => {
    render(<App />);
    const nav = screen.getByRole('navigation', { name: '移动端主导航' });
    expect(within(nav).getByRole('link', { name: '首页' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: '商品' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: '代理' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: '客服' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: '我的' })).toBeInTheDocument();
  });

  it('可通过公开前台路由进入页面', async () => {
    for (const [path, heading] of [['/catalog', '购买商品'], ['/products/p-002', '手机直播【开户】'], ['/help', '客服与帮助中心'], ['/cooperation', '成为合伙人'], ['/terms', '用户协议'], ['/privacy', '隐私政策']] as const) {
      window.history.pushState({}, '', path);
      render(<App />);
      expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
      cleanup();
    }
  });

  it.each([['/login', '欢迎来到 51mai'], ['/admin/login', '后台管理登录']])('登录例外路由 %s 可访问', async (path, heading) => {
    window.history.pushState({}, '', path);
    render(<App />);
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
  });

  it.each(['/confirm-order?product=p-002&spec=p-002-s1&quantity=2', '/ucenter', '/ucenter/orders', '/orders', '/orders/202610220001', '/checkout', '/member-level', '/goodspricelog'])('匿名访问 %s 跳转登录且不闪现业务数据', async (path) => {
    window.history.pushState({}, '', path);
    render(<App />);
    expect(screen.queryByRole('heading', { name: /用户中心|我的订单|订单详情与自动交付|收银台|会员升级|调价信息/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '欢迎来到 51mai' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');
  });

  it('保留受保护商品路径的returnTo参数', async () => {
    window.history.pushState({}, '', '/checkout?spec=sku-1&quantity=2#pay');
    render(<App />);
    await screen.findByRole('heading', { name: '欢迎来到 51mai' });
    expect(window.location.search).toContain('returnTo=%2Fcheckout%3Fspec%3Dsku-1%26quantity%3D2%23pay');
  });

  it('customer访问admin显示无权限且不渲染后台', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => String(input) === '/api/auth/session'
      ? Promise.resolve(response(200, { data: { user: { id: 'u-1', username: 'customer', role: 'customer' }, csrfToken: 'csrf-u' } }))
      : Promise.resolve(response(404, {}))));
    window.history.pushState({}, '', '/admin');
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('无权限访问管理后台');
    expect(screen.queryByRole('heading', { name: '控制台总览' })).not.toBeInTheDocument();
  });
});
