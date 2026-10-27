import { render,screen } from '@testing-library/react';
import { MemoryRouter,Route,Routes } from 'react-router-dom';
import { afterEach,expect,it,vi } from 'vitest';
import CatalogPage from './CatalogPage';
import ProductPage from './ProductPage';
import CartPage from './CartPage';
import { setCsrfToken } from '../auth/client';

const product={id:'p-local',name:'数据库商品',description:'数据库说明',image:'/products/source-002.png',icon:'数',marketPriceCents:19900,deliveryType:'content',status:'active',category:'手机直播带货',categories:['手机直播带货'],categoryIds:['local-cat-17'],priceCents:13500,stock:7,specs:[{id:'p-local-s1',name:'月卡',priceCents:13500,stock:7,status:'active'}]};
const catalog={categories:[{id:'local-cat-17',name:'手机直播带货',icon:'播',sortOrder:17}],products:[product]};
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()});

it('商品列表从数据库目录API加载而不是静态data.ts',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({data:catalog}),{status:200,headers:{'Content-Type':'application/json'}})));
 render(<MemoryRouter><CatalogPage/></MemoryRouter>);
 expect(await screen.findByText('数据库商品')).toBeInTheDocument();expect(screen.getByText('¥135.00')).toBeInTheDocument();
});

it('商品详情从数据库API读取价格库存和规格',async()=>{
 vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL)=>String(input).includes('/api/catalog/products/p-local')?Promise.resolve(new Response(JSON.stringify({data:product}),{status:200,headers:{'Content-Type':'application/json'}})):Promise.resolve(new Response('',{status:204}))));
 render(<MemoryRouter initialEntries={['/products/p-local']}><Routes><Route path="/products/:id" element={<ProductPage/>}/></Routes></MemoryRouter>);
 expect(await screen.findByRole('heading',{name:'数据库商品'})).toBeInTheDocument();expect(screen.getByText('库存：7')).toBeInTheDocument();expect(screen.getByRole('button',{name:'月卡'})).toBeInTheDocument();
});

it('确认订单从数据库详情API读取商品而不是静态data.ts',async()=>{
 const fetchMock=vi.fn((input:RequestInfo|URL)=>String(input).includes('/api/catalog/products/p-local')?Promise.resolve(new Response(JSON.stringify({data:product}),{status:200,headers:{'Content-Type':'application/json'}})):Promise.resolve(new Response(JSON.stringify({data:{id:'o-local'}}),{status:201,headers:{'Content-Type':'application/json'}})));
 vi.stubGlobal('fetch',fetchMock);setCsrfToken('csrf');
 render(<MemoryRouter initialEntries={['/confirm-order?product=p-local&spec=p-local-s1&quantity=2']}><Routes><Route path="/confirm-order" element={<CartPage/>}/></Routes></MemoryRouter>);
 expect(await screen.findByRole('heading',{name:'确认订单'})).toBeInTheDocument();expect(screen.getByText('数据库商品')).toBeInTheDocument();expect(screen.getAllByText('¥270.00').length).toBeGreaterThan(0);
});
