import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { GoodsPriceLog } from './UserCenterPages';
const ok=(data:unknown)=>Promise.resolve(new Response(JSON.stringify({data}),{status:200,headers:{'Content-Type':'application/json'}}));
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()});
it('调价信息读取真实价格日志并支持搜索',async()=>{const fetchMock=vi.fn((input:RequestInfo|URL)=>ok({priceLogs:[{id:'pl1',productId:'p-real',productName:'真实调价商品',oldPriceCents:12000,newPriceCents:9900,changeCents:-2100,status:'active',changedAt:'2026-10-23T08:00:00Z'}]}));vi.stubGlobal('fetch',fetchMock);const user=userEvent.setup();render(<MemoryRouter><GoodsPriceLog/></MemoryRouter>);expect(await screen.findByText('真实调价商品')).toBeInTheDocument();expect(screen.getByText('¥120.00')).toBeInTheDocument();expect(screen.getByText('¥99.00')).toBeInTheDocument();expect(screen.getByText('-¥21.00')).toBeInTheDocument();expect(screen.queryByText(/AI产品系列/)).not.toBeInTheDocument();await user.type(screen.getByLabelText('调价搜索'),'真实');expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('q=%E7%9C%9F%E5%AE%9E')});
