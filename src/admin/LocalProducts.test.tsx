import { render,screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach,expect,it,vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { AdminProductEdit,AdminProducts } from './AdminPages';
const product={id:'p-local',name:'本地数据库商品',description:'本地说明',image:'/products/source-002.png',icon:'本',marketPriceCents:19900,deliveryType:'content',status:'active',category:'手机直播带货',categories:['手机直播带货'],categoryIds:['local-cat-17'],priceCents:13500,stock:37,partnerCostCents:8800,specs:[{id:'p-local-s1',name:'默认规格',partnerCostCents:8800,priceCents:13500,stock:37,status:'active'}]};
function response(data:any){return Promise.resolve(new Response(JSON.stringify({data}),{status:200,headers:{'Content-Type':'application/json'}}))}
function renderAdmin(node:React.ReactElement,entry='/admin/products'){return render(<AuthProvider><MemoryRouter initialEntries={[entry]}>{node}</MemoryRouter></AuthProvider>)}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()});

it('后台商品列表读取真实本地商品而不是静态上游字段',async()=>{
 vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL)=>{const url=String(input);if(url==='/api/auth/session')return response({user:{id:'a',username:'admin',role:'admin'},csrfToken:'csrf'});if(url.startsWith('/api/admin/products'))return response({products:[product]});return response({})}));
 renderAdmin(<AdminProducts/>);
 expect(await screen.findByText('本地数据库商品')).toBeInTheDocument();expect(screen.getByText('¥88.00')).toBeInTheDocument();expect(screen.getByText('¥135.00')).toBeInTheDocument();expect(screen.queryByText('上游商品ID')).not.toBeInTheDocument();expect(screen.getByText('已上架')).toBeInTheDocument();
});

it('后台把零价格零库存的下架参考商品标为待补资料',async()=>{
 const draft={...product,id:'reference-122',name:'无限注册渠道',status:'inactive',priceCents:0,stock:0,partnerCostCents:0,specs:[{...product.specs[0],id:'reference-122-s1',name:'待补资料',status:'inactive',partnerCostCents:0,priceCents:0,stock:0}]};
 vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL)=>{const url=String(input);if(url==='/api/auth/session')return response({user:{id:'a',username:'admin',role:'admin'},csrfToken:'csrf'});if(url.startsWith('/api/admin/products'))return response({products:[draft]});return response({})}));
 renderAdmin(<AdminProducts/>);
 expect(await screen.findByText('无限注册渠道')).toBeInTheDocument();expect(screen.getByText('待补资料')).toBeInTheDocument();expect(screen.queryByText('已下架')).not.toBeInTheDocument();
});

it('后台商品编辑页保存本站标题、售价、成本和库存',async()=>{
 const fetchMock=vi.fn((input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input);if(url==='/api/auth/session')return response({user:{id:'a',username:'admin',role:'admin'},csrfToken:'csrf'});if(url==='/api/admin/categories')return response({categories:[{id:'local-cat-17',name:'手机直播带货',icon:'播',sortOrder:17,status:'active'}]});if(url==='/api/admin/products/p-local'&&(!init?.method||init.method==='GET'))return response(product);if(url==='/api/admin/products/p-local'&&init?.method==='PATCH')return response({...product,name:'修改后的本地标题'});if(url==='/api/admin/products/p-local/specs/p-local-s1'&&init?.method==='PATCH')return response({...product,name:'修改后的本地标题',specs:[{...product.specs[0],priceCents:14900,stock:25}]});return response({})});
 vi.stubGlobal('fetch',fetchMock);const user=userEvent.setup();renderAdmin(<AdminProductEdit/>,'/admin/products/edit?id=p-local');
 const title=await screen.findByLabelText('商品标题');await user.clear(title);await user.type(title,'修改后的本地标题');const price=screen.getByLabelText('本站售价');await user.clear(price);await user.type(price,'149.00');const stock=screen.getByLabelText('本地库存');await user.clear(stock);await user.type(stock,'25');await user.click(screen.getByRole('button',{name:'保存商品'}));
 expect(await screen.findByText('商品配置已保存。')).toBeInTheDocument();expect(fetchMock).toHaveBeenCalledWith('/api/admin/products/p-local',expect.objectContaining({method:'PATCH'}));expect(fetchMock).toHaveBeenCalledWith('/api/admin/products/p-local/specs/p-local-s1',expect.objectContaining({method:'PATCH'}));
});
