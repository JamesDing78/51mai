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

describe.skipIf(!enabled)('Phase 5 user content persistence',()=>{
  let pool:Pool,server:Server,base='',sessions:SessionManager;const users:string[]=[];const orders:string[]=[];const key=Buffer.alloc(32,0x56);
  async function user(){const id=randomUUID(),username=`p5_${id.slice(0,8)}`;await pool.execute("INSERT INTO users (id,username_normalized,password_hash,account_status,role) VALUES (?,?,NULL,'active','customer')",[id,username]);users.push(id);return {id,username,role:'customer'} as AuthUser}
  async function auth(u:AuthUser){const x=await sessions.issueSession(u);return {cookie:cookiePair(x.cookieHeader),csrf:x.csrfToken}}
  async function order(userId:string,name:string){const id=randomUUID();orders.push(id);await pool.execute("INSERT INTO orders (id,order_number,user_id,status,payment_status,delivery_status,total_amount_cents) VALUES (?,?,?,'completed','paid','delivered',8800)",[id,`P5-${id.slice(0,8)}`,userId]);await pool.execute("INSERT INTO order_items (id,order_id,product_id,product_name,spec_name,unit_price_cents,quantity,line_total_cents) VALUES (?,?,?,?,'默认规格',8800,1,8800)",[randomUUID(),id,'p-005',name]);return id}
  async function get(path:string,a:{cookie:string}){return fetch(`${base}${path}`,{headers:{Cookie:a.cookie}})}
  beforeAll(async()=>{if(!db)throw new Error('missing db');pool=createPool({...loadDatabaseConfig(),database:db});await migrate(pool);sessions=new SessionManager({pool,cookieName:'51mai_test_session',secureCookie:false,authHmacKey:key,sessionTtlSeconds:3600,rememberSessionTtlSeconds:7200});const api=express.Router();registerBusiness(api,{pool,allowOrigin:'https://51mai.example.test',authHmacKey:key,cookieName:'51mai_test_session',secureCookie:false,sessionTtlSeconds:3600,rememberSessionTtlSeconds:7200});const l=await listen(createApp({apiRouter:api}));server=l.server;base=l.base});
  afterAll(async()=>{if(users.length){await pool.query(`DELETE FROM after_sales_requests WHERE user_id IN (${users.map(()=>'?').join(',')})`,users).catch(()=>{});await pool.query(`DELETE FROM user_favorites WHERE user_id IN (${users.map(()=>'?').join(',')})`,users).catch(()=>{});await pool.query(`DELETE FROM user_messages WHERE user_id IN (${users.map(()=>'?').join(',')})`,users).catch(()=>{});await pool.query(`DELETE FROM order_delivery_items WHERE user_id IN (${users.map(()=>'?').join(',')})`,users).catch(()=>{});}if(orders.length)await pool.query(`DELETE FROM orders WHERE id IN (${orders.map(()=>'?').join(',')})`,orders);if(users.length)await pool.query(`DELETE FROM users WHERE id IN (${users.map(()=>'?').join(',')})`,users);await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));await pool.end()});

  it('returns only the current user after-sales, favorites and messages with filters',async()=>{const u=await user(),other=await user(),a=await auth(u);const ownOrder=await order(u.id,'真实售后商品');const otherOrder=await order(other.id,'他人商品');await pool.execute("INSERT INTO after_sales_requests (id,user_id,order_id,order_number_snapshot,product_name_snapshot,reason,status) VALUES (?,?,?,?,?,?,'processing'),(?,?,?,?,?,?,'completed')",[randomUUID(),u.id,ownOrder,'P5-OWN','真实售后商品','使用咨询',randomUUID(),other.id,otherOrder,'P5-OTHER','他人商品','不应显示']);await pool.execute("INSERT INTO user_favorites (user_id,product_id,product_name,product_image_path,price_cents) VALUES (?,?,?,?,?),(?,?,?,?,?)",[u.id,'p-005','真实收藏商品','/products/p-005.png',9900,other.id,'p-006','他人收藏','/products/p-006.png',8800]);await pool.execute("INSERT INTO user_messages (id,user_id,category,title,content,read_at) VALUES (?,?, 'order', ?, ?, NULL),(?,?, 'general', ?, ?, UTC_TIMESTAMP(6)),(?,?, 'general', ?, ?, NULL)",[randomUUID(),u.id,'真实订单消息','订单已交付',randomUUID(),u.id,'真实已读消息','欢迎使用',randomUUID(),other.id,'他人消息','不应显示']);
    const after=await get('/api/after-sales?status=processing&q=真实售后',a);expect(after.status).toBe(200);const ab=(await after.json() as any).data.afterSales;expect(ab).toHaveLength(1);expect(ab[0]).toMatchObject({productName:'真实售后商品',reason:'使用咨询',status:'processing'});
    const fav=await get('/api/favorites?q=真实收藏',a);const fb=(await fav.json() as any).data.favorites;expect(fb).toHaveLength(1);expect(fb[0]).toMatchObject({productId:'p-005',productName:'真实收藏商品',priceCents:9900});
    const unread=await get('/api/messages?status=unread',a);const mb=(await unread.json() as any).data.messages;expect(mb).toHaveLength(1);expect(mb[0]).toMatchObject({title:'真实订单消息',category:'order',read:false});
  });

  it('lists card delivery metadata for the current user without exposing or inventing credential contents',async()=>{const u=await user(),other=await user(),a=await auth(u);const ownOrder=await order(u.id,'真实卡密商品');const otherOrder=await order(other.id,'他人卡密商品');const ownId=randomUUID();await pool.execute("INSERT INTO order_delivery_items (id,user_id,order_id,product_id,product_name,delivery_kind,credential_state) VALUES (?,?,?,?,?,'card','pending'),(?,?,?,?,?,'card','available')",[ownId,u.id,ownOrder,'p-005','真实卡密商品',randomUUID(),other.id,otherOrder,'p-006','他人卡密商品']);const res=await get('/api/cards?q=真实卡密',a);expect(res.status).toBe(200);const cards=(await res.json() as any).data.cards;expect(cards).toHaveLength(1);expect(cards[0]).toMatchObject({id:ownId,productName:'真实卡密商品',credentialState:'pending',credentialAvailable:false});expect(cards[0]).not.toHaveProperty('credential');expect(JSON.stringify(cards)).not.toContain('51MAI-');});
});
