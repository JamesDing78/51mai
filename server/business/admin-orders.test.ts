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

const db=(process.env.TEST_DATABASE_NAME??process.env.TEST_DB_NAME)?.trim();
const allow=new Set((process.env.TEST_DATABASE_ALLOWLIST??'').split(',').map(v=>v.trim()).filter(Boolean));
const enabled=Boolean(db)&&allow.has(db as string)&&process.env.DB_NAME===db;
async function listen(app:Express){const server=createServer(app);await new Promise<void>((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r)});const a=server.address();if(!a||typeof a==='string')throw new Error('no port');return {server,base:`http://127.0.0.1:${a.port}`}}
const cookiePair=(h:string)=>h.split(';',1)[0]??'';

describe.skipIf(!enabled)('Phase 10 admin order operations',()=>{
 let pool:Pool,server:Server,base='';let sessions:SessionManager;const users:string[]=[];const orders:string[]=[];const key=Buffer.alloc(32,0x70);
 async function user(role:'customer'|'admin'){const id=randomUUID(),username=`p10_${role}_${id.slice(0,8)}`;await pool.execute("INSERT INTO users (id,username_normalized,password_hash,account_status,role) VALUES (?,?,NULL,'active',?)",[id,username,role]);users.push(id);return {id,username,role} as AuthUser}
 async function auth(u:AuthUser){const x=await sessions.issueSession(u);return {cookie:cookiePair(x.cookieHeader),csrf:x.csrfToken}}
 beforeAll(async()=>{if(!db)throw new Error('missing db');pool=createPool({...loadDatabaseConfig(),database:db});await migrate(pool);sessions=new SessionManager({pool,cookieName:'51mai_test_session',secureCookie:false,authHmacKey:key,sessionTtlSeconds:3600,rememberSessionTtlSeconds:7200});const api=express.Router();registerBusiness(api,{pool,allowOrigin:'https://51mai.example.test',authHmacKey:key,cookieName:'51mai_test_session',secureCookie:false,sessionTtlSeconds:3600,rememberSessionTtlSeconds:7200});const l=await listen(createApp({apiRouter:api}));server=l.server;base=l.base});
 afterAll(async()=>{if(orders.length)await pool.query(`DELETE FROM orders WHERE id IN (${orders.map(()=>'?').join(',')})`,orders);if(users.length)await pool.query(`DELETE FROM users WHERE id IN (${users.map(()=>'?').join(',')})`,users);await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));await pool.end()});
 it('lets admins list real orders and set manual handling state without changing payment/delivery state',async()=>{const customer=await user('customer'),admin=await user('admin');const a=await auth(admin),c=await auth(customer);const id=randomUUID();orders.push(id);await pool.execute("INSERT INTO orders (id,order_number,user_id,status,payment_status,delivery_status,total_amount_cents) VALUES (?,?,?,'pending_payment','unpaid','pending',9900)",[id,'P10-ORDER',customer.id]);
   const forbidden=await fetch(`${base}/api/admin/orders`,{headers:{Cookie:c.cookie}});expect(forbidden.status).toBe(403);
   const list=await fetch(`${base}/api/admin/orders?q=P10-ORDER`,{headers:{Cookie:a.cookie}});expect(list.status).toBe(200);const ordersBody=(await list.json() as any).data.orders;expect(ordersBody).toHaveLength(1);expect(ordersBody[0]).toMatchObject({id,orderNumber:'P10-ORDER',paymentStatus:'unpaid',deliveryStatus:'pending',manualProcessingStatus:'none'});
   const patch=await fetch(`${base}/api/admin/orders/${id}/manual`,{method:'PATCH',headers:{Cookie:a.cookie,Origin:'https://51mai.example.test','X-CSRF-Token':a.csrf,'Content-Type':'application/json'},body:JSON.stringify({manualStatus:'reviewing',note:'等待人工核验'})});expect(patch.status).toBe(200);const updated=(await patch.json() as any).data;expect(updated).toMatchObject({manualProcessingStatus:'reviewing',adminNote:'等待人工核验',paymentStatus:'unpaid',deliveryStatus:'pending'});
   const [rows]=await pool.execute<RowDataPacket[]>('SELECT manual_processing_status,admin_note,payment_status,delivery_status FROM orders WHERE id=?',[id]);expect(rows[0]).toMatchObject({manual_processing_status:'reviewing',admin_note:'等待人工核验',payment_status:'unpaid',delivery_status:'pending'});
 });
});
