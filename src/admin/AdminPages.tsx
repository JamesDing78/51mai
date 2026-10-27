import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, addAdminProductSpec, addFulfillmentAsset, adminLogin, archiveAdminProduct, createAdminProduct, deleteAdminProductSpec, getAdminCategories, getAdminCustomers, getAdminProduct, getAdminProducts, getAdminOrders, getAdminPaymentConfig, getFulfillmentJobs, loginRedirect, manualFulfillOrder, updateAdminProduct, updateAdminProductSpec, updateAdminOrderManual, type AdminCatalogCategory, type AdminCatalogProduct, type AdminCustomer, type AdminOrderRecord, type AdminPaymentConfig, type CustomerOrderStatus, type FulfillmentJob } from '../auth/client';
import { useAuth } from '../auth/AuthProvider';

const orderStatusLabel=(status:CustomerOrderStatus)=>status==='pending_payment'?'待支付':status==='processing'?'处理中':status==='completed'?'已完成':status==='after_sale'?'售后':'已取消';
const NAV=[['/admin','控制台总览'],['/admin/customers','客户管理'],['/admin/distribution','分销层级'],['/admin/sites','分站管理'],['/admin/commissions','佣金结算'],['/admin/products','商品管理'],['/admin/products/edit','商品编辑'],['/admin/pricing','定价规则'],['/admin/orders','订单管理'],['/admin/fulfillment','发货异常'],['/admin/sync','外部供货（暂停）'],['/admin/payments','支付配置'],['/admin/brand','站点设置'],['/admin/security','系统管理']];
function AdminLogoutButton() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleLogout = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await logout();
      navigate('/admin/login', { replace: true });
    } catch {
      setError('退出失败，请重试。');
    } finally {
      setBusy(false);
    }
  };

  return <span className="admin-logout"><button className="text-button" type="button" onClick={() => void handleLogout()} disabled={busy}>{busy ? '退出中…' : '退出'}</button>{error && <span role="alert">{error}</span>}</span>;
}

function Layout({code,title,desc,children}:{code:string;title:string;desc:string;children:ReactNode}){
  const { user } = useAuth();
  return <div className="admin-app"><aside className="admin-sidebar"><Link className="admin-logo" to="/admin"><span>51</span>mai</Link><nav aria-label="管理后台导航">{NAV.map(([to,label])=><Link key={to} to={to}>{label}</Link>)}</nav><Link className="back-store" to="/">← 返回商城</Link></aside><div className="admin-main"><header className="admin-topbar"><div><span className="admin-code">{code}</span><strong>{title}</strong></div><div className="admin-tools"><label>⌕<input aria-label="后台搜索" placeholder="搜索…"/></label><span className="admin-user">{user?.username ?? '管理员'}</span><AdminLogoutButton /></div></header><main className="admin-content"><div className="admin-page-title"><div><h1>{title}</h1><p>{desc}</p></div></div>{children}</main></div></div>
}
const Status=({children,tone='ok'}:{children:ReactNode;tone?:string})=><span className={`admin-status ${tone}`}>{children}</span>;
function Toolbar(){return <div className="admin-toolbar"><input aria-label="管理列表搜索" placeholder="搜索名称、ID、用户…"/><select><option>全部分类</option><option>数字人直播系列</option><option>测试卡系列</option></select><select><option>全部状态</option><option>正常</option><option>待处理</option></select><button className="primary">查询</button></div>}
function ProductTable({items,onArchive}:{items:AdminCatalogProduct[];onArchive:(id:string)=>void}){return <div className="admin-table-wrap"><table className="admin-table upstream-product-table"><thead><tr><th>商品</th><th>商品ID</th><th>成本</th><th>本站售价</th><th>库存</th><th>交付类型</th><th>上架状态</th><th>操作</th></tr></thead><tbody>{items.map(p=>{const pendingReference=p.id.startsWith('reference-')&&p.status==='inactive'&&p.partnerCostCents===0&&p.priceCents===0&&p.stock===0;return <tr key={p.id}><td data-label="商品"><div className="table-product"><span>{p.icon}</span><strong>{p.name}</strong></div></td><td data-label="商品ID"><code>{p.id}</code></td><td data-label="成本">¥{(p.partnerCostCents/100).toFixed(2)}</td><td data-label="本站售价">¥{(p.priceCents/100).toFixed(2)}</td><td data-label="库存">{p.stock}</td><td data-label="交付类型">{p.deliveryType==='card'?'卡密':'内容'}</td><td data-label="上架状态"><Status tone={p.status==='active'?'ok':'warn'}>{p.status==='active'?'已上架':pendingReference?'待补资料':'已下架'}</Status></td><td data-label="操作"><Link className="text-button" to={`/admin/products/edit?id=${encodeURIComponent(p.id)}`}>编辑</Link>{p.status==='active'&&<button className="text-button danger-action" type="button" onClick={()=>onArchive(p.id)}>归档</button>}</td></tr>})}</tbody></table></div>}
const Panel=({title,children}:{title:string;children:ReactNode})=><section className="admin-panel"><h2>{title}</h2>{children}</section>;


export function AdminLogin(){
  const { status, user, error, refresh, setSession } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (status === 'authenticated' && user?.role === 'admin') navigate(loginRedirect(new URLSearchParams(location.search).get('returnTo') ?? '', 'admin'), { replace: true });
  }, [location.search, navigate, status, user]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const nextErrors: string[] = [];
    if (!identifier.trim()) nextErrors.push('请输入管理员账号');
    if (!password) nextErrors.push('请输入管理员密码');
    if (nextErrors.length > 0) {
      setFormError(nextErrors.join('；'));
      return;
    }
    setBusy(true);
    setFormError('');
    try {
      const session = await adminLogin({ identifier: identifier.trim(), password, remember });
      setSession(session);
      navigate(loginRedirect(new URLSearchParams(location.search).get('returnTo') ?? '', 'admin'), { replace: true });
    } catch (error) {
      const retryable = error instanceof ApiError && (error.isNetwork || error.status === 503);
      setFormError(retryable ? '暂时无法登录后台，请稍后重试。' : '管理员账号或密码不正确');
    } finally {
      setBusy(false);
    }
  };

  if (status === 'loading') return <main className="admin-login-page"><section className="admin-login-card"><p role="status">正在确认登录状态…</p></section></main>;
  if (status === 'error') return <main className="admin-login-page"><section className="admin-login-card"><div className="auth-feedback error" role="alert">{error?.message ?? '暂时无法确认登录状态，请重试。'}</div><button className="primary" type="button" onClick={() => void refresh()}>重试</button></section></main>;
  if (status === 'authenticated' && user?.role === 'customer') return <main className="admin-login-page"><section className="admin-login-card"><h1>后台管理登录</h1><div className="auth-feedback error" role="alert">无权限访问管理后台。</div><p>当前账号没有管理员权限。</p><p><Link to="/">返回商城</Link> · <Link to="/ucenter">返回个人中心</Link></p></section></main>;
  if (status === 'authenticated') return <main className="admin-login-page"><section className="admin-login-card"><p role="status">正在进入后台…</p></section></main>;

  return <main className="admin-login-page"><section className="admin-login-card"><Link className="brand" to="/"><span>51</span>mai</Link><h1>后台管理登录</h1><p>登录后进入 51mai 管理平台。</p><form className="admin-login-form" onSubmit={handleSubmit} noValidate><label>管理员账号<input aria-label="管理员账号" value={identifier} onChange={(event) => setIdentifier(event.target.value)} placeholder="请输入账号" autoComplete="username" aria-invalid={Boolean(formError)} /></label><label>密码<input aria-label="管理员密码" value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="请输入密码" autoComplete="current-password" aria-invalid={Boolean(formError)} /></label><label><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />记住我</label><button className="primary primary-link" type="submit" disabled={busy}>{busy ? '登录中…' : '登录后台'}</button></form>{formError && <div className="auth-feedback error" role="alert">{formError}</div>}<Link className="admin-login-back" to="/">返回商城</Link></section></main>
}

export function AdminDashboard(){
  const [orders,setOrders]=useState<AdminOrderRecord[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
  useEffect(()=>{const c=new AbortController();getAdminOrders({},c.signal).then(r=>setOrders(r.orders)).catch(()=>{if(!c.signal.aborted)setError('订单概览加载失败，请重试。')}).finally(()=>{if(!c.signal.aborted)setLoading(false)});return()=>c.abort()},[]);
  const sales=orders.filter(o=>o.paymentStatus==='paid').reduce((sum,o)=>sum+o.totalAmountCents,0),pending=orders.filter(o=>o.status==='pending_payment'||o.status==='processing').length,exceptions=orders.filter(o=>o.manualProcessingStatus==='held').length;
  return <Layout code="A01" title="控制台总览" desc="基于本站真实订单数据展示当前运营概览。">{error&&<p role="alert">{error}</p>}<div className="metric-grid">{[['当前订单',loading?'—':String(orders.length)],['已支付金额',loading?'—':`¥${(sales/100).toFixed(2)}`],['待处理',loading?'—':String(pending)],['异常',loading?'—':String(exceptions)]].map(([k,v])=><article className="metric-card" key={k}><span>{k}</span><strong>{v}</strong></article>)}</div><Panel title="最近订单">{loading?<p role="status">正在加载订单…</p>:orders.length===0?<p>暂无订单</p>:<div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>订单号</th><th>用户</th><th>金额</th><th>状态</th></tr></thead><tbody>{orders.slice(0,5).map(o=><tr key={o.id}><td data-label="订单号">{o.orderNumber}</td><td data-label="用户">{o.username}</td><td data-label="金额">¥{(o.totalAmountCents/100).toFixed(2)}</td><td data-label="状态">{orderStatusLabel(o.status)}</td></tr>)}</tbody></table></div>}</Panel></Layout>
}


export function AdminCustomers(){
  const [customers,setCustomers]=useState<AdminCustomer[]>([]);const [query,setQuery]=useState('');const [tier,setTier]=useState('');const [loading,setLoading]=useState(true);const [error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();setLoading(true);setError('');getAdminCustomers({q:query,tier:tier||undefined},controller.signal).then(r=>setCustomers(r.customers)).catch(e=>{if(controller.signal.aborted)return;setError(e instanceof ApiError&&e.isNetwork?'暂时无法加载客户，请重试。':'客户列表加载失败，请重试。')}).finally(()=>{if(!controller.signal.aborted)setLoading(false)});return()=>controller.abort()},[query,tier]);
  return <Layout code="A11" title="客户管理" desc="查看客户资料、等级、订单、消费与账号状态。"><div className="metric-grid">{[['客户总数',String(customers.length)],['累计订单',String(customers.reduce((sum,c)=>sum+c.orderCount,0))],['累计消费',`¥${(customers.reduce((sum,c)=>sum+c.totalSpendCents,0)/100).toFixed(2)}`]].map(([k,v])=><article className="metric-card" key={k}><span>{k}</span><strong>{v}</strong></article>)}</div><div className="admin-toolbar customer-toolbar"><input aria-label="搜索客户" value={query} onChange={e=>setQuery(e.target.value)} placeholder="用户名或昵称"/><select aria-label="客户等级" value={tier} onChange={e=>setTier(e.target.value)}><option value="">全部等级</option><option>普通用户</option><option>基础版站长</option></select></div><Panel title="客户列表">{loading?<p role="status">正在加载客户…</p>:error?<p role="alert">{error}</p>:customers.length===0?<p>暂无客户</p>:<div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>客户</th><th>账号</th><th>客户等级</th><th>累计订单</th><th>累计消费</th><th>注册时间</th><th>状态</th></tr></thead><tbody>{customers.map(c=><tr key={c.id}><td data-label="客户"><strong>{c.nickname}</strong><small>{c.id}</small></td><td data-label="账号">{c.username}</td><td data-label="客户等级">{c.accountTier}</td><td data-label="累计订单">{c.orderCount}</td><td data-label="累计消费">¥{(c.totalSpendCents/100).toFixed(2)}</td><td data-label="注册时间">{c.createdAt.replace('T',' ').slice(0,19)}</td><td data-label="状态"><Status tone={c.accountStatus==='active'?'ok':'warn'}>{c.accountStatus==='active'?'正常':c.accountStatus==='frozen'?'冻结':'停用'}</Status></td></tr>)}</tbody></table></div>}</Panel></Layout>
}

type DistributionLevel={id:string;name:string;depth:number;commission:number;discount:number;members:number;status:'启用'|'停用'};
const initialLevels:DistributionLevel[]=[];

export function AdminDistribution(){
  const [levels,setLevels]=useState(initialLevels);
  const [showAdd,setShowAdd]=useState(false);
  const [showRelation,setShowRelation]=useState(false);
  const [newLevelName,setNewLevelName]=useState('');
  const [newCommission,setNewCommission]=useState(0);
  const updateCommission=(id:string,value:number)=>setLevels(list=>list.map(level=>level.id===id?{...level,commission:Number.isFinite(value)?value:0}:level));
  const toggleLevel=(id:string)=>setLevels(list=>list.map(level=>level.id===id?{...level,status:level.status==='启用'?'停用':'启用'}:level));
  const addLevel=()=>{if(!newLevelName.trim())return;setLevels(list=>[...list,{id:`L${list.length+1}`,name:newLevelName.trim(),depth:list.length+1,commission:newCommission,discount:100,members:0,status:'启用'}]);setNewLevelName('');setNewCommission(0);setShowAdd(false)};
  return <Layout code="A12" title="分销层级管理" desc="管理分销层级、佣金比例、价格权益、成员数量和启停状态。">
    <div className="metric-grid">{[['分销层级',String(levels.length)],['分销成员',String(levels.reduce((sum,l)=>sum+l.members,0))],['本月佣金','¥0.00'],['待结算','¥0.00']].map(([k,v])=><article className="metric-card" key={k}><span>{k}</span><strong>{v}</strong></article>)}</div>
    <div className="distribution-actions"><button className="primary" type="button" onClick={()=>setShowAdd(v=>!v)}>新增层级</button><button className="secondary" type="button" onClick={()=>setShowRelation(v=>!v)}>查看分销关系</button><button className="secondary" type="button">佣金记录</button></div>
    {showAdd&&<Panel title="新增层级"><div className="admin-form inline-customer-form"><label>层级名称<input placeholder="例如：区域代理" value={newLevelName} onChange={e=>setNewLevelName(e.target.value)}/></label><label>佣金比例<input type="number" min="0" max="100" value={newCommission} onChange={e=>setNewCommission(Number(e.target.value))}/></label><label>价格权益<input type="number" min="1" max="100" defaultValue="100"/></label><button className="primary" type="button" onClick={addLevel}>保存层级</button></div></Panel>}
    {showRelation&&<Panel title="分销关系"><p>暂无分销关系</p></Panel>}
    <Panel title="层级规则">{levels.length===0?<p>暂无分销层级</p>:<div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>层级</th><th>级数</th><th>佣金比例</th><th>价格权益</th><th>成员数</th><th>状态</th><th>操作</th></tr></thead><tbody>{levels.map(level=><tr key={level.id}><td data-label="层级"><strong>{level.name}</strong></td><td data-label="级数">第 {level.depth} 级</td><td data-label="佣金比例"><label className="commission-field"><input aria-label={`${level.name}佣金比例`} type="number" min="0" max="100" value={level.commission} onChange={e=>updateCommission(level.id,Number(e.target.value))}/><span>%</span></label></td><td data-label="价格权益">{level.discount}%</td><td data-label="成员数">{level.members}</td><td data-label="状态"><Status tone={level.status==='启用'?'ok':'warn'}>{level.status}</Status></td><td data-label="操作"><button type="button">编辑</button><button type="button" onClick={()=>toggleLevel(level.id)}>{level.status==='启用'?'停用':'启用'}</button></td></tr>)}</tbody></table></div>}<div className="distribution-note"><strong>结算规则</strong><span>佣金比例按订单归属层级计算；本地阶段仅配置规则，不执行真实资金结算。</span></div><button className="primary" type="button">保存规则</button></Panel>
  </Layout>
}



export function AdminSites(){
  return <Layout code="A13" title="分站管理" desc="管理下级分站、分站级别、价格体系、域名和启停状态。">
    <div className="metric-grid">{[['分站总数','0'],['一级分站','0'],['本月新增','0'],['正常运行','0']].map(([k,v])=><article className="metric-card" key={k}><span>{k}</span><strong>{v}</strong></article>)}</div>
    <div className="distribution-actions"><button className="primary">新建分站</button><button className="secondary">层级价格设置</button><button className="secondary">批量调整等级</button></div>
    <Panel title="下级分站"><p>暂无分站</p></Panel>
  </Layout>
}

export function AdminCommissions(){
  return <Layout code="A14" title="佣金结算" desc="查看推广订单佣金、待结算金额、提现申请与结算记录。">
    <div className="metric-grid">{[['本月佣金','¥0.00'],['待结算','¥0.00'],['可提现','¥0.00'],['本月已提现','¥0.00']].map(([k,v])=><article className="metric-card" key={k}><span>{k}</span><strong>{v}</strong></article>)}</div>
    <div className="admin-tabs admin-tabs-actions"><div><button className="active">佣金订单</button><button>提现申请</button><button>结算记录</button></div><button className="secondary">批量结算</button></div>
    <Panel title="佣金订单"><p>暂无佣金记录</p></Panel>
  </Layout>
}

export function AdminProducts(){
  const [items,setItems]=useState<AdminCatalogProduct[]>([]),[query,setQuery]=useState(''),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const load=async()=>{setLoading(true);try{setItems((await getAdminProducts({q:query})).products)}catch{setError('商品加载失败，请重试。')}finally{setLoading(false)}};
  useEffect(()=>{const c=new AbortController();setLoading(true);getAdminProducts({q:query},c.signal).then(r=>setItems(r.products)).catch(()=>{if(!c.signal.aborted)setError('商品加载失败，请重试。')}).finally(()=>{if(!c.signal.aborted)setLoading(false)});return()=>c.abort()},[query]);
  const archive=async(id:string)=>{setError('');try{await archiveAdminProduct(id);await load()}catch{setError('商品归档失败，请重试。')}};
  return <Layout code="A02" title="商品管理" desc="本站商品、售价、成本、库存、交付类型与上下架状态。"><div className="admin-toolbar"><input aria-label="搜索商品" placeholder="商品名称或ID" value={query} onChange={e=>setQuery(e.target.value)}/><Link className="primary primary-link" to="/admin/products/edit?new=1">新增商品</Link></div><Panel title="商品列表">{loading?<p role="status">正在加载商品…</p>:error?<p role="alert">{error}</p>:items.length===0?<p>暂无商品</p>:<ProductTable items={items} onArchive={id=>void archive(id)}/>}</Panel></Layout>
}

export function AdminProductEdit(){
  const [params]=useSearchParams(),navigate=useNavigate();const id=params.get('id')??'',isNew=params.get('new')==='1';
  const [product,setProduct]=useState<AdminCatalogProduct|null>(null),[categories,setCategories]=useState<AdminCatalogCategory[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [draft,setDraft]=useState({name:'新规格',partnerCostCents:0,priceCents:0,stock:0});
  useEffect(()=>{const c=new AbortController();if(isNew){getAdminCategories(c.signal).then(r=>setCategories(r.categories)).catch(()=>setError('分类加载失败，请重试。')).finally(()=>setLoading(false));return()=>c.abort()}if(!id){setError('请选择要编辑的商品。');setLoading(false);return}Promise.all([getAdminProduct(id,c.signal),getAdminCategories(c.signal)]).then(([p,cats])=>{setProduct(p);setCategories(cats.categories)}).catch(()=>{if(!c.signal.aborted)setError('商品配置加载失败，请重试。')}).finally(()=>{if(!c.signal.aborted)setLoading(false)});return()=>c.abort()},[id,isNew]);
  const save=async()=>{if(!product)return;setError('');setNotice('');try{let updated=await updateAdminProduct(product.id,{name:product.name,description:product.description,marketPriceCents:product.marketPriceCents,status:product.status,deliveryType:product.deliveryType,categoryIds:product.categoryIds});for(const spec of product.specs)updated=await updateAdminProductSpec(product.id,spec.id,{name:spec.name,partnerCostCents:spec.partnerCostCents,priceCents:spec.priceCents,stock:spec.stock,status:spec.status});setProduct(updated);setNotice('商品配置已保存。')}catch{setError('保存失败，请检查输入后重试。')}};
  const create=async()=>{setError('');try{const created=await createAdminProduct({name:'新商品',description:'请填写商品说明',marketPriceCents:null,deliveryType:'content',categoryIds:categories[0]?[categories[0].id]:[],spec:draft});navigate(`/admin/products/edit?id=${encodeURIComponent(created.id)}`,{replace:true})}catch{setError('新增商品失败，请重试。')}};
  const addSpec=async()=>{if(!product)return;setError('');try{setProduct(await addAdminProductSpec(product.id,draft));setDraft({name:'新规格',partnerCostCents:0,priceCents:0,stock:0});setNotice('规格已新增。')}catch{setError('新增规格失败，请重试。')}};
  const removeSpec=async(specId:string)=>{if(!product||product.specs.length<=1)return;setError('');try{setProduct(await deleteAdminProductSpec(product.id,specId));setNotice('规格已删除。')}catch{setError('删除规格失败，请重试。')}};
  if(loading)return <Layout code="A03" title="商品编辑与规格配置" desc="本站本地商品配置。"><p role="status">正在加载商品…</p></Layout>;
  if(isNew)return <Layout code="A03" title="新增商品" desc="创建后可继续完善商品资料和增加更多规格。">{error&&<p role="alert">{error}</p>}<Panel title="首个规格"><div className="admin-form"><label>规格名称<input aria-label="新商品规格名称" value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label><label>本地成本<input aria-label="新商品成本" type="number" min="0" step="0.01" value={draft.partnerCostCents/100} onChange={e=>setDraft({...draft,partnerCostCents:Math.round(Number(e.target.value)*100)})}/></label><label>本站售价<input aria-label="新商品售价" type="number" min="0" step="0.01" value={draft.priceCents/100} onChange={e=>setDraft({...draft,priceCents:Math.round(Number(e.target.value)*100)})}/></label><label>库存<input aria-label="新商品库存" type="number" min="0" step="1" value={draft.stock} onChange={e=>setDraft({...draft,stock:Number(e.target.value)})}/></label><button className="primary" type="button" onClick={()=>void create()}>创建商品</button></div></Panel></Layout>;
  if(error&&!product)return <Layout code="A03" title="商品编辑与规格配置" desc="本站本地商品配置。"><p role="alert">{error}</p></Layout>;
  if(!product)return <Layout code="A03" title="商品编辑与规格配置" desc="本站本地商品配置。"><p>商品不存在</p></Layout>;
  return <Layout code="A03" title="商品编辑与规格配置" desc="价格、成本、库存和上下架均以本站数据库为准。">{notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}<div className="admin-form-grid"><Panel title="商品信息"><div className="admin-form"><label>商品标题<input aria-label="商品标题" value={product.name} onChange={e=>setProduct({...product,name:e.target.value})}/></label><label>商品介绍<textarea aria-label="商品介绍" value={product.description} onChange={e=>setProduct({...product,description:e.target.value})}/></label><label>参考价<input aria-label="参考价" type="number" min="0" step="0.01" value={product.marketPriceCents===null?'':(product.marketPriceCents/100).toFixed(2)} onChange={e=>setProduct({...product,marketPriceCents:e.target.value===''?null:Math.round(Number(e.target.value)*100)})}/></label><label>交付类型<select aria-label="交付类型" value={product.deliveryType} onChange={e=>setProduct({...product,deliveryType:e.target.value as 'card'|'content'})}><option value="card">卡密</option><option value="content">内容</option></select></label><label>上架状态<select aria-label="上架状态" value={product.status} onChange={e=>setProduct({...product,status:e.target.value as 'active'|'inactive'})}><option value="active">上架</option><option value="inactive">下架</option></select></label><fieldset><legend>商品分类</legend>{categories.map(c=><label key={c.id}><input type="checkbox" checked={product.categoryIds.includes(c.id)} onChange={e=>setProduct({...product,categoryIds:e.target.checked?[...product.categoryIds,c.id]:product.categoryIds.filter(v=>v!==c.id)})}/>{c.name}</label>)}</fieldset></div></Panel><Panel title="规格与库存">{product.specs.map((spec,index)=><div className="admin-form" key={spec.id}><label>规格名称<input aria-label={index===0&&product.specs.length===1?'规格名称':`规格名称 ${index+1}`} value={spec.name} onChange={e=>setProduct({...product,specs:product.specs.map(x=>x.id===spec.id?{...x,name:e.target.value}:x)})}/></label><label>本地成本<input aria-label={index===0&&product.specs.length===1?'本地成本':`本地成本 ${index+1}`} type="number" min="0" step="0.01" value={(spec.partnerCostCents/100).toFixed(2)} onChange={e=>setProduct({...product,specs:product.specs.map(x=>x.id===spec.id?{...x,partnerCostCents:Math.round(Number(e.target.value)*100)}:x)})}/></label><label>本站售价<input aria-label={index===0&&product.specs.length===1?'本站售价':`本站售价 ${index+1}`} type="number" min="0" step="0.01" value={(spec.priceCents/100).toFixed(2)} onChange={e=>setProduct({...product,specs:product.specs.map(x=>x.id===spec.id?{...x,priceCents:Math.round(Number(e.target.value)*100)}:x)})}/></label><label>本地库存<input aria-label={index===0&&product.specs.length===1?'本地库存':`本地库存 ${index+1}`} type="number" min="0" step="1" value={spec.stock} onChange={e=>setProduct({...product,specs:product.specs.map(x=>x.id===spec.id?{...x,stock:Number(e.target.value)}:x)})}/></label><button className="secondary danger-action" type="button" disabled={product.specs.length<=1} onClick={()=>void removeSpec(spec.id)}>删除规格</button></div>)}<hr/><div className="admin-form"><label>新增规格名称<input aria-label="新增规格名称" value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label><label>新增规格售价<input aria-label="新增规格售价" type="number" value={draft.priceCents/100} onChange={e=>setDraft({...draft,priceCents:Math.round(Number(e.target.value)*100)})}/></label><label>新增规格成本<input aria-label="新增规格成本" type="number" value={draft.partnerCostCents/100} onChange={e=>setDraft({...draft,partnerCostCents:Math.round(Number(e.target.value)*100)})}/></label><label>新增规格库存<input aria-label="新增规格库存" type="number" value={draft.stock} onChange={e=>setDraft({...draft,stock:Number(e.target.value)})}/></label><button className="secondary" type="button" onClick={()=>void addSpec()}>新增规格</button></div></Panel></div><button className="primary" type="button" onClick={()=>void save()}>保存商品</button></Layout>
}

export function AdminPricing(){return <Layout code="A04" title="定价规则" desc="全局、分类、商品级定价规则与价格预览。"><Panel title="全局基础规则"><div className="formula">本站售价 = 上游成本 × <input aria-label="全局加价倍数" defaultValue="1.25"/></div><div className="rounding"><label><input type="radio" name="r" defaultChecked/> 四舍五入</label><label><input type="radio" name="r"/> 向上取整</label></div><button className="primary">保存规则</button></Panel><div className="admin-two-col"><Panel title="分类定价规则"><p>暂无分类定价规则</p></Panel><Panel title="价格预览"><p>输入真实成本后显示价格预览</p></Panel></div><Panel title="商品级规则"><p>暂无商品级定价规则</p><div className="rule-row"><span>规则优先级</span><strong>商品规则 ＞ 分类规则 ＞ 全局规则</strong></div></Panel></Layout>}
export function AdminOrders(){
  const [orders,setOrders]=useState<AdminOrderRecord[]>([]);const [query,setQuery]=useState('');const [status,setStatus]=useState<CustomerOrderStatus|''>('');const [loading,setLoading]=useState(true);const [error,setError]=useState('');
  useEffect(()=>{const c=new AbortController();setLoading(true);setError('');getAdminOrders({q:query,status:status||undefined},c.signal).then(r=>setOrders(r.orders)).catch(()=>{if(!c.signal.aborted)setError('订单加载失败，请重试。')}).finally(()=>{if(!c.signal.aborted)setLoading(false)});return()=>c.abort()},[query,status]);
  const save=async(order:AdminOrderRecord,manualStatus:'none'|'reviewing'|'held',note:string)=>{try{const updated=await updateAdminOrderManual(order.id,{manualStatus,note});setOrders(list=>list.map(x=>x.id===updated.id?updated:x))}catch{setError('人工处理状态保存失败，请重试。')}};
  return <Layout code="A05" title="订单管理" desc="订单搜索、支付状态、交付状态、详情与人工处理。"><div className="admin-toolbar"><input aria-label="订单搜索" placeholder="订单号、用户、商品" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="订单状态筛选" value={status} onChange={e=>setStatus(e.target.value as CustomerOrderStatus|'')}><option value="">全部状态</option><option value="pending_payment">待支付</option><option value="processing">处理中</option><option value="completed">已完成</option><option value="after_sale">售后</option><option value="cancelled">已取消</option></select></div><Panel title="订单列表">{loading?<p role="status">正在加载订单…</p>:error?<p role="alert">{error}</p>:orders.length===0?<p>暂无订单</p>:<div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>订单号</th><th>用户</th><th>金额</th><th>订单状态</th><th>支付状态</th><th>交付状态</th><th>人工处理</th><th>备注</th><th>操作</th></tr></thead><tbody>{orders.map(order=><AdminOrderRow key={order.id} order={order} onSave={save}/>)}</tbody></table></div>}</Panel></Layout>
}
function AdminOrderRow({order,onSave}:{order:AdminOrderRecord;onSave:(order:AdminOrderRecord,status:'none'|'reviewing'|'held',note:string)=>Promise<void>}){const [manual,setManual]=useState(order.manualProcessingStatus);const [note,setNote]=useState(order.adminNote??'');useEffect(()=>{setManual(order.manualProcessingStatus);setNote(order.adminNote??'')},[order]);const manualText=order.manualProcessingStatus==='reviewing'?'人工复核':order.manualProcessingStatus==='held'?'已挂起':'正常';return <tr><td data-label="订单号">{order.orderNumber}</td><td data-label="用户">{order.username}</td><td data-label="金额">¥{(order.totalAmountCents/100).toFixed(2)}</td><td data-label="订单状态">{order.status==='pending_payment'?'待支付':order.status==='processing'?'处理中':order.status==='completed'?'已完成':order.status==='after_sale'?'售后':'已取消'}</td><td data-label="支付状态">{order.paymentStatus==='paid'?'已支付':order.paymentStatus==='unpaid'?'待支付':order.paymentStatus}</td><td data-label="交付状态">{order.deliveryStatus==='delivered'?'已交付':order.deliveryStatus==='pending'?'待交付':order.deliveryStatus}</td><td data-label="人工处理"><span>{manualText}</span><select aria-label={`人工处理 ${order.orderNumber}`} value={manual} onChange={e=>setManual(e.target.value as 'none'|'reviewing'|'held')}><option value="none">正常</option><option value="reviewing">人工复核</option><option value="held">挂起</option></select></td><td data-label="备注"><input aria-label={`管理员备注 ${order.orderNumber}`} value={note} onChange={e=>setNote(e.target.value)}/></td><td data-label="操作"><button type="button" onClick={()=>void onSave(order,manual,note)} aria-label={`保存 ${order.orderNumber}`}>保存</button></td></tr>}
export function AdminFulfillment(){
  const [jobs,setJobs]=useState<FulfillmentJob[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const [asset,setAsset]=useState({productId:'',specId:'',deliveryKind:'card' as 'card'|'content',payload:''});const [manual,setManual]=useState({orderId:'',deliveryKind:'card' as 'card'|'content',payload:''});
  const refresh=()=>{setLoading(true);getFulfillmentJobs().then(r=>setJobs(r.jobs)).catch(()=>setError('发货任务加载失败，请重试。')).finally(()=>setLoading(false))};useEffect(()=>{refresh()},[]);
  const addAsset=async()=>{setError('');setNotice('');try{await addFulfillmentAsset(asset);setNotice('交付资产已安全入库。');setAsset({...asset,payload:''})}catch{setError('交付资产导入失败，请检查商品、规格和内容。')}};
  const fulfill=async()=>{setError('');setNotice('');try{await manualFulfillOrder(manual.orderId,{deliveryKind:manual.deliveryKind,payload:manual.payload});setNotice('人工发货完成。');setManual({...manual,payload:''});refresh()}catch{setError('人工发货失败，请确认订单已支付且尚未完成交付。')}};
  return <Layout code="A06" title="发货与异常处理" desc="支付成功后自动发货；无可用资产时进入人工发货队列。"><div className="admin-two-col"><Panel title="交付资产入库"><div className="admin-form"><label>商品ID<input aria-label="交付资产商品ID" value={asset.productId} onChange={e=>setAsset({...asset,productId:e.target.value})}/></label><label>规格ID<input aria-label="交付资产规格ID" value={asset.specId} onChange={e=>setAsset({...asset,specId:e.target.value})}/></label><label>类型<select aria-label="交付资产类型" value={asset.deliveryKind} onChange={e=>setAsset({...asset,deliveryKind:e.target.value as 'card'|'content'})}><option value="card">卡密</option><option value="content">内容</option></select></label><label>交付内容<textarea aria-label="交付资产内容" value={asset.payload} onChange={e=>setAsset({...asset,payload:e.target.value})}/></label><button className="primary" type="button" onClick={()=>void addAsset()}>安全入库</button></div></Panel><Panel title="人工发货"><div className="admin-form"><label>订单ID<input aria-label="人工发货订单ID" value={manual.orderId} onChange={e=>setManual({...manual,orderId:e.target.value})}/></label><label>类型<select aria-label="人工发货类型" value={manual.deliveryKind} onChange={e=>setManual({...manual,deliveryKind:e.target.value as 'card'|'content'})}><option value="card">卡密</option><option value="content">内容</option></select></label><label>交付内容<textarea aria-label="人工发货内容" value={manual.payload} onChange={e=>setManual({...manual,payload:e.target.value})}/></label><button className="primary" type="button" onClick={()=>void fulfill()}>确认发货</button></div></Panel></div>{notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}<Panel title="发货任务">{loading?<p role="status">正在加载发货任务…</p>:jobs.length===0?<p>暂无发货任务</p>:<div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>订单号</th><th>模式</th><th>状态</th><th>异常</th><th>更新时间</th></tr></thead><tbody>{jobs.map(j=><tr key={j.orderId}><td>{j.orderNumber}</td><td>{j.mode==='auto'?'自动':'人工'}</td><td>{j.status}</td><td>{j.lastError??'—'}</td><td>{j.updatedAt.replace('T',' ').slice(0,19)}</td></tr>)}</tbody></table></div>}</Panel></Layout>
}
export function AdminSync(){return <Layout code="A07" title="外部供货" desc="当前本站按本地商品、库存和交付资产独立运营。"><Panel title="当前状态"><div className="resource-connection"><div><strong>外部供货暂不启用</strong><small>不会同步商品、价格、库存，也不会自动向上游采购或取卡。</small></div><Status tone="info">已暂停</Status></div></Panel><Panel title="本站供货方式"><div className="sync-scope-grid"><span>✓ 本地商品数据库</span><span>✓ 本地规格与库存</span><span>✓ 本地交付资产</span><span>✓ 自动/人工发货</span></div></Panel></Layout>}
export function AdminPayments(){const [config,setConfig]=useState<AdminPaymentConfig|null>(null);const [error,setError]=useState('');useEffect(()=>{const c=new AbortController();getAdminPaymentConfig(c.signal).then(setConfig).catch(()=>{if(!c.signal.aborted)setError('支付配置状态加载失败，请重试。')});return()=>c.abort()},[]);return <Layout code="A08" title="支付配置" desc="支付密钥仅从服务端环境变量读取；后台不展示或保存密钥。">{error?<p role="alert">{error}</p>:!config?<p role="status">正在加载支付配置…</p>:<div className="payment-config-grid"><Panel title="微信支付"><div className="uc-setting-list"><p><span>配置状态</span><Status tone={config.wechat.configured?'ok':'warn'}>{config.wechat.configured?'已就绪':'未配置'}</Status></p><p><span>商户号</span><strong>{config.wechat.merchantId??'—'}</strong></p><p><span>异步回调</span><code>{config.wechat.callbackPath}</code></p></div></Panel><Panel title="支付宝"><div className="uc-setting-list"><p><span>配置状态</span><Status tone={config.alipay.configured?'ok':'warn'}>{config.alipay.configured?'已就绪':'未配置'}</Status></p><p><span>应用ID</span><strong>{config.alipay.appId??'—'}</strong></p><p><span>异步回调</span><code>{config.alipay.callbackPath}</code></p></div></Panel></div>}</Layout>}
export function AdminBrand(){return <Layout code="A09" title="站点品牌与联系方式" desc="站点名称、Logo、客服、加盟联系方式、工作时间与页面预览。"><div className="admin-form-grid"><Panel title="站点基本信息"><div className="admin-form"><label>网站名称<input defaultValue="51mai"/></label><label>网站副标题<input defaultValue="优质数字资源，助力高效创作"/></label><label>Logo<input aria-label="Logo" type="file"/></label><label>Favicon<input aria-label="Favicon" type="file"/></label><label>客服二维码<input aria-label="客服二维码" type="file"/></label><label>客服联系方式<input placeholder="待配置"/></label><label>加盟联系方式<input placeholder="待配置"/></label><label>工作时间<input defaultValue="09:00–21:00"/></label><button className="primary">保存设置</button></div></Panel><Panel title="页面预览"><div className="brand-preview"><strong><span>51</span>mai</strong><h3>优质数字资源<br/>助力高效创作</h3><div className="preview-search">搜索数字资源…</div></div></Panel></div></Layout>}
export function AdminSecurity(){return <Layout code="A10" title="系统日志与权限" desc="操作日志、角色权限、配置变更和安全审计。"><div className="admin-tabs admin-tabs-actions"><div><button className="active">操作日志</button><button>角色权限</button><button>配置变更</button><button>安全告警</button></div><button className="secondary export-log" type="button">导出日志</button></div><Toolbar/><Panel title="操作记录"><p>暂无可展示的持久化操作日志。</p></Panel></Layout>}
