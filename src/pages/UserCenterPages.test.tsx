import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, vi } from 'vitest';
import { UserDashboard, UserOrders, UserFootmarks, UserAfterSales, UserFinance, UserSpread, UserAccount, UserRecharge, UserWithdraw, UserFavorites, UserMessages, UserCards, UserMemberLevel, GoodsPriceLog } from './UserCenterPages';


const apiResponse=(data:unknown)=>new Response(JSON.stringify({data}),{status:200,headers:{'Content-Type':'application/json'}});
beforeEach(()=>{vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input);if(url.startsWith('/api/account/summary'))return Promise.resolve(apiResponse({user:{id:'u-test',username:'user_test',nickname:'测试用户',accountTier:'普通用户',accountStatus:'active',createdAt:'2026-10-23 06:00:00'},orderCount:2,totalSpendCents:35800}));if(url==='/api/account/security')return Promise.resolve(apiResponse({profile:{username:'user_test',nickname:'测试用户',accountTier:'普通用户',hasPassword:true},contacts:[{kind:'phone',masked:'+86138****5678',verified:true},{kind:'email',masked:'us***@mail.test',verified:true}]}));if(url==='/api/account/login-logs')return Promise.resolve(apiResponse({loginLogs:[{id:'l1',succeeded:true,attemptedAt:'2026-10-23T08:30:00Z',ipAddress:'127.0.0.*',userAgent:'Chrome/155 · macOS'}]}));if(url.startsWith('/api/finance/summary'))return Promise.resolve(apiResponse({availableBalanceCents:0,commissionBalanceCents:0,frozenBalanceCents:0}));if(url.startsWith('/api/finance/transactions'))return Promise.resolve(apiResponse({transactions:[]}));if(url==='/api/recharges'&&(init?.method??'GET')==='POST')return Promise.resolve(apiResponse({id:'r-test',rechargeNumber:'R-TEST',amountCents:50000,channel:'alipay',status:'pending_payment',createdAt:'2026-10-23 06:00:00',updatedAt:'2026-10-23 06:00:00',paymentAvailable:false}));if(url.startsWith('/api/recharges'))return Promise.resolve(apiResponse({recharges:[]}));if(url.startsWith('/api/price-logs'))return Promise.resolve(apiResponse({priceLogs:[]}));if(url.startsWith('/api/orders'))return Promise.resolve(apiResponse({orders:[]}));return Promise.resolve(apiResponse({}));}))});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()});

const pages=[
 [UserDashboard,'用户中心'],[UserOrders,'订单记录'],[UserFootmarks,'我的足迹'],[UserAfterSales,'售后列表'],[UserFinance,'财务明细'],[UserSpread,'推广分销'],[UserAccount,'账户管理'],[UserRecharge,'余额充值'],[UserWithdraw,'提现管理'],[UserFavorites,'关注商品'],[UserMessages,'消息通知'],[UserCards,'卡密列表'],
] as const;

describe('分站核心用户中心能力',()=>{
 it.each(pages)('%s 展示 %s', (Page,title)=>{render(<MemoryRouter><Page/></MemoryRouter>);expect(screen.getByRole('heading',{name:title})).toBeInTheDocument();});
 it('用户中心展示真实账号与订单消费摘要',async()=>{render(<MemoryRouter><UserDashboard/></MemoryRouter>);expect(await screen.findByText('测试用户')).toBeInTheDocument();expect(screen.getByText('2 笔订单')).toBeInTheDocument();expect(screen.getByText('¥358.00')).toBeInTheDocument();expect(screen.getByText('账号状态')).toBeInTheDocument();});
 it('推广分销保留核心指标但未有真实归因时不伪造推广链接',async()=>{render(<MemoryRouter><UserSpread/></MemoryRouter>);for(const x of ['推广用户','推广订单','累计佣金','可提佣金']) expect(screen.getAllByText(x).length).toBeGreaterThanOrEqual(1);expect(await screen.findByText(/推广关系.*未接入真实/)).toBeInTheDocument();expect(screen.queryByDisplayValue(/U10001/)).not.toBeInTheDocument();});
 it('财务明细包含资金、佣金与充值三个核心视图',()=>{render(<MemoryRouter><UserFinance/></MemoryRouter>);for(const x of ['资金明细','佣金明细','充值明细']) expect(screen.getByRole('button',{name:x})).toBeInTheDocument();});

 it('账户管理读取真实安全信息且未验证写操作不伪造成功',async()=>{const user=userEvent.setup();render(<MemoryRouter><UserAccount/></MemoryRouter>);expect(await screen.findByDisplayValue('测试用户')).toBeInTheDocument();expect(screen.getByText('+86138****5678')).toBeInTheDocument();await user.click(screen.getByRole('button',{name:'实名认证'}));expect(screen.getByRole('button',{name:'提交认证'})).toBeDisabled();await user.click(screen.getByRole('button',{name:'通知设置'}));expect(screen.getByText('通知偏好尚未接入真实配置')).toBeInTheDocument();await user.click(screen.getByRole('button',{name:'登录记录'}));expect(screen.getByText('Chrome/155 · macOS')).toBeInTheDocument();});
 it('充值提交后生成待支付记录',async()=>{const user=userEvent.setup();render(<MemoryRouter><UserRecharge/></MemoryRouter>);await user.click(screen.getByRole('button',{name:/立即充值/}));expect(screen.getByText('待支付')).toBeInTheDocument();});
 it('提现规则未验证时不伪造申请成功记录',async()=>{render(<MemoryRouter><UserWithdraw/></MemoryRouter>);expect(await screen.findByRole('button',{name:'申请提现'})).toBeDisabled();expect(await screen.findByText('暂无提现记录')).toBeInTheDocument();expect(screen.queryByText('审核中')).not.toBeInTheDocument();});
 it('提供会员升级与调价信息功能',()=>{render(<MemoryRouter><UserMemberLevel/></MemoryRouter>);expect(screen.getByRole('heading',{name:'会员升级'})).toBeInTheDocument();render(<MemoryRouter><GoodsPriceLog/></MemoryRouter>);expect(screen.getByRole('heading',{name:'调价信息'})).toBeInTheDocument();});
});
