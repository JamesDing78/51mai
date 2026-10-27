import { calculateSalePrice, products } from './data';

describe('51mai 核心商品业务模型', () => {
  it('默认售价按合伙人购买价 × 1.25 计算', () => {
    expect(calculateSalePrice(80)).toBe(100);
    expect(calculateSalePrice(100)).toBe(125);
  });

  it('模拟商品结构保留上游映射、成本、审核与同步状态', () => {
    const product = products[0];
    expect(product).toMatchObject({
      upstreamProductId: expect.any(String),
      partnerCost: expect.any(Number),
      reviewStatus: expect.stringMatching(/approved|pending|blocked/),
      syncStatus: expect.stringMatching(/synced|failed|pending/),
      saleMode: expect.stringMatching(/cost_plus|fixed/),
    });
    expect(product.price).toBe(calculateSalePrice(product.partnerCost));
  });
});
