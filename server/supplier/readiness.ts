export const READ_ONLY_SUPPLIER_OPERATIONS = ['catalog','quote','stock','orderStatus'] as const;

export interface SupplierProtocolEvidence {
  baseUrl?: string;
  authScheme?: string;
  catalogEndpoint?: string;
  quoteEndpoint?: string;
  stockEndpoint?: string;
  orderStatusEndpoint?: string;
  evidenceSource?: string;
  verifiedAt?: string;
}

export interface SupplierReadinessResult {
  ready: boolean;
  missing: string[];
  invalid: string[];
  operations: readonly string[];
}

const required = ['authScheme','catalogEndpoint','quoteEndpoint','stockEndpoint','orderStatusEndpoint','evidenceSource','verifiedAt'] as const;

export function evaluateSupplierProtocolEvidence(input: SupplierProtocolEvidence | undefined): SupplierReadinessResult {
  if (!input) return { ready:false, missing:['protocol manifest'], invalid:[], operations:READ_ONLY_SUPPLIER_OPERATIONS };
  const missing:string[]=[];
  if (!input.baseUrl?.trim()) missing.push('baseUrl');
  for (const key of required) if (!input[key]?.trim()) missing.push(key);
  const invalid:string[]=[];
  if (input.baseUrl?.trim()) {
    try {
      const url = new URL(input.baseUrl);
      if (url.protocol !== 'https:') invalid.push('baseUrl must use HTTPS');
    } catch {
      invalid.push('baseUrl must be a valid URL');
    }
  }
  if (input.verifiedAt?.trim() && Number.isNaN(Date.parse(input.verifiedAt))) invalid.push('verifiedAt must be an ISO-compatible timestamp');
  return { ready:missing.length===0&&invalid.length===0, missing, invalid, operations:READ_ONLY_SUPPLIER_OPERATIONS };
}
