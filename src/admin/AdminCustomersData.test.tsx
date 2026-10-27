import { render,screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach,expect,it,vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { AdminCustomers } from './AdminPages';
const response=(data:unknown)=>new Response(JSON.stringify({data}),{status:200,headers:{'Content-Type':'application/json'}});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()});
it('后台客户列表读取真实API聚合而不是内存假客户',async()=>{vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL)=>String(input)==='/api/auth/session'?Promise.resolve(response({user:{id:'a',username:'admin',role:'admin'},csrfToken:'csrf'})):String(input).startsWith('/api/admin/customers')?Promise.resolve(response({customers:[{id:'u1',username:'customer1',nickname:'真实客户',accountTier:'普通用户',accountStatus:'active',createdAt:'2026-10-23 06:00:00',orderCount:3,totalSpendCents:19900}]})):Promise.resolve(new Response(null,{status:404}))));render(<AuthProvider><MemoryRouter><AdminCustomers/></MemoryRouter></AuthProvider>);expect(await screen.findByText('真实客户')).toBeInTheDocument();expect(screen.getByText('customer1')).toBeInTheDocument();expect(screen.getAllByText('3').length).toBeGreaterThanOrEqual(1);expect(screen.getAllByText('¥199.00').length).toBeGreaterThanOrEqual(1);expect(screen.queryByText('张先生')).not.toBeInTheDocument()});
