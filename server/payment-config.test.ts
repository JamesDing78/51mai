// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
const base={NODE_ENV:'test',DB_USER:'u',DB_NAME:'d',ALLOWED_ORIGIN:'https://51mai.example.test',AUTH_HMAC_KEY:Buffer.alloc(32,1).toString('base64url')};
describe('payment runtime configuration',()=>{
 it('loads complete WeChat and Alipay verification config without exposing merchant private keys',()=>{const c=loadConfig({...base,WECHAT_PAY_MERCHANT_ID:'m1',WECHAT_PAY_API_V3_KEY:'12345678901234567890123456789012',WECHAT_PAY_PLATFORM_PUBLIC_KEY_PEM:'-----BEGIN PUBLIC KEY-----\\nabc\\n-----END PUBLIC KEY-----',ALIPAY_APP_ID:'a1',ALIPAY_PUBLIC_KEY_PEM:'-----BEGIN PUBLIC KEY-----\\ndef\\n-----END PUBLIC KEY-----'});expect(c.paymentRuntime?.wechat?.merchantId).toBe('m1');expect(c.paymentRuntime?.wechat?.apiV3Key).toHaveLength(32);expect(c.paymentRuntime?.alipay?.appId).toBe('a1');expect(c.paymentRuntime?.wechat?.platformPublicKeyPem).toContain('\nabc\n')});
 it('rejects partially configured providers',()=>{expect(()=>loadConfig({...base,WECHAT_PAY_MERCHANT_ID:'m1'})).toThrow(/WECHAT_PAY/);expect(()=>loadConfig({...base,ALIPAY_APP_ID:'a1'})).toThrow(/ALIPAY/)});
});
