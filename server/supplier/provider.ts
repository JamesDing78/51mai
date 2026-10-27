export interface SupplierCatalogItem {
  upstreamProductId: string;
  name: string;
  status: string;
}
export interface SupplierQuote {
  upstreamProductId: string;
  upstreamSpecId: string;
  unitCostCents: number;
  currency: string;
  priceConstraints?: { minimumRetailCents?: number; fixedRetailCents?: number };
}
export interface SupplierStock {
  upstreamProductId: string;
  upstreamSpecId: string;
  available: boolean;
  quantity?: number;
}
export interface SupplierOrderStatus {
  upstreamOrderId: string;
  status: string;
}

// Intentionally read-only. Purchase and credential retrieval are excluded until the supplier protocol is formally verified.
export interface SupplierProvider {
  listCatalog(): Promise<SupplierCatalogItem[]>;
  quote(upstreamProductId:string, upstreamSpecId:string, quantity:number): Promise<SupplierQuote>;
  stock(upstreamProductId:string, upstreamSpecId:string): Promise<SupplierStock>;
  orderStatus(upstreamOrderId:string): Promise<SupplierOrderStatus>;
}
