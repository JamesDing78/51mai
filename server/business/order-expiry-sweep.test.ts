// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startOrderExpirySweep } from './order-expiry-sweep.js';
afterEach(()=>vi.useRealTimers());
describe('order expiry sweep',()=>{it('runs periodically and can be stopped',async()=>{vi.useFakeTimers();const close=vi.fn(async()=>({closed:1}));const stop=startOrderExpirySweep(close,1000);await vi.advanceTimersByTimeAsync(3100);expect(close).toHaveBeenCalledTimes(3);stop();await vi.advanceTimersByTimeAsync(2000);expect(close).toHaveBeenCalledTimes(3)})});
