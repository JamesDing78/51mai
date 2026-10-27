import { createPrivateKey, createPublicKey } from 'node:crypto';

type Environment = Record<string, string | undefined>;

export interface ProviderReadiness {
  configured: boolean;
  ready: boolean;
  missing: string[];
  invalid: string[];
}

export interface PaymentReadinessResult {
  ready: boolean;
  wechat: ProviderReadiness;
  alipay: ProviderReadiness;
  fulfillmentReady: boolean;
  issues: string[];
}

function present(env: Environment, key: string): boolean {
  return Boolean(env[key]?.trim());
}

function isPublicHttps(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && !host.endsWith('.local');
  } catch {
    return false;
  }
}

function validPrivateKey(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  try { createPrivateKey(value.replaceAll('\\n', '\n')); return true; } catch { return false; }
}

function validPublicKey(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  try { createPublicKey(value.replaceAll('\\n', '\n')); return true; } catch { return false; }
}

function provider(configuredKeys: string[], readyKeys: string[], env: Environment, invalid: string[]): ProviderReadiness {
  const configured = configuredKeys.some((key) => present(env, key));
  const missing = readyKeys.filter((key) => !present(env, key));
  return { configured, ready: missing.length === 0 && invalid.length === 0, missing, invalid };
}

export function evaluatePaymentReadiness(env: Environment = process.env): PaymentReadinessResult {
  const issues: string[] = [];
  const wechatInvalid: string[] = [];
  const alipayInvalid: string[] = [];

  if (!isPublicHttps(env.ALLOWED_ORIGIN)) issues.push('ALLOWED_ORIGIN must use public HTTPS for production payment validation');

  if (present(env, 'WECHAT_PAY_API_V3_KEY') && Buffer.byteLength(env.WECHAT_PAY_API_V3_KEY!.trim()) !== 32) {
    wechatInvalid.push('WECHAT_PAY_API_V3_KEY must be exactly 32 bytes');
  }
  if (present(env, 'WECHAT_PAY_PLATFORM_PUBLIC_KEY_PEM') && !validPublicKey(env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_PEM)) {
    wechatInvalid.push('WECHAT_PAY_PLATFORM_PUBLIC_KEY_PEM is not a valid public key');
  }
  if (present(env, 'WECHAT_PAY_MERCHANT_PRIVATE_KEY_PEM') && !validPrivateKey(env.WECHAT_PAY_MERCHANT_PRIVATE_KEY_PEM)) {
    wechatInvalid.push('WECHAT_PAY_MERCHANT_PRIVATE_KEY_PEM is not a valid private key');
  }
  if (present(env, 'WECHAT_PAY_NOTIFY_URL') && !isPublicHttps(env.WECHAT_PAY_NOTIFY_URL)) {
    wechatInvalid.push('WECHAT_PAY_NOTIFY_URL must be a public HTTPS URL');
  }

  if (present(env, 'ALIPAY_PUBLIC_KEY_PEM') && !validPublicKey(env.ALIPAY_PUBLIC_KEY_PEM)) {
    alipayInvalid.push('ALIPAY_PUBLIC_KEY_PEM is not a valid public key');
  }
  if (present(env, 'ALIPAY_MERCHANT_PRIVATE_KEY_PEM') && !validPrivateKey(env.ALIPAY_MERCHANT_PRIVATE_KEY_PEM)) {
    alipayInvalid.push('ALIPAY_MERCHANT_PRIVATE_KEY_PEM is not a valid private key');
  }
  if (present(env, 'ALIPAY_NOTIFY_URL') && !isPublicHttps(env.ALIPAY_NOTIFY_URL)) {
    alipayInvalid.push('ALIPAY_NOTIFY_URL must be a public HTTPS URL');
  }

  let fulfillmentReady = false;
  if (present(env, 'FULFILLMENT_ENCRYPTION_KEY')) {
    try {
      const key = Buffer.from(env.FULFILLMENT_ENCRYPTION_KEY!.trim(), 'base64url');
      fulfillmentReady = key.length === 32;
      if (!fulfillmentReady) issues.push('FULFILLMENT_ENCRYPTION_KEY must decode to exactly 32 bytes');
    } catch {
      issues.push('FULFILLMENT_ENCRYPTION_KEY must decode to exactly 32 bytes');
    }
  } else {
    issues.push('FULFILLMENT_ENCRYPTION_KEY is missing');
  }

  const wechat = provider(
    ['WECHAT_PAY_MERCHANT_ID','WECHAT_PAY_API_V3_KEY','WECHAT_PAY_PLATFORM_PUBLIC_KEY_PEM','WECHAT_PAY_APP_ID','WECHAT_PAY_MERCHANT_SERIAL_NO','WECHAT_PAY_MERCHANT_PRIVATE_KEY_PEM','WECHAT_PAY_NOTIFY_URL'],
    ['WECHAT_PAY_MERCHANT_ID','WECHAT_PAY_API_V3_KEY','WECHAT_PAY_PLATFORM_PUBLIC_KEY_PEM','WECHAT_PAY_APP_ID','WECHAT_PAY_MERCHANT_SERIAL_NO','WECHAT_PAY_MERCHANT_PRIVATE_KEY_PEM','WECHAT_PAY_NOTIFY_URL'],
    env,
    wechatInvalid,
  );
  const alipay = provider(
    ['ALIPAY_APP_ID','ALIPAY_PUBLIC_KEY_PEM','ALIPAY_MERCHANT_PRIVATE_KEY_PEM','ALIPAY_NOTIFY_URL'],
    ['ALIPAY_APP_ID','ALIPAY_PUBLIC_KEY_PEM','ALIPAY_MERCHANT_PRIVATE_KEY_PEM','ALIPAY_NOTIFY_URL'],
    env,
    alipayInvalid,
  );

  issues.push(...wechat.invalid, ...alipay.invalid);
  if (wechat.missing.length) issues.push(`WeChat payment missing: ${wechat.missing.join(', ')}`);
  if (alipay.missing.length) issues.push(`Alipay payment missing: ${alipay.missing.join(', ')}`);

  return {
    ready: isPublicHttps(env.ALLOWED_ORIGIN) && fulfillmentReady && wechat.ready && alipay.ready,
    wechat,
    alipay,
    fulfillmentReady,
    issues,
  };
}
