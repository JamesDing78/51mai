import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import OrdersPage from './OrdersPage';

afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()});
it('从订单API展示当前用户真实订单，而不是静态假订单',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({data:{orders:[{id:'o-1',orderNumber:'P3-1001',status:'pending_payment',paymentStatus:'unpaid',deliveryStatus:'pending',paymentMethod:null,totalAmountCents:19900,createdAt:'2026-10-23 06:00:00.000000',updatedAt:'2026-10-23 06:00:00.000000',items:[{id:'i-1',productId:'p-002',productName:'手机直播【开户】',specName:'默认规格',unitPriceCents:19900,quantity:1,lineTotalCents:19900,productImagePath:'/products/source-002.png'}]}]}}),{status:200,headers:{'Content-Type':'application/json'}})));
  render(<MemoryRouter><OrdersPage/></MemoryRouter>);
  expect(screen.getByRole('status')).toHaveTextContent('正在加载订单');
  expect(await screen.findByText(/P3-1001/)).toBeInTheDocument();
  expect(screen.getByText('手机直播【开户】')).toBeInTheDocument();
  expect(screen.getAllByText('待支付').length).toBeGreaterThanOrEqual(1);
});
it('没有订单时显示真实空状态',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({data:{orders:[]}}),{status:200,headers:{'Content-Type':'application/json'}})));
  render(<MemoryRouter><OrdersPage/></MemoryRouter>);
  expect(await screen.findByText('暂无订单')).toBeInTheDocument();
});
