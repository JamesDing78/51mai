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

describe.skipIf(!enabled)('Phase 6 account security read model',()=>{
 let pool:Pool,server:Server,base='';let sessions:SessionManager;const users:string[]=[];const logs:string[]=[];const contacts:string[]=[];const key=Buffer.alloc(32,0x61);
 async function user(nickname:string,passwordHash:string|null='hash'){const id=randomUUID(),username=`p6_${id.slice(0,8)}`;await pool.execute("INSERT INTO users (id,username_normalized,password_hash,account_status,role) VALUES (?,?,?,'active','customer')",[id,username,passwordHash]);await pool.execute("INSERT INTO user_profiles (user_id,nickname,account_tier) VALUES (?,?, '普通用户')",[id,nickname]);users.push(id);return {id,username,role:'customer'} as AuthUser}
 async function auth(u:AuthUser){const x=await sessions.issueSession(u);return cookiePair(x.cookieHeader)}
 beforeAll(async()=>{if(!db)throw new Error('missing db');pool=createPool({...loadDatabaseConfig(),database:db});await migrate(pool);sessions=new SessionManager({pool,cookieName:'51mai_test_session',secureCookie:false,authHmacKey:key,sessionTtlSeconds:3600,rememberSessionTtlSeconds:7200});const api=express.Router();registerBusiness(api,{pool,allowOrigin:'https://51mai.example.test',authHmacKey:key,cookieName:'51mai_test_session',secureCookie:false,sessionTtlSeconds:3600,rememberSessionTtlSeconds:7200});const l=await listen(createApp({apiRouter:api}));server=l.server;base=l.base});
 afterAll(async()=>{if(logs.length)await pool.query(`DELETE FROM login_logs WHERE id IN (${logs.map(()=>'?').join(',')})`,logs);if(contacts.length)await pool.query(`DELETE FROM user_contacts WHERE id IN (${contacts.map(()=>'?').join(',')})`,contacts);if(users.length)await pool.query(`DELETE FROM users WHERE id IN (${users.map(()=>'?').join(',')})`,users);await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));await pool.end()});
 it('returns only current user profile, masked verified contacts, password state and login logs',async()=>{const own=await user('真实昵称');const other=await user('别人的昵称',null);const cookie=await auth(own);const ownPhone=randomUUID(),ownEmail=randomUUID(),otherEmail=randomUUID();contacts.push(ownPhone,ownEmail,otherEmail);await pool.execute("INSERT INTO user_contacts (id,user_id,kind,identifier_normalized,verified_at) VALUES (?,?, 'phone','+8613812345678',UTC_TIMESTAMP(6)),(?,?, 'email','owner@example.test',UTC_TIMESTAMP(6)),(?,?, 'email','other@example.test',UTC_TIMESTAMP(6))",[ownPhone,own.id,ownEmail,own.id,otherEmail,other.id]);const ownLog=randomUUID(),otherLog=randomUUID();logs.push(ownLog,otherLog);await pool.execute("INSERT INTO login_logs (id,user_id,succeeded,ip_address,user_agent) VALUES (?,?,1,INET6_ATON('127.0.0.1'),'Mozilla/5.0 Chrome/155 macOS'),(?,?,0,INET6_ATON('203.0.113.9'),'Other Agent')",[ownLog,own.id,otherLog,other.id]);const s=await fetch(`${base}/api/account/security`,{headers:{Cookie:cookie}});expect(s.status).toBe(200);const body=(await s.json() as any).data;expect(body.profile).toMatchObject({nickname:'真实昵称',accountTier:'普通用户',hasPassword:true});expect(body.contacts).toEqual(expect.arrayContaining([expect.objectContaining({kind:'phone',masked:'+86138****5678',verified:true}),expect.objectContaining({kind:'email',masked:'ow***@example.test',verified:true})]));expect(JSON.stringify(body)).not.toContain('other@example.test');const l=await fetch(`${base}/api/account/login-logs`,{headers:{Cookie:cookie}});expect(l.status).toBe(200);const logsBody=(await l.json() as any).data.loginLogs;expect(logsBody).toHaveLength(1);expect(logsBody[0]).toMatchObject({succeeded:true,ipAddress:'127.0.0.*'});expect(logsBody[0].userAgent).toContain('Chrome/155');expect(JSON.stringify(logsBody)).not.toContain('203.0.113.9')});
});
