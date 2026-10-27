import path from 'node:path';
import type { PaymentRuntimeConfig } from './payments/service.js';

export type TrustProxy = boolean | number | string;

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit: number;
  connectTimeout: number;
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  host: string;
  staticDir: string;
  indexFile: string;
  trustProxy: TrustProxy;
  allowOrigin: string;
  authHmacKey?: Buffer;
  cookieName: string;
  sessionTtlSeconds: number;
  rememberSessionTtlSeconds: number;
  paymentRuntime?: PaymentRuntimeConfig;
  fulfillmentEncryptionKey?: Buffer;
  orderExpirySweepSeconds:number;
  database: DatabaseConfig;
}

type Environment = Record<string, string | undefined>;

function parseInteger(name: string, value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function required(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function parseNodeEnv(value: string | undefined): AppConfig['nodeEnv'] {
  if (value === 'production' || value === 'test' || value === 'development') return value;
  if (value === undefined || value.trim() === '') return 'development';
  throw new Error('NODE_ENV must be development, test, or production');
}

function parseTrustProxy(value: string | undefined): TrustProxy {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === 'false' || trimmed === '0') return false;
  if (trimmed === 'true' || trimmed === '*') {
    throw new Error('TRUST_PROXY must be an explicit hop count or proxy address, not true or *');
  }
  if (/^\d+$/.test(trimmed)) return parseInteger('TRUST_PROXY', trimmed, 0, 1, 10);
  return trimmed;
}

function parseOrigin(value: string | undefined, nodeEnv: AppConfig['nodeEnv']): string {
  const origin = value?.trim() || (nodeEnv === 'production' ? '' : 'http://127.0.0.1:3000');
  if (!origin) throw new Error('ALLOWED_ORIGIN is required in production');
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('ALLOWED_ORIGIN must be an absolute http(s) origin');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('ALLOWED_ORIGIN must contain only an http(s) origin');
  }
  if (nodeEnv === 'production' && parsed.protocol !== 'https:') {
    throw new Error('ALLOWED_ORIGIN must use https in production');
  }
  return parsed.origin;
}

function parseAuthHmacKey(value: string | undefined, nodeEnv: AppConfig['nodeEnv']): Buffer | undefined {
  const encoded = value?.trim();
  if (!encoded) {
    if (nodeEnv === 'production') throw new Error('AUTH_HMAC_KEY is required in production');
    return undefined;
  }
  const key = Buffer.from(encoded, 'base64url');
  if (key.length < 32) throw new Error('AUTH_HMAC_KEY must decode to at least 32 bytes');
  return key;
}

function parseCookieName(value: string | undefined, nodeEnv: AppConfig['nodeEnv']): string {
  const cookieName = value?.trim() || (nodeEnv === 'production' ? '__Host-51mai_session' : '51mai_session');
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(cookieName)) {
    throw new Error('SESSION_COOKIE_NAME must be a valid cookie token');
  }
  if (nodeEnv === 'production' && (!cookieName.startsWith('__Host-') || cookieName.length <= '__Host-'.length)) {
    throw new Error('SESSION_COOKIE_NAME must use a non-empty __Host- prefix in production');
  }
  return cookieName;
}


function parsePem(value:string|undefined):string|undefined { const v=value?.trim(); return v?v.replaceAll('\\n','\n'):undefined; }

function parseFulfillmentKey(value:string|undefined):Buffer|undefined { const encoded=value?.trim(); if(!encoded)return undefined; const key=Buffer.from(encoded,'base64url'); if(key.length!==32)throw new Error('FULFILLMENT_ENCRYPTION_KEY must decode to exactly 32 bytes'); return key; }

function parsePaymentRuntime(environment:Environment):PaymentRuntimeConfig|undefined {
  const wm=environment.WECHAT_PAY_MERCHANT_ID?.trim(), wk=environment.WECHAT_PAY_API_V3_KEY?.trim(), wp=parsePem(environment.WECHAT_PAY_PLATFORM_PUBLIC_KEY_PEM);
  const wa=environment.WECHAT_PAY_APP_ID?.trim(), ws=environment.WECHAT_PAY_MERCHANT_SERIAL_NO?.trim(), wpriv=parsePem(environment.WECHAT_PAY_MERCHANT_PRIVATE_KEY_PEM), wn=environment.WECHAT_PAY_NOTIFY_URL?.trim();
  const aa=environment.ALIPAY_APP_ID?.trim(), ap=parsePem(environment.ALIPAY_PUBLIC_KEY_PEM), apriv=parsePem(environment.ALIPAY_MERCHANT_PRIVATE_KEY_PEM), an=environment.ALIPAY_NOTIFY_URL?.trim();
  const anyWx=Boolean(wm||wk||wp), anyWxCreate=Boolean(wa||ws||wpriv||wn); const anyAli=Boolean(aa||ap), anyAliCreate=Boolean(apriv||an);
  if(anyWx&&(!wm||!wk||!wp)) throw new Error('WECHAT_PAY configuration must include merchant id, API v3 key and platform public key');
  if(anyWxCreate&&(!anyWx||!wa||!ws||!wpriv||!wn)) throw new Error('WECHAT_PAY payment creation requires app id, merchant serial, merchant private key and notify URL');
  if(wk&&Buffer.byteLength(wk)!==32) throw new Error('WECHAT_PAY_API_V3_KEY must be exactly 32 bytes');
  if(anyAli&&(!aa||!ap)) throw new Error('ALIPAY configuration must include app id and public key');
  if(anyAliCreate&&(!anyAli||!apriv||!an)) throw new Error('ALIPAY payment creation requires merchant private key and notify URL');
  if(!anyWx&&!anyAli) return undefined;
  return {wechat:anyWx?{merchantId:wm!,apiV3Key:wk!,platformPublicKeyPem:wp!,appId:wa,merchantSerialNo:ws,merchantPrivateKeyPem:wpriv,notifyUrl:wn}:undefined,alipay:anyAli?{appId:aa!,alipayPublicKeyPem:ap!,merchantPrivateKeyPem:apriv,notifyUrl:an}:undefined};
}

export function loadDatabaseConfig(
  environment: Environment = process.env,
  nodeEnv: AppConfig['nodeEnv'] = parseNodeEnv(environment.NODE_ENV),
): DatabaseConfig {
  const password = environment.DB_PASSWORD ?? '';
  if (nodeEnv === 'production' && password.trim() === '') {
    throw new Error('DB_PASSWORD is required in production');
  }
  return {
    host: environment.DB_HOST?.trim() || '127.0.0.1',
    port: parseInteger('DB_PORT', environment.DB_PORT, 3306, 1, 65_535),
    user: required('DB_USER', environment.DB_USER),
    password,
    database: required('DB_NAME', environment.DB_NAME),
    connectionLimit: parseInteger('DB_CONNECTION_LIMIT', environment.DB_CONNECTION_LIMIT, 10, 1, 50),
    connectTimeout: parseInteger('DB_CONNECT_TIMEOUT_MS', environment.DB_CONNECT_TIMEOUT_MS, 5_000, 250, 120_000),
  };
}

export function loadConfig(environment: Environment = process.env): AppConfig {
  const nodeEnv = parseNodeEnv(environment.NODE_ENV);
  const staticDir = path.resolve(environment.STATIC_DIR?.trim() || 'dist');
  const indexFile = path.resolve(environment.INDEX_FILE?.trim() || path.join(staticDir, 'index.html'));

  return {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    port: parseInteger('PORT', environment.PORT, nodeEnv === 'development' ? 3001 : 3000, 1, 65_535),
    host: nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1',
    staticDir,
    indexFile,
    trustProxy: parseTrustProxy(environment.TRUST_PROXY),
    allowOrigin: parseOrigin(environment.ALLOWED_ORIGIN, nodeEnv),
    authHmacKey: parseAuthHmacKey(environment.AUTH_HMAC_KEY, nodeEnv),
    cookieName: parseCookieName(environment.SESSION_COOKIE_NAME, nodeEnv),
    sessionTtlSeconds: parseInteger('SESSION_TTL_SECONDS', environment.SESSION_TTL_SECONDS, 86_400, 300, 604_800),
    rememberSessionTtlSeconds: parseInteger(
      'REMEMBER_SESSION_TTL_SECONDS',
      environment.REMEMBER_SESSION_TTL_SECONDS,
      604_800,
      300,
      2_592_000,
    ),
    paymentRuntime: parsePaymentRuntime(environment),
    fulfillmentEncryptionKey: parseFulfillmentKey(environment.FULFILLMENT_ENCRYPTION_KEY),
    orderExpirySweepSeconds: parseInteger('ORDER_EXPIRY_SWEEP_SECONDS',environment.ORDER_EXPIRY_SWEEP_SECONDS,60,10,3600),
    database: loadDatabaseConfig(environment, nodeEnv),
  };
}
