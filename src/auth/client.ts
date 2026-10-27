export type AuthRole = 'customer' | 'admin';

export interface AuthUser {
  id: string;
  username: string;
  role: AuthRole;
}

export interface AuthSession {
  user: AuthUser;
  csrfToken: string;
}

export interface AuthPolicies {
  termsVersion: string;
  privacyVersion: string;
  termsUrl: string;
  privacyUrl: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds?: number;
  readonly isNetwork: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { retryAfterSeconds?: number; isNetwork?: boolean } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.isNetwork = options.isNetwork ?? false;
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string): void {
  csrfToken = token;
}

export function clearCsrfToken(): void {
  csrfToken = null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function errorPayload(payload: Record<string, unknown> | undefined): { code: string; message: string } {
  const error = payload?.error;
  if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
    const value = error as Record<string, unknown>;
    if (typeof value.code === 'string' && typeof value.message === 'string') {
      return { code: value.code, message: value.message };
    }
  }
  return { code: 'REQUEST_FAILED', message: 'Request failed' };
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('Retry-After');
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

export async function apiRequest<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (csrfToken && (options.method ?? 'GET').toUpperCase() !== 'GET') headers.set('X-CSRF-Token', csrfToken);

  let response: Response;
  try {
    response = await fetch(path, { ...options, credentials: 'same-origin', headers });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiError(0, 'NETWORK_ERROR', 'Network request failed', { isNetwork: true });
  }

  if (response.status === 401) clearCsrfToken();
  const payload = await readJson(response);
  if (!response.ok) {
    const error = errorPayload(payload);
    throw new ApiError(response.status, error.code, error.message, { retryAfterSeconds: retryAfter(response) });
  }

  if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'data')) return undefined as T;
  return payload.data as T;
}

function jsonBody(body: Record<string, unknown>): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) };
}

export function getSession(signal?: AbortSignal): Promise<AuthSession> {
  return apiRequest<AuthSession>('/api/auth/session', { signal });
}

export function getPolicies(signal?: AbortSignal): Promise<AuthPolicies> {
  return apiRequest<AuthPolicies>('/api/auth/policies', { signal });
}

export function login(body: { identifier: string; password: string; remember: boolean }, signal?: AbortSignal): Promise<AuthSession> {
  return apiRequest<AuthSession>('/api/auth/login', { ...jsonBody(body), signal });
}

export function adminLogin(body: { identifier: string; password: string; remember: boolean }, signal?: AbortSignal): Promise<AuthSession> {
  return apiRequest<AuthSession>('/api/admin/login', { ...jsonBody(body), signal });
}

export function register(body: {
  username: string;
  password: string;
  confirmPassword: string;
  termsVersion: string;
  privacyVersion: string;
  acceptTerms: boolean;
}, signal?: AbortSignal): Promise<AuthSession> {
  return apiRequest<AuthSession>('/api/auth/register', { ...jsonBody(body), signal });
}

export function requestChallenge(body: { identifier: string; purpose: 'code_login' | 'reset_password' }, signal?: AbortSignal): Promise<{ challengeId: string }> {
  return apiRequest<{ challengeId: string }>('/api/auth/challenges', { ...jsonBody(body), signal });
}

export function codeLogin(body: {
  challengeId: string;
  identifier: string;
  code: string;
  termsVersion: string;
  privacyVersion: string;
  acceptTerms: boolean;
}, signal?: AbortSignal): Promise<AuthSession> {
  return apiRequest<AuthSession>('/api/auth/code-login', { ...jsonBody(body), signal });
}

export function resetPassword(body: {
  challengeId: string;
  identifier: string;
  code: string;
  password: string;
  confirmPassword: string;
}, signal?: AbortSignal): Promise<void> {
  return apiRequest<void>('/api/auth/reset-password', { ...jsonBody(body), signal });
}

export function logout(signal?: AbortSignal): Promise<void> {
  return apiRequest<void>('/api/auth/logout', { ...jsonBody({}), signal });
}

export function safeReturnTo(value: string | null | undefined, fallback: string): string {
  if (!value || value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value) || !value.startsWith('/')) {
    return fallback;
  }
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin !== window.location.origin) return fallback;
    if (parsed.pathname === '/login' || parsed.pathname.startsWith('/login/') || parsed.pathname === '/admin/login' || parsed.pathname.startsWith('/admin/login/')) {
      return fallback;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function returnToFromSearch(search: string, fallback: string): string {
  const value = new URLSearchParams(search).get('returnTo');
  return safeReturnTo(value, fallback);
}

export function loginRedirect(returnTo: string, role: AuthRole): string {
  const fallback = role === 'admin' ? '/admin' : '/ucenter';
  const target = safeReturnTo(returnTo, fallback);
  const targetPathname = new URL(target, window.location.origin).pathname;
  if (role === 'customer' && (targetPathname === '/admin' || targetPathname.startsWith('/admin/'))) return fallback;
  return target;
}


export type CustomerOrderStatus = 'pending_payment' | 'processing' | 'completed' | 'after_sale' | 'cancelled';
export interface CustomerOrderItem { id:string; productId:string; productName:string; specName:string; unitPriceCents:number; quantity:number; lineTotalCents:number; productImagePath:string|null }
export interface CustomerOrder { id:string; orderNumber:string; status:CustomerOrderStatus; paymentStatus:string; deliveryStatus:string; paymentMethod:string|null; totalAmountCents:number; createdAt:string; updatedAt:string; items:CustomerOrderItem[] }
export interface AccountSummary { user:{id:string;username:string;nickname:string;accountTier:string;accountStatus:string;createdAt:string}; orderCount:number; totalSpendCents:number }
export interface AdminCustomer { id:string; username:string; nickname:string; accountTier:string; accountStatus:string; createdAt:string; orderCount:number; totalSpendCents:number }

export function getAccountSummary(signal?:AbortSignal):Promise<AccountSummary>{return apiRequest<AccountSummary>('/api/account/summary',{signal})}
export function getOrders(params:{status?:CustomerOrderStatus;q?:string}={},signal?:AbortSignal):Promise<{orders:CustomerOrder[]}>{const q=new URLSearchParams();if(params.status)q.set('status',params.status);if(params.q?.trim())q.set('q',params.q.trim());const suffix=q.toString()?`?${q}`:'';return apiRequest<{orders:CustomerOrder[]}>(`/api/orders${suffix}`,{signal})}
export function getOrderDetail(id:string,signal?:AbortSignal):Promise<CustomerOrder>{return apiRequest<CustomerOrder>(`/api/orders/${encodeURIComponent(id)}`,{signal})}
export function createLocalOrder(body:{productId:string;specId:string;quantity:number;idempotencyKey:string},signal?:AbortSignal):Promise<CustomerOrder&{created:boolean;paymentAvailable:boolean}>{return apiRequest<CustomerOrder&{created:boolean;paymentAvailable:boolean}>('/api/orders',{...jsonBody(body),signal})}
export function getAdminCustomers(params:{tier?:string;q?:string}={},signal?:AbortSignal):Promise<{customers:AdminCustomer[]}>{const q=new URLSearchParams();if(params.tier)q.set('tier',params.tier);if(params.q?.trim())q.set('q',params.q.trim());const suffix=q.toString()?`?${q}`:'';return apiRequest<{customers:AdminCustomer[]}>(`/api/admin/customers${suffix}`,{signal})}

export interface FinanceSummary { availableBalanceCents:number; commissionBalanceCents:number; frozenBalanceCents:number }
export interface FinanceTransaction { id:string; referenceNo:string; transactionType:string; direction:'income'|'expense'; amountCents:number; balanceBeforeCents:number; balanceAfterCents:number; note:string|null; createdAt:string }
export interface RechargeOrder { id:string; rechargeNumber:string; amountCents:number; channel:'alipay'|'topup_card'; status:'pending_payment'|'paid'|'failed'|'closed'; createdAt:string; updatedAt:string; paymentAvailable?:boolean }
export function getFinanceSummary(signal?:AbortSignal):Promise<FinanceSummary>{return apiRequest<FinanceSummary>('/api/finance/summary',{signal})}
export function getFinanceTransactions(params:{type?:string;q?:string}={},signal?:AbortSignal):Promise<{transactions:FinanceTransaction[]}>{const q=new URLSearchParams();if(params.type)q.set('type',params.type);if(params.q?.trim())q.set('q',params.q.trim());const suffix=q.toString()?`?${q}`:'';return apiRequest<{transactions:FinanceTransaction[]}>(`/api/finance/transactions${suffix}`,{signal})}
export function getRecharges(signal?:AbortSignal):Promise<{recharges:RechargeOrder[]}>{return apiRequest<{recharges:RechargeOrder[]}>('/api/recharges',{signal})}
export function createRecharge(body:{amountCents:number;channel:'alipay'|'topup_card'},signal?:AbortSignal):Promise<RechargeOrder>{return apiRequest<RechargeOrder>('/api/recharges',{...jsonBody(body),signal})}

export type AfterSaleStatus = 'pending'|'processing'|'completed'|'rejected'|'closed';
export interface AfterSaleRecord { id:string; orderId:string; orderNumber:string; productName:string; reason:string; status:AfterSaleStatus; createdAt:string; updatedAt:string }
export interface FavoriteRecord { productId:string; productName:string; productImagePath:string|null; priceCents:number; createdAt:string }
export interface UserMessageRecord { id:string; category:'order'|'general'; title:string; content:string; read:boolean; readAt:string|null; createdAt:string }
export interface CardDeliveryRecord { id:string; orderId:string; orderNumber:string; productId:string; productName:string; credentialState:'pending'|'available'|'revoked'; credentialAvailable:boolean; createdAt:string }
export function getAfterSales(params:{status?:AfterSaleStatus;q?:string}={},signal?:AbortSignal):Promise<{afterSales:AfterSaleRecord[]}>{const q=new URLSearchParams();if(params.status)q.set('status',params.status);if(params.q?.trim())q.set('q',params.q.trim());const suffix=q.toString()?`?${q}`:'';return apiRequest<{afterSales:AfterSaleRecord[]}>(`/api/after-sales${suffix}`,{signal})}
export function getFavorites(params:{q?:string}={},signal?:AbortSignal):Promise<{favorites:FavoriteRecord[]}>{const q=new URLSearchParams();if(params.q?.trim())q.set('q',params.q.trim());const suffix=q.toString()?`?${q}`:'';return apiRequest<{favorites:FavoriteRecord[]}>(`/api/favorites${suffix}`,{signal})}
export function getMessages(params:{status?:'all'|'unread'|'read'}={},signal?:AbortSignal):Promise<{messages:UserMessageRecord[]}>{const q=new URLSearchParams();if(params.status&&params.status!=='all')q.set('status',params.status);const suffix=q.toString()?`?${q}`:'';return apiRequest<{messages:UserMessageRecord[]}>(`/api/messages${suffix}`,{signal})}
export function getCards(params:{q?:string}={},signal?:AbortSignal):Promise<{cards:CardDeliveryRecord[]}>{const q=new URLSearchParams();if(params.q?.trim())q.set('q',params.q.trim());const suffix=q.toString()?`?${q}`:'';return apiRequest<{cards:CardDeliveryRecord[]}>(`/api/cards${suffix}`,{signal})}

export interface AccountSecurityContact { kind:'email'|'phone'; masked:string; verified:boolean }
export interface AccountSecurity { profile:{username:string;nickname:string;accountTier:string;hasPassword:boolean}; contacts:AccountSecurityContact[] }
export interface AccountLoginLog { id:string; succeeded:boolean; attemptedAt:string; ipAddress:string; userAgent:string|null }
export function getAccountSecurity(signal?:AbortSignal):Promise<AccountSecurity>{return apiRequest<AccountSecurity>('/api/account/security',{signal})}
export function getAccountLoginLogs(signal?:AbortSignal):Promise<{loginLogs:AccountLoginLog[]}>{return apiRequest<{loginLogs:AccountLoginLog[]}>('/api/account/login-logs',{signal})}

export interface PriceLogRecord { id:string; productId:string; productName:string; oldPriceCents:number; newPriceCents:number; changeCents:number; status:string; changedAt:string }
export function getPriceLogs(params:{q?:string}={},signal?:AbortSignal):Promise<{priceLogs:PriceLogRecord[]}>{const q=new URLSearchParams();if(params.q?.trim())q.set('q',params.q.trim());const suffix=q.toString()?`?${q}`:'';return apiRequest<{priceLogs:PriceLogRecord[]}>(`/api/price-logs${suffix}`,{signal})}


export interface FootmarkRecord { productId:string; productName:string; productImagePath:string|null; priceCents:number; viewedAt:string }
export function getFootmarks(signal?:AbortSignal):Promise<{footmarks:FootmarkRecord[]}>{return apiRequest<{footmarks:FootmarkRecord[]}>('/api/footmarks',{signal})}
export function recordFootmark(body:{productId:string;productName:string;productImagePath:string|null;priceCents:number},signal?:AbortSignal):Promise<void>{return apiRequest<void>('/api/footmarks',{...jsonBody(body),signal})}

export interface AdminOrderRecord { id:string; orderNumber:string; username:string; status:CustomerOrderStatus; paymentStatus:string; deliveryStatus:string; manualProcessingStatus:'none'|'reviewing'|'held'; adminNote:string|null; totalAmountCents:number; createdAt:string; updatedAt:string }
export function getAdminOrders(params:{q?:string;status?:CustomerOrderStatus}={},signal?:AbortSignal):Promise<{orders:AdminOrderRecord[]}>{const q=new URLSearchParams();if(params.q?.trim())q.set('q',params.q.trim());if(params.status)q.set('status',params.status);const suffix=q.toString()?`?${q}`:'';return apiRequest<{orders:AdminOrderRecord[]}>(`/api/admin/orders${suffix}`,{signal})}
export function updateAdminOrderManual(id:string,body:{manualStatus:'none'|'reviewing'|'held';note:string},signal?:AbortSignal):Promise<AdminOrderRecord>{return apiRequest<AdminOrderRecord>(`/api/admin/orders/${encodeURIComponent(id)}/manual`,{...jsonBody(body),method:'PATCH',signal})}

export function cancelOrder(id:string,reason='customer_cancelled',signal?:AbortSignal):Promise<CustomerOrder>{return apiRequest<CustomerOrder>(`/api/orders/${encodeURIComponent(id)}/cancel`,{...jsonBody({reason}),signal})}
export interface DeliveryItem { id:string; productName:string; deliveryKind:'card'|'content'; payload:string|null; createdAt:string }
export function getOrderDelivery(id:string,signal?:AbortSignal):Promise<{items:DeliveryItem[]}>{return apiRequest<{items:DeliveryItem[]}>(`/api/orders/${encodeURIComponent(id)}/delivery`,{signal})}
export interface AdminPaymentConfig { wechat:{configured:boolean;paymentReady:boolean;merchantId:string|null;callbackPath:string}; alipay:{configured:boolean;paymentReady:boolean;appId:string|null;callbackPath:string} }
export function getAdminPaymentConfig(signal?:AbortSignal):Promise<AdminPaymentConfig>{return apiRequest<AdminPaymentConfig>('/api/admin/payment-config',{signal})}
export interface FulfillmentJob { orderId:string; orderNumber:string; mode:'auto'|'manual'; status:'pending'|'processing'|'completed'|'failed'; lastError:string|null; updatedAt:string }
export function getFulfillmentJobs(signal?:AbortSignal):Promise<{jobs:FulfillmentJob[]}>{return apiRequest<{jobs:FulfillmentJob[]}>('/api/admin/fulfillment/jobs',{signal})}
export function addFulfillmentAsset(body:{productId:string;specId:string;deliveryKind:'card'|'content';payload:string},signal?:AbortSignal):Promise<{id:string}>{return apiRequest<{id:string}>('/api/admin/fulfillment/assets',{...jsonBody(body),signal})}
export function manualFulfillOrder(id:string,body:{deliveryKind:'card'|'content';payload:string},signal?:AbortSignal):Promise<{orderId:string;status:string}>{return apiRequest<{orderId:string;status:string}>(`/api/admin/orders/${encodeURIComponent(id)}/fulfill`,{...jsonBody(body),signal})}

export function getPaymentAvailability(signal?:AbortSignal):Promise<{wechat:boolean;alipay:boolean}>{return apiRequest<{wechat:boolean;alipay:boolean}>('/api/payments/availability',{signal})}
export function createOrderPayment(id:string,provider:'wechat'|'alipay',signal?:AbortSignal):Promise<{provider:'wechat'|'alipay';qrCode:string;orderNumber:string}>{return apiRequest<{provider:'wechat'|'alipay';qrCode:string;orderNumber:string}>(`/api/payments/orders/${encodeURIComponent(id)}/create`,{...jsonBody({provider}),signal})}

export interface CatalogCategory { id:string; name:string; icon:string; sortOrder:number }
export interface CatalogSpec { id:string; name:string; priceCents:number; stock:number; status:'active'|'inactive' }
export interface CatalogProduct { id:string; name:string; description:string; image:string|null; icon:string; marketPriceCents:number|null; deliveryType:'card'|'content'; status:'active'|'inactive'; category:string; categories:string[]; categoryIds:string[]; priceCents:number; stock:number; specs:CatalogSpec[] }
export function getCatalog(signal?:AbortSignal):Promise<{categories:CatalogCategory[];products:CatalogProduct[]}>{return apiRequest<{categories:CatalogCategory[];products:CatalogProduct[]}>('/api/catalog',{signal})}
export function getCatalogProduct(id:string,signal?:AbortSignal):Promise<CatalogProduct>{return apiRequest<CatalogProduct>(`/api/catalog/products/${encodeURIComponent(id)}`,{signal})}
export interface AdminCatalogSpec extends CatalogSpec { partnerCostCents:number }
export interface AdminCatalogProduct extends Omit<CatalogProduct,'specs'> { partnerCostCents:number; specs:AdminCatalogSpec[] }
export interface AdminCatalogCategory extends CatalogCategory { status:'active'|'inactive' }
export function getAdminProducts(params:{q?:string}={},signal?:AbortSignal):Promise<{products:AdminCatalogProduct[]}>{const q=new URLSearchParams();if(params.q?.trim())q.set('q',params.q.trim());return apiRequest<{products:AdminCatalogProduct[]}>(`/api/admin/products${q.toString()?`?${q}`:''}`,{signal})}
export function getAdminProduct(id:string,signal?:AbortSignal):Promise<AdminCatalogProduct>{return apiRequest<AdminCatalogProduct>(`/api/admin/products/${encodeURIComponent(id)}`,{signal})}
export function getAdminCategories(signal?:AbortSignal):Promise<{categories:AdminCatalogCategory[]}>{return apiRequest<{categories:AdminCatalogCategory[]}>('/api/admin/categories',{signal})}
export function updateAdminProduct(id:string,body:{name:string;description:string;marketPriceCents:number|null;status:'active'|'inactive';deliveryType:'card'|'content';categoryIds:string[]},signal?:AbortSignal):Promise<AdminCatalogProduct>{return apiRequest<AdminCatalogProduct>(`/api/admin/products/${encodeURIComponent(id)}`,{...jsonBody(body),method:'PATCH',signal})}
export function updateAdminProductSpec(productId:string,specId:string,body:{name:string;partnerCostCents:number;priceCents:number;stock:number;status:'active'|'inactive'},signal?:AbortSignal):Promise<AdminCatalogProduct>{return apiRequest<AdminCatalogProduct>(`/api/admin/products/${encodeURIComponent(productId)}/specs/${encodeURIComponent(specId)}`,{...jsonBody(body),method:'PATCH',signal})}
export function createAdminProduct(body:{name:string;description:string;marketPriceCents:number|null;deliveryType:'card'|'content';categoryIds:string[];spec:{name:string;partnerCostCents:number;priceCents:number;stock:number}},signal?:AbortSignal):Promise<AdminCatalogProduct>{return apiRequest<AdminCatalogProduct>('/api/admin/products',{...jsonBody(body),method:'POST',signal})}
export function addAdminProductSpec(productId:string,body:{name:string;partnerCostCents:number;priceCents:number;stock:number},signal?:AbortSignal):Promise<AdminCatalogProduct>{return apiRequest<AdminCatalogProduct>(`/api/admin/products/${encodeURIComponent(productId)}/specs`,{...jsonBody(body),method:'POST',signal})}
export function deleteAdminProductSpec(productId:string,specId:string,signal?:AbortSignal):Promise<AdminCatalogProduct>{return apiRequest<AdminCatalogProduct>(`/api/admin/products/${encodeURIComponent(productId)}/specs/${encodeURIComponent(specId)}`,{method:'DELETE',signal})}
export function archiveAdminProduct(productId:string,signal?:AbortSignal):Promise<AdminCatalogProduct>{return apiRequest<AdminCatalogProduct>(`/api/admin/products/${encodeURIComponent(productId)}`,{method:'DELETE',signal})}
