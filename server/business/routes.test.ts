// @vitest-environment node

import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import type { Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { loadDatabaseConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { SessionManager, type AuthUser } from '../auth/sessions.js';
import { registerBusiness } from './routes.js';

const explicitTestDatabase = (process.env.TEST_DATABASE_NAME ?? process.env.TEST_DB_NAME)?.trim();
const allowlist = new Set((process.env.TEST_DATABASE_ALLOWLIST ?? '').split(',').map(v=>v.trim()).filter(Boolean));
const integrationEnabled = Boolean(explicitTestDatabase) && allowlist.has(explicitTestDatabase as string) && process.env.DB_NAME === explicitTestDatabase;

async function listen(app: Express): Promise<{server:Server;baseUrl:string}> {
  const server=createServer(app);
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  const address=server.address(); if(!address||typeof address==='string') throw new Error('no port');
  return {server,baseUrl:`http://127.0.0.1:${address.port}`};
}
function cookiePair(header:string){return header.split(';',1)[0] ?? ''}

describe.skipIf(!integrationEnabled)('Phase 3 customer and order API',()=>{
  let pool:Pool; let server:Server; let baseUrl=''; let sessions:SessionManager;
  const createdUsers:string[]=[]; const createdOrders:string[]=[];
  const authHmacKey=Buffer.alloc(32,0x35);

  async function addUser(role:'customer'|'admin'='customer', nickname='测试用户'){
    const id=randomUUID(); const username=`phase3_${id.slice(0,8)}`;
    await pool.execute("INSERT INTO users (id, username_normalized, password_hash, account_status, role) VALUES (?, ?, NULL, 'active', ?)",[id,username,role]);
    await pool.execute("INSERT INTO user_profiles (user_id, nickname, account_tier) VALUES (?, ?, '普通用户')",[id,nickname]);
    createdUsers.push(id); return {id,username,role} as AuthUser;
  }
  async function sessionFor(user:AuthUser){const issued=await sessions.issueSession(user);return {cookie:cookiePair(issued.cookieHeader),csrf:issued.csrfToken}}
  async function addOrder(userId:string, opts:{orderNumber:string;productName:string;status?:string;amountCents?:number}){
    const orderId=randomUUID(); const itemId=randomUUID(); const amount=opts.amountCents ?? 12900;
    await pool.execute("INSERT INTO orders (id, order_number, user_id, status, payment_status, delivery_status, total_amount_cents) VALUES (?, ?, ?, ?, 'paid', 'delivered', ?)",[orderId,opts.orderNumber,userId,opts.status ?? 'completed',amount]);
    await pool.execute("INSERT INTO order_items (id, order_id, product_id, product_name, spec_name, unit_price_cents, quantity, line_total_cents, product_image_path) VALUES (?, ?, 'p-001', ?, '默认规格', ?, 1, ?, '/products/source-001.png')",[itemId,orderId,opts.productName,amount,amount]);
    createdOrders.push(orderId); return orderId;
  }
  async function get(path:string,cookie?:string){return fetch(`${baseUrl}${path}`,{headers:cookie?{Cookie:cookie}:{}})}

  beforeAll(async()=>{
    if(!explicitTestDatabase) throw new Error('missing test db');
    pool=createPool({...loadDatabaseConfig(),database:explicitTestDatabase});
    await migrate(pool);
    sessions=new SessionManager({pool,cookieName:'51mai_test_session',secureCookie:false,authHmacKey,sessionTtlSeconds:3600,rememberSessionTtlSeconds:7200});
    const apiRouter=express.Router();
    registerBusiness(apiRouter,{pool,allowOrigin:'https://51mai.example.test',authHmacKey,cookieName:'51mai_test_session',secureCookie:false,sessionTtlSeconds:3600,rememberSessionTtlSeconds:7200});
    const listening=await listen(createApp({apiRouter})); server=listening.server;baseUrl=listening.baseUrl;
  });
  afterAll(async()=>{
    if(createdOrders.length) await pool.query(`DELETE FROM orders WHERE id IN (${createdOrders.map(()=>'?').join(',')})`,createdOrders);
    if(createdUsers.length) await pool.query(`DELETE FROM users WHERE id IN (${createdUsers.map(()=>'?').join(',')})`,createdUsers);
    await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())); await pool.end();
  });

  it('returns authenticated account summary from MySQL and no demo balances',async()=>{
    const user=await addUser('customer','真实昵称'); const auth=await sessionFor(user);
    await addOrder(user.id,{orderNumber:`P3-${Date.now()}-1`,productName:'真实商品',amountCents:25800});
    const res=await get('/api/account/summary',auth.cookie); expect(res.status).toBe(200);
    const body=await res.json() as any;
    expect(body.data.user).toMatchObject({id:user.id,username:user.username,nickname:'真实昵称',accountTier:'普通用户'});
    expect(body.data.orderCount).toBe(1); expect(body.data.totalSpendCents).toBe(25800);
  });

  it('lists only the authenticated customer orders and hides another customer order',async()=>{
    const first=await addUser(); const second=await addUser(); const firstAuth=await sessionFor(first);
    const ownId=await addOrder(first.id,{orderNumber:`P3-${Date.now()}-2`,productName:'我的商品'});
    const otherId=await addOrder(second.id,{orderNumber:`P3-${Date.now()}-3`,productName:'别人的商品'});
    const list=await get('/api/orders',firstAuth.cookie); expect(list.status).toBe(200); const listBody=await list.json() as any;
    expect(listBody.data.orders.map((x:any)=>x.id)).toContain(ownId); expect(listBody.data.orders.map((x:any)=>x.id)).not.toContain(otherId);
    const forbidden=await get(`/api/orders/${otherId}`,firstAuth.cookie); expect(forbidden.status).toBe(404);
  });

  it('admin customer list uses real user/order aggregates and customer access is forbidden',async()=>{
    const customer=await addUser('customer','客户甲'); const customerAuth=await sessionFor(customer);
    await addOrder(customer.id,{orderNumber:`P3-${Date.now()}-4`,productName:'订单商品',amountCents:8800});
    const forbidden=await get('/api/admin/customers',customerAuth.cookie); expect(forbidden.status).toBe(403);
    const admin=await addUser('admin','管理员'); const adminAuth=await sessionFor(admin);
    const res=await get('/api/admin/customers?q=客户甲',adminAuth.cookie); expect(res.status).toBe(200); const body=await res.json() as any;
    const row=body.data.customers.find((x:any)=>x.id===customer.id);
    expect(row).toMatchObject({nickname:'客户甲',orderCount:1,totalSpendCents:8800,accountStatus:'active',accountTier:'普通用户'});
  });
});
