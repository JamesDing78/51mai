import fs from 'node:fs';
import path from 'node:path';
import { evaluateSupplierProtocolEvidence, type SupplierProtocolEvidence } from '../supplier/readiness.js';

const manifestPath = process.env.SUPPLIER_PROTOCOL_MANIFEST?.trim();
let evidence: SupplierProtocolEvidence | undefined;
let manifestError: string | undefined;
if (manifestPath) {
  try {
    const resolved = path.resolve(manifestPath);
    evidence = JSON.parse(fs.readFileSync(resolved, 'utf8')) as SupplierProtocolEvidence;
  } catch {
    manifestError = 'SUPPLIER_PROTOCOL_MANIFEST could not be read as JSON';
  }
}
const result = evaluateSupplierProtocolEvidence(evidence);
if (manifestError) result.invalid.push(manifestError);
const ready = result.ready && !manifestError;
console.log(JSON.stringify({ ready, manifestConfigured:Boolean(manifestPath), operations:result.operations, missing:result.missing, invalid:result.invalid }, null, 2));
if (!ready) process.exitCode = 2;
