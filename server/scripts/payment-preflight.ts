import { evaluatePaymentReadiness } from '../payments/readiness.js';

const result = evaluatePaymentReadiness(process.env);
const safe = {
  ready: result.ready,
  wechat: { ready: result.wechat.ready, missing: result.wechat.missing, invalid: result.wechat.invalid },
  alipay: { ready: result.alipay.ready, missing: result.alipay.missing, invalid: result.alipay.invalid },
  fulfillmentReady: result.fulfillmentReady,
  issues: result.issues,
};
console.log(JSON.stringify(safe, null, 2));
if (!result.ready) process.exitCode = 2;
