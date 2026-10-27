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
describe.skipIf(!enabled)('Phase 8 footmark persistence',()=>{
 let pool:Pool,server:Server,base='',sessions:SessionManager;const users:string[]=[];const key=Buffer.alloc(32,0x58);
 async function user(){const id=randomUUID(),username=`p8_${id.slice(0,8)}`;await pool.execute("INSERT INTO users (id,username_normalized,password_hash,account_status,role) VALUES (?,?,NULL,'active','customer')",[id,username]);users.push(id);return {id,username,role:'customer'} as AuthUser}
 async function auth(u:AuthUser){const x=await sessions.issueSession(u);return {cookie:cookiePair(x.cookieHeader),csrf:x.csrfToken}}
 beforeAll(async()=>{if(!db)throw new Error('missing db');pool=createPool({...loadDatabaseConfig(),database:db});await migrate(pool);sessions=new SessionManager({pool,cookieName:'51mai_test_session',secureCookie:false,authHmacKey:key,sessionTtlSeconds:3600,rememberSessionTtlSeconds:7200});const api=express.Router();registerBusiness(api,{pool,allowOrigin:'https://51mai.example.test',authHmacKey:key,cookieName:'51mai_test_session',secureCookie:false,sessionTtlSeconds:3600,rememberSessionTtlSeconds:7200});const l=await listen(createApp({apiRouter:api}));server=l.server;base=l.base});
 afterAll(async()=>{if(users.length){await pool.query(`DELETE FROM user_footmarks WHERE user_id IN (${users.map(()=>'?').join(',')})`,users).catch(()=>{});await pool.query(`DELETE FROM users WHERE id IN (${users.map(()=>'?').join(',')})`,users)}await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));await pool.end()});
 it('records one latest footmark per product with csrf/origin and isolates users',async()=>{const u=await user(),other=await user(),a=await auth(u),b=await auth(other);const body={productId:'p-005',productName:'真实足迹商品',productImagePath:'/products/p-005.png',priceCents:9900};
   const missing=await fetch(`${base}/api/footmarks`,{method:'POST',headers:{Cookie:a.cookie,Origin:'https://51mai.example.test','Content-Type':'application/json'},body:JSON.stringify(body)});expect(missing.status).toBe(403);
   const first=await fetch(`${base}/api/footmarks`,{method:'POST',headers:{Cookie:a.cookie,Origin:'https://51mai.example.test','X-CSRF-Token':a.csrf,'Content-Type':'application/json'},body:JSON.stringify(body)});expect(first.status).toBe(204);
   await new Promise(r=>setTimeout(r,5));
   const second=await fetch(`${base}/api/footmarks`,{method:'POST',headers:{Cookie:a.cookie,Origin:'https://51mai.example.test','X-CSRF-Token':a.csrf,'Content-Type':'application/json'},body:JSON.stringify({...body,priceCents:8800})});expect(second.status).toBe(204);
   const otherPost=await fetch(`${base}/api/footmarks`,{method:'POST',headers:{Cookie:b.cookie,Origin:'https://51mai.example.test','X-CSRF-Token':b.csrf,'Content-Type':'application/json'},body:JSON.stringify({...body,productId:'p-006',productName:'他人足迹'})});expect(otherPost.status).toBe(204);
   const own=await fetch(`${base}/api/footmarks`,{headers:{Cookie:a.cookie}});expect(own.status).toBe(200);const data=(await own.json() as any).data.footmarks;expect(data).toHaveLength(1);expect(data[0]).toMatchObject({productId:'p-005',productName:'真实足迹商品',priceCents:8800});expect(JSON.stringify(data)).not.toContain('他人足迹');
   const [rows]=await pool.execute<any[]>('SELECT COUNT(*) AS c FROM user_footmarks WHERE user_id=? AND product_id=?',[u.id,'p-005']);expect(Number(rows[0].c)).toBe(1);
 });
});
