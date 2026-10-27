import { describe, expect, it } from 'vitest';
import { evaluateSupplierProtocolEvidence, READ_ONLY_SUPPLIER_OPERATIONS } from './readiness.js';

const complete = {
  baseUrl: 'https://supplier.example.test',
  authScheme: 'documented-signature-v1',
  catalogEndpoint: '/api/catalog',
  quoteEndpoint: '/api/quote',
  stockEndpoint: '/api/stock',
  orderStatusEndpoint: '/api/orders/:id',
  evidenceSource: 'official supplier API documentation',
  verifiedAt: '2026-10-23T10:00:00.000Z',
};

describe('supplier protocol evidence gate', () => {
  it('is not ready without a verified protocol manifest', () => {
    const result = evaluateSupplierProtocolEvidence(undefined);
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('protocol manifest');
  });

  it('requires all read-only protocol evidence fields', () => {
    const result = evaluateSupplierProtocolEvidence({ baseUrl: 'https://supplier.example.test' });
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(expect.arrayContaining(['authScheme','catalogEndpoint','quoteEndpoint','stockEndpoint','orderStatusEndpoint','evidenceSource','verifiedAt']));
  });

  it('accepts complete read-only evidence and exposes no purchase or credential retrieval operations', () => {
    const result = evaluateSupplierProtocolEvidence(complete);
    expect(result.ready).toBe(true);
    expect(result.missing).toEqual([]);
    expect(READ_ONLY_SUPPLIER_OPERATIONS).toEqual(['catalog','quote','stock','orderStatus']);
    expect(READ_ONLY_SUPPLIER_OPERATIONS).not.toEqual(expect.arrayContaining(['createOrder','purchase','retrieveCredential']));
  });

  it('rejects non-HTTPS supplier base URLs', () => {
    const result = evaluateSupplierProtocolEvidence({ ...complete, baseUrl: 'http://supplier.example.test' });
    expect(result.ready).toBe(false);
    expect(result.invalid).toContain('baseUrl must use HTTPS');
  });
});
