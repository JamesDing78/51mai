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

const db=(process.env.TEST_DATABASE_NAME??process.env.TEST_DB_NAME)?.trim();
const allow=new Set((process.env.TEST_DATABASE_ALLOWLIST??'').split(',').map(v=>v.trim()).filter(Boolean));
const enabled=Boolean(db)&&allow.has(db as string)&&process.env.DB_NAME===db;
async function listen(app:Express){const server=createServer(app);await new Promise<void>((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r)});const a=server.address();if(!a||typeof a==='string')throw new Error('no port');return {server,base:`http://127.0.0.1:${a.port}`}}
const cookiePair=(h:string)=>h.split(';',1)[0]??'';

describe.skipIf(!enabled)('Phase 4 finance persistence',()=>{
 let pool:Pool,server:Server,base='';let sessions:SessionManager;const users:string[]=[];const recharges:string[]=[];const txs:string[]=[];const key=Buffer.alloc(32,0x45);
 async function user(){const id=randomUUID(),username=`p4_${id.slice(0,8)}`;await pool.execute("INSERT INTO users (id,username_normalized,password_hash,account_status,role) VALUES (?,?,NULL,'active','customer')",[id,username]);users.push(id);return {id,username,role:'customer'} as AuthUser}
 async function auth(u:AuthUser){const x=await sessions.issueSession(u);return {cookie:cookiePair(x.cookieHeader),csrf:x.csrfToken}}
 async function req(path:string,a:{cookie:string;csrf:string},init:RequestInit={}){return fetch(`${base}${path}`,{...init,headers:{Cookie:a.cookie,Origin:'https://51mai.example.test','X-CSRF-Token':a.csrf,'Content-Type':'application/json',...(init.headers??{})}})}
 beforeAll(async()=>{if(!db)throw new Error('missing db');pool=createPool({...loadDatabaseConfig(),database:db});await migrate(pool);sessions=new SessionManager({pool,cookieName:'51mai_test_session',secureCookie:false,authHmacKey:key,sessionTtlSeconds:3600,rememberSessionTtlSeconds:7200});const api=express.Router();registerBusiness(api,{pool,allowOrigin:'https://51mai.example.test',authHmacKey:key,cookieName:'51mai_test_session',secureCookie:false,sessionTtlSeconds:3600,rememberSessionTtlSeconds:7200});const l=await listen(createApp({apiRouter:api}));server=l.server;base=l.base});
 afterAll(async()=>{if(recharges.length)await pool.query(`DELETE FROM recharge_orders WHERE id IN (${recharges.map(()=>'?').join(',')})`,recharges);if(txs.length)await pool.query(`DELETE FROM account_transactions WHERE id IN (${txs.map(()=>'?').join(',')})`,txs);if(users.length)await pool.query(`DELETE FROM users WHERE id IN (${users.map(()=>'?').join(',')})`,users);await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));await pool.end()});
 it('returns only the current user three balances and finance transactions',async()=>{const u=await user();const other=await user();const a=await auth(u);await pool.execute('INSERT INTO account_balances (user_id,available_balance_cents,commission_balance_cents,frozen_balance_cents) VALUES (?,?,?,?)',[u.id,12345,6789,500]);const t1=randomUUID(),t2=randomUUID();txs.push(t1,t2);await pool.execute("INSERT INTO account_transactions (id,user_id,reference_no,transaction_type,direction,amount_cents,balance_before_cents,balance_after_cents,note) VALUES (?,?,?,'order_settlement','income',12000,345,12345,'订单结算'),(?,?,?,'recharge','income',99900,0,99900,'他人充值')",[t1,u.id,'REF-U',t2,other.id,'REF-O']);const s=await req('/api/finance/summary',a);expect(s.status).toBe(200);expect((await s.json() as any).data).toMatchObject({availableBalanceCents:12345,commissionBalanceCents:6789,frozenBalanceCents:500});const list=await req('/api/finance/transactions',a);const body=await list.json() as any;expect(body.data.transactions.map((x:any)=>x.id)).toContain(t1);expect(body.data.transactions.map((x:any)=>x.id)).not.toContain(t2)});
 it('creates a pending recharge order without crediting balance or faking payment',async()=>{const u=await user();const a=await auth(u);const before=await req('/api/finance/summary',a);expect((await before.json() as any).data.availableBalanceCents).toBe(0);const created=await req('/api/recharges',a,{method:'POST',body:JSON.stringify({amountCents:50000,channel:'alipay'})});expect(created.status).toBe(201);const row=(await created.json() as any).data;recharges.push(row.id);expect(row).toMatchObject({amountCents:50000,channel:'alipay',status:'pending_payment',paymentAvailable:false});const after=await req('/api/finance/summary',a);expect((await after.json() as any).data.availableBalanceCents).toBe(0);const list=await req('/api/recharges',a);expect((await list.json() as any).data.recharges.some((x:any)=>x.id===row.id)).toBe(true)});
 it('rejects recharge creation without valid CSRF',async()=>{const u=await user();const a=await auth(u);const res=await fetch(`${base}/api/recharges`,{method:'POST',headers:{Cookie:a.cookie,Origin:'https://51mai.example.test','Content-Type':'application/json'},body:JSON.stringify({amountCents:50000,channel:'alipay'})});expect(res.status).toBe(403)});
});
