import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { evaluatePaymentReadiness } from './payments/readiness.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const complete = {
  NODE_ENV: 'production',
  ALLOWED_ORIGIN: 'https://51mai.example.test',
  FULFILLMENT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
  WECHAT_PAY_MERCHANT_ID: '1900000001',
  WECHAT_PAY_API_V3_KEY: '12345678901234567890123456789012',
  WECHAT_PAY_PLATFORM_PUBLIC_KEY_PEM: publicPem,
  WECHAT_PAY_APP_ID: 'wx123',
  WECHAT_PAY_MERCHANT_SERIAL_NO: 'SERIAL123',
  WECHAT_PAY_MERCHANT_PRIVATE_KEY_PEM: privatePem,
  WECHAT_PAY_NOTIFY_URL: 'https://51mai.example.test/api/payments/callback/wechat',
  ALIPAY_APP_ID: '2026000000000000',
  ALIPAY_PUBLIC_KEY_PEM: publicPem,
  ALIPAY_MERCHANT_PRIVATE_KEY_PEM: privatePem,
  ALIPAY_NOTIFY_URL: 'https://51mai.example.test/api/payments/callback/alipay',
};

describe('payment production readiness', () => {
  it('reports missing production prerequisites without exposing values', () => {
    const result = evaluatePaymentReadiness({ NODE_ENV: 'production', ALLOWED_ORIGIN: 'http://127.0.0.1:5173' });
    expect(result.ready).toBe(false);
    expect(result.wechat.ready).toBe(false);
    expect(result.alipay.ready).toBe(false);
    expect(result.issues).toContain('ALLOWED_ORIGIN must use public HTTPS for production payment validation');
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
  });

  it('accepts complete production-safe configuration', () => {
    const result = evaluatePaymentReadiness(complete);
    expect(result.ready).toBe(true);
    expect(result.wechat.ready).toBe(true);
    expect(result.alipay.ready).toBe(true);
    expect(result.fulfillmentReady).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('rejects localhost callbacks and malformed cryptographic material', () => {
    const result = evaluatePaymentReadiness({
      ...complete,
      WECHAT_PAY_API_V3_KEY: 'short',
      WECHAT_PAY_MERCHANT_PRIVATE_KEY_PEM: 'bad-key',
      WECHAT_PAY_NOTIFY_URL: 'https://127.0.0.1/callback',
      ALIPAY_NOTIFY_URL: 'http://example.test/callback',
      FULFILLMENT_ENCRYPTION_KEY: 'invalid',
    });
    expect(result.ready).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      'WECHAT_PAY_API_V3_KEY must be exactly 32 bytes',
      'WECHAT_PAY_MERCHANT_PRIVATE_KEY_PEM is not a valid private key',
      'WECHAT_PAY_NOTIFY_URL must be a public HTTPS URL',
      'ALIPAY_NOTIFY_URL must be a public HTTPS URL',
      'FULFILLMENT_ENCRYPTION_KEY must decode to exactly 32 bytes',
    ]));
  });
});
