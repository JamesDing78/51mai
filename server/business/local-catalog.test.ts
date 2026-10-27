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

const database=(process.env.TEST_DATABASE_NAME??process.env.TEST_DB_NAME)?.trim();
const allowlist=new Set((process.env.TEST_DATABASE_ALLOWLIST??'').split(',').map(v=>v.trim()).filter(Boolean));
const enabled=Boolean(database)&&allowlist.has(database as string)&&process.env.DB_NAME===database;
async function listen(app:Express){const server=createServer(app);await new Promise<void>((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r)});const a=server.address();if(!a||typeof a==='string')throw new Error('no port');return {server,base:`http://127.0.0.1:${a.port}`}}
const cookiePair=(h:string)=>h.split(';',1)[0]??'';

describe.skipIf(!enabled)('local catalog persistence',()=>{
  let pool:Pool,server:Server,base='';let sessions:SessionManager;const users:string[]=[];const productCleanup:string[]=[];const key=Buffer.alloc(32,0x72);
  async function user(role:'customer'|'admin'){const id=randomUUID(),username=`catalog_${role}_${id.slice(0,8)}`;await pool.execute("INSERT INTO users (id,username_normalized,password_hash,account_status,role) VALUES (?,?,NULL,'active',?)",[id,username,role]);users.push(id);return {id,username,role} as AuthUser}
  async function auth(u:AuthUser){const x=await sessions.issueSession(u);return {cookie:cookiePair(x.cookieHeader),csrf:x.csrfToken}}
  async function createFixture(a:{cookie:string;csrf:string},name:string){const res=await fetch(`${base}/api/admin/products`,{method:'POST',headers:{Cookie:a.cookie,Origin:'https://51mai.example.test','X-CSRF-Token':a.csrf,'Content-Type':'application/json'},body:JSON.stringify({name,description:'本地商品说明',marketPriceCents:19900,deliveryType:'content',categoryIds:['local-cat-17'],spec:{name:'默认规格',partnerCostCents:9900,priceCents:12375,stock:100}})});expect(res.status).toBe(201);const data=(await res.json() as any).data;productCleanup.push(data.id);return data}
  beforeAll(async()=>{if(!database)throw new Error('missing db');pool=createPool({...loadDatabaseConfig(),database});await migrate(pool);sessions=new SessionManager({pool,cookieName:'51mai_test_session',secureCookie:false,authHmacKey:key,sessionTtlSeconds:3600,rememberSessionTtlSeconds:7200});const api=express.Router();registerBusiness(api,{pool,allowOrigin:'https://51mai.example.test',authHmacKey:key,cookieName:'51mai_test_session',secureCookie:false,sessionTtlSeconds:3600,rememberSessionTtlSeconds:7200});const l=await listen(createApp({apiRouter:api}));server=l.server;base=l.base});
  afterAll(async()=>{for(const id of productCleanup){await pool.execute('DELETE FROM local_product_inventory WHERE product_id=?',[id]).catch(()=>{});await pool.execute('DELETE FROM local_product_specs WHERE product_id=?',[id]).catch(()=>{});await pool.execute('DELETE FROM local_products WHERE id=?',[id]).catch(()=>{})}if(users.length)await pool.query(`DELETE FROM users WHERE id IN (${users.map(()=>'?').join(',')})`,users);await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));await pool.end()});

  it('serves the seeded local catalog and keeps supplier cost private from public responses',async()=>{
    const res=await fetch(`${base}/api/catalog`);expect(res.status).toBe(200);const body=(await res.json() as any).data;
    expect(body.products.length).toBeGreaterThanOrEqual(41);const product=body.products.find((x:any)=>x.id==='p-002');expect(product).toBeTruthy();expect(product.deliveryType).toBe('content');expect(product.partnerCostCents).toBeUndefined();expect(product.specs.length).toBeGreaterThan(0);expect(product.specs[0].partnerCostCents).toBeUndefined();
    const unsafeImages=new Set(['/products/source-001.png','/products/source-002.png','/products/source-003.png','/products/source-004.png','/products/source-013.png','/products/source-036.png']);
    expect(body.products.some((x:any)=>unsafeImages.has(x.image))).toBe(false);
    expect(body.products.find((x:any)=>x.id==='p-001')?.image).toBe('/products/51mai-placeholder.svg');
  });

  it('keeps all 93 observed product names in the admin catalog while incomplete products remain hidden',async()=>{
    const adminUser=await user('admin'),a=await auth(adminUser);
    const adminRes=await fetch(`${base}/api/admin/products`,{headers:{Cookie:a.cookie}});expect(adminRes.status).toBe(200);
    const adminProducts=(await adminRes.json() as any).data.products;
    expect(adminProducts.length).toBeGreaterThanOrEqual(93);
    expect(adminProducts.find((x:any)=>x.id==='reference-122')).toMatchObject({name:'无限注册渠道',status:'inactive',partnerCostCents:0,priceCents:0,stock:0});
    const publicRes=await fetch(`${base}/api/catalog`);const publicProducts=(await publicRes.json() as any).data.products;
    expect(publicProducts.some((x:any)=>x.id==='reference-122')).toBe(false);
  });

  it('admin edits product, spec price and inventory and the public catalog sees the same values',async()=>{
    const adminUser=await user('admin'),a=await auth(adminUser),created=await createFixture(a,`编辑测试-${randomUUID().slice(0,8)}`);const specId=created.specs[0].id;
    const update=await fetch(`${base}/api/admin/products/${created.id}`,{method:'PATCH',headers:{Cookie:a.cookie,Origin:'https://51mai.example.test','X-CSRF-Token':a.csrf,'Content-Type':'application/json'},body:JSON.stringify({name:'本地商品测试标题',description:created.description,marketPriceCents:created.marketPriceCents,status:'active',deliveryType:'content',categoryIds:created.categoryIds})});expect(update.status).toBe(200);
    const spec=await fetch(`${base}/api/admin/products/${created.id}/specs/${specId}`,{method:'PATCH',headers:{Cookie:a.cookie,Origin:'https://51mai.example.test','X-CSRF-Token':a.csrf,'Content-Type':'application/json'},body:JSON.stringify({name:'默认规格',partnerCostCents:8800,priceCents:13500,stock:37,status:'active'})});expect(spec.status).toBe(200);
    const publicProduct=await fetch(`${base}/api/catalog/products/${created.id}`);expect(publicProduct.status).toBe(200);const p=(await publicProduct.json() as any).data;expect(p).toMatchObject({name:'本地商品测试标题',priceCents:13500,stock:37});expect(p.specs[0]).toMatchObject({priceCents:13500,stock:37});expect(p.partnerCostCents).toBeUndefined();
  });

  it('admin can list categories and deactivate a product without deleting it',async()=>{
    const adminUser=await user('admin'),a=await auth(adminUser),created=await createFixture(a,`下架测试-${randomUUID().slice(0,8)}`);
    const cats=await fetch(`${base}/api/admin/categories`,{headers:{Cookie:a.cookie}});expect(cats.status).toBe(200);expect(((await cats.json() as any).data.categories).length).toBeGreaterThanOrEqual(17);
    const off=await fetch(`${base}/api/admin/products/${created.id}`,{method:'PATCH',headers:{Cookie:a.cookie,Origin:'https://51mai.example.test','X-CSRF-Token':a.csrf,'Content-Type':'application/json'},body:JSON.stringify({name:created.name,description:created.description,marketPriceCents:created.marketPriceCents,status:'inactive',deliveryType:created.deliveryType,categoryIds:created.categoryIds})});expect(off.status).toBe(200);const hidden=await fetch(`${base}/api/catalog/products/${created.id}`);expect(hidden.status).toBe(404);const adminRead=await fetch(`${base}/api/admin/products/${created.id}`,{headers:{Cookie:a.cookie}});expect(adminRead.status).toBe(200);expect((await adminRead.json() as any).data.status).toBe('inactive');
  });

  it('admin can create a local product, add/remove a SKU and archive it without exposing it publicly',async()=>{
    const adminUser=await user('admin'),a=await auth(adminUser),created=await createFixture(a,`新本地商品-${randomUUID().slice(0,8)}`);expect(created.id).toMatch(/^local-/);expect(created.specs).toHaveLength(1);
    const extraRes=await fetch(`${base}/api/admin/products/${created.id}/specs`,{method:'POST',headers:{Cookie:a.cookie,Origin:'https://51mai.example.test','X-CSRF-Token':a.csrf,'Content-Type':'application/json'},body:JSON.stringify({name:'高级规格',partnerCostCents:18000,priceCents:25000,stock:3})});expect(extraRes.status).toBe(201);const withExtra=(await extraRes.json() as any).data;expect(withExtra.specs).toHaveLength(2);const extra=withExtra.specs.find((x:any)=>x.name==='高级规格');
    const deleteSpec=await fetch(`${base}/api/admin/products/${created.id}/specs/${extra.id}`,{method:'DELETE',headers:{Cookie:a.cookie,Origin:'https://51mai.example.test','X-CSRF-Token':a.csrf}});expect(deleteSpec.status).toBe(200);expect(((await deleteSpec.json() as any).data.specs)).toHaveLength(1);
    const archive=await fetch(`${base}/api/admin/products/${created.id}`,{method:'DELETE',headers:{Cookie:a.cookie,Origin:'https://51mai.example.test','X-CSRF-Token':a.csrf}});expect(archive.status).toBe(200);expect((await archive.json() as any).data.status).toBe('inactive');const publicRes=await fetch(`${base}/api/catalog/products/${created.id}`);expect(publicRes.status).toBe(404);
  });
});
