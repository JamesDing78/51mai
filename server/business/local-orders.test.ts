// @vitest-environment node
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { loadDatabaseConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { SessionManager, type AuthUser } from '../auth/sessions.js';
import { registerBusiness } from './routes.js';

const database=(process.env.TEST_DATABASE_NAME??process.env.TEST_DB_NAME)?.trim();
const allowlist=new Set((process.env.TEST_DATABASE_ALLOWLIST??'').split(',').map(value=>value.trim()).filter(Boolean));
const enabled=Boolean(database)&&allowlist.has(database as string)&&process.env.DB_NAME===database;

async function listen(app:Express){
  const server=createServer(app);
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  const address=server.address(); if(!address||typeof address==='string') throw new Error('no port');
  return {server,baseUrl:`http://127.0.0.1:${address.port}`};
}
const cookiePair=(header:string)=>header.split(';',1)[0]??'';

describe.skipIf(!enabled)('local storefront order creation',()=>{
  let pool:Pool; let server:Server; let baseUrl=''; let sessions:SessionManager;
  const users:string[]=[]; const orders:string[]=[]; const key=Buffer.alloc(32,0x67);
  const productId=`test-order-${randomUUID()}`; const specId=`${productId}-s1`;

  async function addUser(){
    const id=randomUUID(),username=`local_order_${id.slice(0,8)}`;
    await pool.execute("INSERT INTO users (id,username_normalized,password_hash,account_status,role) VALUES (?,?,NULL,'active','customer')",[id,username]);
    users.push(id); return {id,username,role:'customer'} as AuthUser;
  }
  async function auth(user:AuthUser){const issued=await sessions.issueSession(user);return {cookie:cookiePair(issued.cookieHeader),csrf:issued.csrfToken}}
  async function post(authContext:{cookie:string;csrf:string},body:Record<string,unknown>){
    return fetch(`${baseUrl}/api/orders`,{method:'POST',headers:{Cookie:authContext.cookie,Origin:'https://51mai.example.test','X-CSRF-Token':authContext.csrf,'Content-Type':'application/json'},body:JSON.stringify(body)});
  }

  beforeAll(async()=>{
    if(!database) throw new Error('missing test database');
    pool=createPool({...loadDatabaseConfig(),database}); await migrate(pool);
    await pool.execute("INSERT INTO local_products (id,name,description,image_path,icon,market_price_cents,delivery_type,status) VALUES (?, '订单测试商品','订单测试说明',NULL,'测',19900,'content','active')",[productId]);
    await pool.execute("INSERT INTO local_product_specs (id,product_id,name,partner_cost_cents,price_cents,status,sort_order) VALUES (?,?,'默认规格',9900,12375,'active',1)",[specId,productId]);
    await pool.execute('INSERT INTO local_product_inventory (product_id,spec_id,available_quantity) VALUES (?,?,100)',[productId,specId]);
    sessions=new SessionManager({pool,cookieName:'51mai_test_session',secureCookie:false,authHmacKey:key,sessionTtlSeconds:3600,rememberSessionTtlSeconds:7200});
    const apiRouter=express.Router(); registerBusiness(apiRouter,{pool,allowOrigin:'https://51mai.example.test',authHmacKey:key,cookieName:'51mai_test_session',secureCookie:false,sessionTtlSeconds:3600,rememberSessionTtlSeconds:7200});
    const listening=await listen(createApp({apiRouter})); server=listening.server;baseUrl=listening.baseUrl;
  });
  afterAll(async()=>{
    if(orders.length) await pool.query(`DELETE FROM orders WHERE id IN (${orders.map(()=>'?').join(',')})`,orders);
    await pool.execute('DELETE FROM local_product_inventory WHERE product_id=? AND spec_id=?',[productId,specId]);
    await pool.execute('DELETE FROM local_product_specs WHERE product_id=?',[productId]);
    await pool.execute('DELETE FROM local_products WHERE id=?',[productId]);
    if(users.length) await pool.query(`DELETE FROM users WHERE id IN (${users.map(()=>'?').join(',')})`,users);
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); await pool.end();
  });

  it('creates one pending local order from the server catalog and ignores client price fields',async()=>{
    const user=await addUser(),session=await auth(user); const idempotencyKey=randomUUID();
    const first=await post(session,{productId,specId,quantity:2,idempotencyKey,unitPriceCents:1});
    expect(first.status).toBe(201); const created=(await first.json() as any).data; orders.push(created.id);
    expect(created).toMatchObject({status:'pending_payment',paymentStatus:'unpaid',deliveryStatus:'pending',totalAmountCents:24750,paymentAvailable:false});
    expect(created.items[0]).toMatchObject({productId,specName:'默认规格',unitPriceCents:12375,quantity:2,lineTotalCents:24750});

    const repeated=await post(session,{productId,specId,quantity:2,idempotencyKey});
    expect(repeated.status).toBe(200); expect((await repeated.json() as any).data.id).toBe(created.id);
    const [rows]=await pool.execute<RowDataPacket[]>('SELECT COUNT(*) AS total FROM orders WHERE user_id=? AND client_request_id=?',[user.id,idempotencyKey]);
    expect(Number(rows[0]?.total)).toBe(1);
  });

  it('rejects unknown products and quantities above local stock without creating an order',async()=>{
    const user=await addUser(),session=await auth(user);
    const unknown=await post(session,{productId:'missing',specId:'missing-s1',quantity:1,idempotencyKey:randomUUID()});
    expect(unknown.status).toBe(400); expect((await unknown.json() as any).error.code).toBe('PRODUCT_UNAVAILABLE');
    const excessive=await post(session,{productId,specId,quantity:101,idempotencyKey:randomUUID()});
    expect(excessive.status).toBe(409); expect((await excessive.json() as any).error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('requires the current session CSRF token',async()=>{
    const user=await addUser(),session=await auth(user);
    const response=await fetch(`${baseUrl}/api/orders`,{method:'POST',headers:{Cookie:session.cookie,Origin:'https://51mai.example.test','Content-Type':'application/json'},body:JSON.stringify({productId,specId,quantity:1,idempotencyKey:randomUUID()})});
    expect(response.status).toBe(403);
  });
});
