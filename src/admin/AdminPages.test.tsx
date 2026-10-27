import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, vi } from 'vitest';
import type { ReactElement } from 'react';
import { AuthProvider } from '../auth/AuthProvider';
import { AdminDashboard, AdminProducts, AdminProductEdit, AdminPricing, AdminOrders, AdminFulfillment, AdminSync, AdminPayments, AdminBrand, AdminSecurity, AdminCustomers, AdminDistribution, AdminSites, AdminCommissions, AdminLogin } from './AdminPages';

const localProduct={id:'p-local',name:'本地商品',description:'说明',image:'/products/source-002.png',icon:'本',marketPriceCents:19900,deliveryType:'content',status:'active',category:'手机直播带货',categories:['手机直播带货'],categoryIds:['c17'],priceCents:13500,stock:37,partnerCostCents:8800,specs:[{id:'p-local-s1',name:'默认规格',partnerCostCents:8800,priceCents:13500,stock:37,status:'active'}]};

function renderAdmin(page: ReactElement) {
  return render(<AuthProvider><MemoryRouter>{page}</MemoryRouter></AuthProvider>);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/auth/session') return Promise.resolve(new Response(JSON.stringify({ data: { user: { id: 'a-1', username: 'admin', role: 'admin' }, csrfToken: 'csrf-admin' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    if (url.startsWith('/api/admin/customers')) return Promise.resolve(new Response(JSON.stringify({ data: { customers: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    if (url.startsWith('/api/admin/products')) return Promise.resolve(new Response(JSON.stringify({ data: { products: [localProduct] } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    if (url === '/api/admin/categories') return Promise.resolve(new Response(JSON.stringify({ data: { categories: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    if (url.startsWith('/api/admin/orders')) return Promise.resolve(new Response(JSON.stringify({ data: { orders: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    if (url === '/api/admin/fulfillment/jobs') return Promise.resolve(new Response(JSON.stringify({ data: { jobs: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    if (url === '/api/admin/payment-config') return Promise.resolve(new Response(JSON.stringify({ data: { wechat:{configured:false,paymentReady:false,merchantId:null,callbackPath:'/api/payments/callback/wechat'}, alipay:{configured:false,paymentReady:false,appId:null,callbackPath:'/api/payments/callback/alipay'} } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    return Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const cases = [
  [AdminDashboard, '控制台总览'], [AdminProducts, '商品管理'], [AdminProductEdit, '商品编辑与规格配置'],
  [AdminPricing, '定价规则'], [AdminOrders, '订单管理'], [AdminFulfillment, '发货与异常处理'],
  [AdminSync, '外部供货'], [AdminPayments, '支付配置'], [AdminBrand, '站点品牌与联系方式'], [AdminSecurity, '系统日志与权限'],
] as const;

describe('A01-A10 管理后台', () => {
  it('A02 商品列表展示本地成本、售价、库存和上架状态', async () => {
    renderAdmin(<AdminProducts />);
    expect(await screen.findByText('本地商品')).toBeInTheDocument();
    expect(screen.getByText('商品ID')).toBeInTheDocument();
    expect(screen.getByText('成本')).toBeInTheDocument();
    expect(screen.getByText('上架状态')).toBeInTheDocument();
    expect(screen.queryByText('上游商品ID')).not.toBeInTheDocument();
  });

  it('A03 不再展示上游同步编辑字段', async () => {
    renderAdmin(<AdminProducts />);
    await screen.findByText('本地商品');
    expect(screen.queryByText('合伙人购买价')).not.toBeInTheDocument();
    expect(screen.queryByText('同步状态')).not.toBeInTheDocument();
  });
  it.each(cases)('%s 展示对应页面标题', (Page, heading) => {
    renderAdmin(<Page />);
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
  });

  it('本地商品表格为移动端卡片转换提供字段标签', async () => {
    renderAdmin(<AdminProducts />); await screen.findByText('本地商品');
    const firstRow=screen.getAllByRole('row')[1];const cells=Array.from(firstRow.querySelectorAll('td'));
    expect(cells.map(cell=>cell.getAttribute('data-label'))).toEqual(['商品','商品ID','成本','本站售价','库存','交付类型','上架状态','操作']);
  });

  it('移动端后台导航保留可访问的完整管理入口', () => {
    renderAdmin(<AdminDashboard />);
    const nav = screen.getByRole('navigation', { name: '管理后台导航' });
    expect(nav.querySelectorAll('a')).toHaveLength(14);
  });

  it('A01 指标与原型保持待处理和异常两个运营指标', () => {
    renderAdmin(<AdminDashboard />);
    expect(screen.getByText('待处理')).toBeInTheDocument();
    expect(screen.getByText('异常')).toBeInTheDocument();
  });

  it('A04 商品级规则为空时不展示虚拟商品', () => {
    renderAdmin(<AdminPricing />);
    expect(screen.getByRole('heading', { name: '商品级规则' })).toBeInTheDocument();
    expect(screen.getByText('暂无商品级定价规则')).toBeInTheDocument();
    expect(screen.queryByText('手机直播【开户】')).not.toBeInTheDocument();
    expect(screen.getByText(/优先级/)).toBeInTheDocument();
  });

  it('A09 包含 Favicon 与客服二维码配置', () => {
    renderAdmin(<AdminBrand />);
    expect(screen.getByLabelText('Favicon')).toBeInTheDocument();
    expect(screen.getByLabelText('客服二维码')).toBeInTheDocument();
  });

  it('A10 提供日志导出入口', () => {
    renderAdmin(<AdminSecurity />);
    expect(screen.getByRole('button', { name: '导出日志' })).toBeInTheDocument();
  });

  it('A02 提供本地商品搜索入口', async () => {renderAdmin(<AdminProducts/>);expect(await screen.findByLabelText('搜索商品')).toBeInTheDocument();});

  it('A06 提供安全资产入库、人工发货与真实任务列表', async () => {
    renderAdmin(<AdminFulfillment />);
    expect(screen.getByLabelText('交付资产商品ID')).toBeInTheDocument();
    expect(screen.getByLabelText('人工发货订单ID')).toBeInTheDocument();
    expect(await screen.findByText('暂无发货任务')).toBeInTheDocument();
  });

  it('A07 明确外部供货当前暂停且不提供同步按钮', () => {renderAdmin(<AdminSync/>);expect(screen.getByText('外部供货暂不启用')).toBeInTheDocument();expect(screen.getByText('已暂停')).toBeInTheDocument();expect(screen.queryByRole('button',{name:'立即同步'})).not.toBeInTheDocument();});

  it('A08 展示真实服务端支付配置状态且不暴露密钥', async () => {
    renderAdmin(<AdminPayments />);
    expect(await screen.findByText('/api/payments/callback/wechat')).toBeInTheDocument();
    expect(screen.getByText('/api/payments/callback/alipay')).toBeInTheDocument();
    expect(screen.queryByLabelText('API 密钥')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '测试连接' })).not.toBeInTheDocument();
  });

  it('客户管理提供已确认的客户读取、等级筛选和订单汇总能力', async () => {
    renderAdmin(<AdminCustomers />);
    expect(screen.getByRole('heading', { name: '客户管理' })).toBeInTheDocument();
    expect(screen.getByLabelText('客户等级')).toBeInTheDocument();
    expect(screen.getByText('累计订单')).toBeInTheDocument();
    expect(screen.getAllByText('累计消费').length).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText('暂无客户')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新增客户' })).not.toBeInTheDocument();
  });

  it('分销层级管理以空状态开始且保留新增层级入口', () => {
    renderAdmin(<AdminDistribution />);
    expect(screen.getByRole('heading', { name: '分销层级管理' })).toBeInTheDocument();
    expect(screen.getByText('暂无分销层级')).toBeInTheDocument();
    expect(screen.queryByText('一级分销')).not.toBeInTheDocument();
    expect(screen.queryByText('¥8,640')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新增层级' })).toBeInTheDocument();
  });
  it('分站管理以空状态开始并保留新建入口', () => {
    renderAdmin(<AdminSites />);
    expect(screen.getByRole('heading', { name: '分站管理' })).toBeInTheDocument();
    expect(screen.getByText('暂无分站')).toBeInTheDocument();
    expect(screen.queryByText('east.51mai.local')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建分站' })).toBeInTheDocument();
  });

  it('佣金结算展示佣金订单、提现申请和结算记录', () => {
    renderAdmin(<AdminCommissions />);
    expect(screen.getByRole('heading', { name: '佣金结算' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '佣金订单' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '提现申请' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '结算记录' })).toBeInTheDocument();
    expect(screen.getByText('暂无佣金记录')).toBeInTheDocument();
    expect(screen.queryByText('李女士')).not.toBeInTheDocument();
  });

  it('后台提供独立登录入口', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: '需要登录' } }), { status: 401, headers: { 'Content-Type': 'application/json' } })));
    renderAdmin(<AdminLogin />);
    expect(await screen.findByRole('heading', { name: '后台管理登录' })).toBeInTheDocument();
    expect(await screen.findByLabelText('管理员账号')).toBeInTheDocument();
    expect(screen.getByLabelText('管理员密码')).toBeInTheDocument();
  });

});
