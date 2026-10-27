import { render,screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach,describe,expect,it,vi } from 'vitest';
import CheckoutPage from './CheckoutPage';

afterEach(()=>vi.unstubAllGlobals());

describe('F06 收银台',()=>{it('展示真实本站订单并诚实禁用尚未配置的支付',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({data:{id:'order-1',orderNumber:'L1001',status:'pending_payment',paymentStatus:'unpaid',deliveryStatus:'pending',paymentMethod:null,totalAmountCents:24750,createdAt:'2026-10-23 09:00:00',updatedAt:'2026-10-23 09:00:00',items:[{id:'item-1',productId:'p-002',productName:'手机直播【开户】',specName:'默认规格',unitPriceCents:12375,quantity:2,lineTotalCents:24750,productImagePath:'/products/source-002.png'}]}}),{status:200,headers:{'Content-Type':'application/json'}})));
  render(<MemoryRouter initialEntries={['/checkout?order=order-1']}><CheckoutPage/></MemoryRouter>);
  expect(screen.getByRole('heading',{name:'收银台'})).toBeInTheDocument(); expect(await screen.findByText(/L1001/)).toBeInTheDocument(); expect(screen.getByText('手机直播【开户】')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:/微信支付/})).toBeDisabled(); expect(screen.getByRole('button',{name:/支付宝/})).toBeDisabled(); expect(screen.getByRole('button',{name:'支付渠道待配置'})).toBeDisabled();
});});

describe('F06 真实支付会话',()=>{it('配置完成后可以创建支付宝支付二维码',async()=>{
 const user=(await import('@testing-library/user-event')).default.setup();
 vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input);if(url==='/api/orders/order-2')return Promise.resolve(new Response(JSON.stringify({data:{id:'order-2',orderNumber:'L2002',status:'pending_payment',paymentStatus:'unpaid',deliveryStatus:'pending',paymentMethod:null,totalAmountCents:9900,createdAt:'2026-10-23 09:00:00',updatedAt:'2026-10-23 09:00:00',items:[{id:'item-2',productId:'p-002',specId:'p-002-s1',productName:'商品',specName:'默认规格',unitPriceCents:9900,quantity:1,lineTotalCents:9900,productImagePath:null}]}}),{status:200,headers:{'Content-Type':'application/json'}}));if(url==='/api/payments/availability')return Promise.resolve(new Response(JSON.stringify({data:{wechat:false,alipay:true}}),{status:200,headers:{'Content-Type':'application/json'}}));if(url==='/api/payments/orders/order-2/create'&&init?.method==='POST')return Promise.resolve(new Response(JSON.stringify({data:{provider:'alipay',qrCode:'https://qr.alipay.test/pay',orderNumber:'L2002'}}),{status:200,headers:{'Content-Type':'application/json'}}));return Promise.resolve(new Response(JSON.stringify({data:{}}),{status:200,headers:{'Content-Type':'application/json'}}))}));
 render(<MemoryRouter initialEntries={['/checkout?order=order-2']}><CheckoutPage/></MemoryRouter>);expect(await screen.findByText(/L2002/)).toBeInTheDocument();expect(screen.getByRole('button',{name:/微信支付/})).toBeDisabled();await user.click(screen.getByRole('button',{name:/支付宝/}));await user.click(screen.getByRole('button',{name:'生成支付二维码'}));expect(await screen.findByRole('img',{name:'支付宝支付二维码'})).toBeInTheDocument();
});});
