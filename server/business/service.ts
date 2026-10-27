import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { ensureLocalCatalogSeeded } from '../catalog/seed.js';

export type OrderStatus = 'pending_payment' | 'processing' | 'completed' | 'after_sale' | 'cancelled';

interface AccountRow extends RowDataPacket {
  id: string; username_normalized: string; nickname: string | null; account_tier: string;
  account_status: 'active' | 'frozen' | 'disabled'; created_at: string | Date;
  order_count: number | string; total_spend_cents: number | string;
}
interface OrderRow extends RowDataPacket {
  id:string; order_number:string; status:OrderStatus; payment_status:string; delivery_status:string;
  payment_method:string|null; total_amount_cents:number|string; created_at:string|Date; updated_at:string|Date;
}
interface ItemRow extends RowDataPacket {
  id:string; order_id:string; product_id:string; spec_id:string|null; product_name:string; spec_name:string; unit_price_cents:number|string;
  partner_cost_cents:number|string|null; delivery_type:'card'|'content'|null;
  quantity:number|string; line_total_cents:number|string; product_image_path:string|null;
}
interface InventoryRow extends RowDataPacket { available_quantity:number|string }

interface FinanceSummaryRow extends RowDataPacket { available_balance_cents:number|string; commission_balance_cents:number|string; frozen_balance_cents:number|string }
interface FinanceTransactionRow extends RowDataPacket { id:string; reference_no:string; transaction_type:string; direction:'income'|'expense'; amount_cents:number|string; balance_before_cents:number|string; balance_after_cents:number|string; note:string|null; created_at:string|Date }
interface RechargeRow extends RowDataPacket { id:string; recharge_number:string; amount_cents:number|string; channel:'alipay'|'topup_card'; status:'pending_payment'|'paid'|'failed'|'closed'; created_at:string|Date; updated_at:string|Date }
interface AfterSaleRow extends RowDataPacket { id:string; order_id:string; order_number_snapshot:string; product_name_snapshot:string; reason:string; status:'pending'|'processing'|'completed'|'rejected'|'closed'; created_at:string|Date; updated_at:string|Date }
interface FavoriteRow extends RowDataPacket { product_id:string; product_name:string; product_image_path:string|null; price_cents:number|string; created_at:string|Date }
interface MessageRow extends RowDataPacket { id:string; category:'order'|'general'; title:string; content:string; read_at:string|Date|null; created_at:string|Date }
interface CardRow extends RowDataPacket { id:string; order_id:string; order_number:string; product_id:string; product_name:string; credential_state:'pending'|'available'|'revoked'; created_at:string|Date }

interface CustomerRow extends RowDataPacket {
  id:string; username_normalized:string; nickname:string|null; account_tier:string; account_status:string;
  created_at:string|Date; order_count:number|string; total_spend_cents:number|string;
}
interface AccountSecurityRow extends RowDataPacket { username_normalized:string; nickname:string|null; account_tier:string; has_password:number|string|boolean }
interface AccountContactRow extends RowDataPacket { kind:'email'|'phone'; identifier_normalized:string; verified_at:string|Date|null }
interface LoginLogRow extends RowDataPacket { id:string; succeeded:number|string|boolean; attempted_at:string|Date; ip_address:string|null; user_agent:string|null }
interface PriceLogRow extends RowDataPacket { id:string; product_id:string; product_name_snapshot:string; old_price_cents:number|string; new_price_cents:number|string; status:string; changed_at:string|Date }
interface AdminOrderRow extends RowDataPacket { id:string; order_number:string; username_normalized:string; status:OrderStatus; payment_status:string; delivery_status:string; manual_processing_status:'none'|'reviewing'|'held'; admin_note:string|null; total_amount_cents:number|string; created_at:string|Date; updated_at:string|Date }
interface FootmarkRow extends RowDataPacket { product_id:string; product_name:string; product_image_path:string|null; price_cents:number|string; viewed_at:string|Date }

function asInteger(value:number|string):number { const n=Number(value); if(!Number.isSafeInteger(n)||n<0) throw new Error('database returned invalid integer'); return n; }
function iso(value:string|Date):string { return value instanceof Date ? value.toISOString() : String(value); }
function boundedQuery(value:unknown):string { return typeof value==='string' ? value.trim().slice(0,100) : ''; }
function validStatus(value:unknown):OrderStatus|undefined {
  return ['pending_payment','processing','completed','after_sale','cancelled'].includes(String(value)) ? value as OrderStatus : undefined;
}

export class BusinessService {
  constructor(private readonly pool:Pool) {}

  async accountSummary(userId:string) {
    const [rows]=await this.pool.execute<AccountRow[]>(`SELECT u.id, u.username_normalized, COALESCE(p.nickname, u.username_normalized) AS nickname,
      COALESCE(p.account_tier, '普通用户') AS account_tier, u.account_status, u.created_at,
      COUNT(o.id) AS order_count,
      COALESCE(SUM(CASE WHEN o.payment_status='paid' AND o.status <> 'cancelled' THEN o.total_amount_cents ELSE 0 END),0) AS total_spend_cents
      FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id LEFT JOIN orders o ON o.user_id=u.id
      WHERE u.id=? GROUP BY u.id, u.username_normalized, p.nickname, p.account_tier, u.account_status, u.created_at LIMIT 1`,[userId]);
    const row=rows[0]; if(!row) return null;
    return {user:{id:row.id,username:row.username_normalized,nickname:row.nickname ?? row.username_normalized,accountTier:row.account_tier,accountStatus:row.account_status,createdAt:iso(row.created_at)},orderCount:asInteger(row.order_count),totalSpendCents:asInteger(row.total_spend_cents)};
  }

  async accountSecurity(userId:string) {
    const [rows]=await this.pool.execute<AccountSecurityRow[]>(`SELECT u.username_normalized, COALESCE(p.nickname,u.username_normalized) AS nickname, COALESCE(p.account_tier,'普通用户') AS account_tier, (u.password_hash IS NOT NULL) AS has_password FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id=? LIMIT 1`,[userId]);
    const row=rows[0]; if(!row) return null;
    const [contacts]=await this.pool.execute<AccountContactRow[]>(`SELECT kind,identifier_normalized,verified_at FROM user_contacts WHERE user_id=? ORDER BY kind,created_at DESC`,[userId]);
    return {profile:{username:row.username_normalized,nickname:row.nickname??row.username_normalized,accountTier:row.account_tier,hasPassword:Boolean(Number(row.has_password))},contacts:contacts.map(c=>({kind:c.kind,masked:maskContact(c.kind,c.identifier_normalized),verified:Boolean(c.verified_at)}))};
  }

  async accountLoginLogs(userId:string) {
    const [rows]=await this.pool.execute<LoginLogRow[]>(`SELECT id,succeeded,attempted_at,INET6_NTOA(ip_address) AS ip_address,user_agent FROM login_logs WHERE user_id=? ORDER BY attempted_at DESC LIMIT 100`,[userId]);
    return rows.map(r=>({id:r.id,succeeded:Boolean(Number(r.succeeded)),attemptedAt:iso(r.attempted_at),ipAddress:maskIp(r.ip_address),userAgent:r.user_agent}));
  }

  async listOrders(userId:string, options:{status?:unknown;q?:unknown}={}) {
    const status=validStatus(options.status); const q=boundedQuery(options.q); const where=['o.user_id = ?']; const values:string[]=[userId];
    if(status){where.push('o.status = ?');values.push(status)}
    if(q){where.push('(o.order_number LIKE ? OR EXISTS (SELECT 1 FROM order_items oi2 WHERE oi2.order_id=o.id AND oi2.product_name LIKE ?))'); const like=`%${q}%`;values.push(like,like)}
    const [rows]=await this.pool.execute<OrderRow[]>(`SELECT o.id,o.order_number,o.status,o.payment_status,o.delivery_status,o.payment_method,o.total_amount_cents,o.created_at,o.updated_at FROM orders o WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC LIMIT 100`,values);
    if(!rows.length) return [];
    const ids=rows.map(r=>r.id); const [items]=await this.pool.query<ItemRow[]>(`SELECT id,order_id,product_id,spec_id,product_name,spec_name,unit_price_cents,partner_cost_cents,delivery_type,quantity,line_total_cents,product_image_path FROM order_items WHERE order_id IN (${ids.map(()=>'?').join(',')}) ORDER BY id`,ids);
    const byOrder=new Map<string,ReturnType<typeof mapItem>[]>(); for(const item of items){const list=byOrder.get(item.order_id)??[];list.push(mapItem(item));byOrder.set(item.order_id,list)}
    return rows.map(row=>mapOrder(row,byOrder.get(row.id)??[]));
  }

  async orderDetail(userId:string, orderId:string) {
    const [rows]=await this.pool.execute<OrderRow[]>(`SELECT id,order_number,status,payment_status,delivery_status,payment_method,total_amount_cents,created_at,updated_at FROM orders WHERE id=? AND user_id=? LIMIT 1`,[orderId,userId]);
    const row=rows[0]; if(!row) return null;
    const [items]=await this.pool.execute<ItemRow[]>(`SELECT id,order_id,product_id,spec_id,product_name,spec_name,unit_price_cents,partner_cost_cents,delivery_type,quantity,line_total_cents,product_image_path FROM order_items WHERE order_id=? ORDER BY id`,[orderId]);
    return mapOrder(row,items.map(mapItem));
  }

  async createLocalOrder(userId:string,input:{productId:unknown;specId:unknown;quantity:unknown;idempotencyKey:unknown}) {
    if(typeof input.productId!=='string'||typeof input.specId!=='string') throw new Error('PRODUCT_UNAVAILABLE');
    if(typeof input.idempotencyKey!=='string'||!/^[A-Za-z0-9_-]{8,64}$/.test(input.idempotencyKey)) throw new Error('INVALID_ORDER');
    const quantity=Number(input.quantity); if(!Number.isSafeInteger(quantity)||quantity<1||quantity>1000) throw new Error('INVALID_ORDER');
    await ensureLocalCatalogSeeded(this.pool);
    const connection=await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [existing]=await connection.execute<OrderRow[]>('SELECT id,order_number,status,payment_status,delivery_status,payment_method,total_amount_cents,created_at,updated_at FROM orders WHERE user_id=? AND client_request_id=? LIMIT 1',[userId,input.idempotencyKey]);
      if(existing[0]) { await connection.commit(); return {...await this.orderDetail(userId,existing[0].id),created:false,paymentAvailable:false}; }
      const [catalogRows]=await connection.execute<RowDataPacket[]>(`SELECT p.id AS product_id,p.name AS product_name,p.image_path,p.delivery_type,s.id AS spec_id,s.name AS spec_name,s.partner_cost_cents,s.price_cents FROM local_products p JOIN local_product_specs s ON s.product_id=p.id WHERE p.id=? AND s.id=? AND p.status='active' AND s.status='active' LIMIT 1 FOR UPDATE`,[input.productId,input.specId]);
      const catalog=catalogRows[0];if(!catalog)throw new Error('PRODUCT_UNAVAILABLE');
      const [inventory]=await connection.execute<InventoryRow[]>('SELECT available_quantity FROM local_product_inventory WHERE product_id=? AND spec_id=? FOR UPDATE',[input.productId,input.specId]);
      if(!inventory[0]||asInteger(inventory[0].available_quantity)<quantity) throw new Error('INSUFFICIENT_STOCK');
      const unitPriceCents=asInteger(catalog.price_cents),partnerCostCents=asInteger(catalog.partner_cost_cents);const orderId=randomUUID(),itemId=randomUUID();const orderNumber=`L${Date.now()}${orderId.replaceAll('-','').slice(0,8).toUpperCase()}`;const total=unitPriceCents*quantity;
      await connection.execute("INSERT INTO orders (id,order_number,user_id,client_request_id,status,payment_status,delivery_status,payment_method,total_amount_cents,expires_at) VALUES (?,?,?,?,'pending_payment','unpaid','pending',NULL,?,UTC_TIMESTAMP(6)+INTERVAL 30 MINUTE)",[orderId,orderNumber,userId,input.idempotencyKey,total]);
      await connection.execute('INSERT INTO order_items (id,order_id,product_id,spec_id,product_name,spec_name,unit_price_cents,partner_cost_cents,delivery_type,quantity,line_total_cents,product_image_path) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',[itemId,orderId,catalog.product_id,catalog.spec_id,catalog.product_name,catalog.spec_name,unitPriceCents,partnerCostCents,catalog.delivery_type,quantity,total,catalog.image_path]);
      await connection.execute('UPDATE local_product_inventory SET available_quantity=available_quantity-?,updated_at=UTC_TIMESTAMP(6) WHERE product_id=? AND spec_id=?',[quantity,input.productId,input.specId]);
      await connection.commit();const created=await this.orderDetail(userId,orderId);if(!created)throw new Error('ORDER_CREATE_FAILED');return {...created,created:true,paymentAvailable:false};
    } catch(error) {
      await connection.rollback().catch(()=>undefined);
      if(isDuplicateEntry(error)){const [rows]=await this.pool.execute<RowDataPacket[]>('SELECT id FROM orders WHERE user_id=? AND client_request_id=? LIMIT 1',[userId,input.idempotencyKey]);const orderId=typeof rows[0]?.id==='string'?rows[0].id:'';const existing=orderId?await this.orderDetail(userId,orderId):null;if(existing)return {...existing,created:false,paymentAvailable:false};}
      throw error;
    } finally { connection.release(); }
  }

  async cancelOrder(userId:string,orderId:string,reason='customer_cancelled') {
    const result=await this.cancelPendingOrder(orderId,userId,reason); if(result==='not_found') return null; if(result==='not_cancellable') throw new Error('ORDER_NOT_CANCELLABLE'); return this.orderDetail(userId,orderId);
  }

  async closeExpiredOrders() {
    const [rows]=await this.pool.execute<RowDataPacket[]>("SELECT id FROM orders WHERE client_request_id IS NOT NULL AND status='pending_payment' AND payment_status='unpaid' AND expires_at IS NOT NULL AND expires_at<=UTC_TIMESTAMP(6) ORDER BY expires_at ASC LIMIT 100");
    let closed=0; for(const row of rows){if(typeof row.id==='string'){const result=await this.cancelPendingOrder(row.id,undefined,'payment_timeout');if(result==='cancelled')closed+=1}} return {closed};
  }

  private async cancelPendingOrder(orderId:string,userId:string|undefined,reason:string):Promise<'cancelled'|'already_cancelled'|'not_found'|'not_cancellable'> {
    const connection=await this.pool.getConnection();
    try{await connection.beginTransaction();
      const sql=userId?'SELECT id,status,payment_status,stock_released_at FROM orders WHERE id=? AND user_id=? FOR UPDATE':'SELECT id,status,payment_status,stock_released_at FROM orders WHERE id=? FOR UPDATE';
      const params=userId?[orderId,userId]:[orderId]; const [rows]=await connection.execute<RowDataPacket[]>(sql,params); const row=rows[0]; if(!row){await connection.rollback();return 'not_found'}
      if(row.status==='cancelled'){await connection.commit();return 'already_cancelled'}
      if(row.status!=='pending_payment'||row.payment_status!=='unpaid'){await connection.rollback();return 'not_cancellable'}
      if(!row.stock_released_at){await this.releaseOrderStock(connection,orderId)}
      await connection.execute("UPDATE orders SET status='cancelled',cancelled_at=UTC_TIMESTAMP(6),cancel_reason=?,stock_released_at=COALESCE(stock_released_at,UTC_TIMESTAMP(6)),updated_at=UTC_TIMESTAMP(6) WHERE id=?",[reason.slice(0,64),orderId]);
      await connection.commit();return 'cancelled';
    }catch(error){await connection.rollback().catch(()=>undefined);throw error}finally{connection.release()}
  }

  private async releaseOrderStock(connection:PoolConnection,orderId:string){
    const [items]=await connection.execute<RowDataPacket[]>('SELECT product_id,spec_id,quantity FROM order_items WHERE order_id=?',[orderId]);
    for(const item of items){if(typeof item.product_id!=='string'||typeof item.spec_id!=='string')throw new Error('STOCK_RELEASE_UNAVAILABLE');const quantity=asInteger(item.quantity);await connection.execute('UPDATE local_product_inventory SET available_quantity=available_quantity+?,updated_at=UTC_TIMESTAMP(6) WHERE product_id=? AND spec_id=?',[quantity,item.product_id,item.spec_id])}
  }


  async financeSummary(userId:string) {
    const [rows]=await this.pool.execute<FinanceSummaryRow[]>(`SELECT COALESCE(b.available_balance_cents,0) AS available_balance_cents, COALESCE(b.commission_balance_cents,0) AS commission_balance_cents, COALESCE(b.frozen_balance_cents,0) AS frozen_balance_cents FROM users u LEFT JOIN account_balances b ON b.user_id=u.id WHERE u.id=? LIMIT 1`,[userId]);
    const row=rows[0]; if(!row) return null;
    return {availableBalanceCents:asInteger(row.available_balance_cents),commissionBalanceCents:asInteger(row.commission_balance_cents),frozenBalanceCents:asInteger(row.frozen_balance_cents)};
  }

  async financeTransactions(userId:string, options:{type?:unknown;q?:unknown}={}) {
    const type=typeof options.type==='string'?options.type.trim().slice(0,32):''; const q=boundedQuery(options.q); const where=['user_id = ?']; const values:string[]=[userId];
    if(type){where.push('transaction_type = ?');values.push(type)}
    if(q){where.push('(reference_no LIKE ? OR COALESCE(note,\'\') LIKE ?)');const like=`%${q}%`;values.push(like,like)}
    const [rows]=await this.pool.execute<FinanceTransactionRow[]>(`SELECT id,reference_no,transaction_type,direction,amount_cents,balance_before_cents,balance_after_cents,note,created_at FROM account_transactions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`,values);
    return rows.map(r=>({id:r.id,referenceNo:r.reference_no,transactionType:r.transaction_type,direction:r.direction,amountCents:asInteger(r.amount_cents),balanceBeforeCents:asInteger(r.balance_before_cents),balanceAfterCents:asInteger(r.balance_after_cents),note:r.note,createdAt:iso(r.created_at)}));
  }

  async listRecharges(userId:string) {
    const [rows]=await this.pool.execute<RechargeRow[]>(`SELECT id,recharge_number,amount_cents,channel,status,created_at,updated_at FROM recharge_orders WHERE user_id=? ORDER BY created_at DESC LIMIT 200`,[userId]);
    return rows.map(mapRecharge);
  }

  async createRecharge(userId:string, input:{amountCents:unknown;channel:unknown}) {
    const amount=Number(input.amountCents); if(!Number.isSafeInteger(amount)||amount<=0||amount>100_000_000) throw new Error('INVALID_RECHARGE_AMOUNT');
    if(input.channel!=='alipay'&&input.channel!=='topup_card') throw new Error('INVALID_RECHARGE_CHANNEL');
    const id=randomUUID(); const rechargeNumber=`R${Date.now()}${id.replaceAll('-','').slice(0,8).toUpperCase()}`;
    await this.pool.execute("INSERT INTO recharge_orders (id,recharge_number,user_id,amount_cents,channel,status) VALUES (?,?,?,?,?,'pending_payment')",[id,rechargeNumber,userId,amount,input.channel]);
    const [rows]=await this.pool.execute<RechargeRow[]>('SELECT id,recharge_number,amount_cents,channel,status,created_at,updated_at FROM recharge_orders WHERE id=? AND user_id=? LIMIT 1',[id,userId]);
    const row=rows[0]; if(!row) throw new Error('RECHARGE_CREATE_FAILED'); return {...mapRecharge(row),paymentAvailable:false};
  }

  async listAfterSales(userId:string, options:{status?:unknown;q?:unknown}={}) {
    const status=typeof options.status==='string'&&['pending','processing','completed','rejected','closed'].includes(options.status)?options.status:''; const q=boundedQuery(options.q); const where=['user_id = ?']; const values:string[]=[userId];
    if(status){where.push('status = ?');values.push(status)}
    if(q){where.push('(order_number_snapshot LIKE ? OR product_name_snapshot LIKE ? OR reason LIKE ?)');const like=`%${q}%`;values.push(like,like,like)}
    const [rows]=await this.pool.execute<AfterSaleRow[]>(`SELECT id,order_id,order_number_snapshot,product_name_snapshot,reason,status,created_at,updated_at FROM after_sales_requests WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`,values);
    return rows.map(r=>({id:r.id,orderId:r.order_id,orderNumber:r.order_number_snapshot,productName:r.product_name_snapshot,reason:r.reason,status:r.status,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at)}));
  }

  async listFavorites(userId:string, options:{q?:unknown}={}) {
    const q=boundedQuery(options.q); const where=['user_id = ?']; const values:string[]=[userId]; if(q){where.push('(product_name LIKE ? OR product_id LIKE ?)');const like=`%${q}%`;values.push(like,like)}
    const [rows]=await this.pool.execute<FavoriteRow[]>(`SELECT product_id,product_name,product_image_path,price_cents,created_at FROM user_favorites WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`,values);
    return rows.map(r=>({productId:r.product_id,productName:r.product_name,productImagePath:r.product_image_path,priceCents:asInteger(r.price_cents),createdAt:iso(r.created_at)}));
  }

  async listMessages(userId:string, options:{status?:unknown}={}) {
    const status=typeof options.status==='string'&&['all','unread','read'].includes(options.status)?options.status:'all'; const where=['user_id = ?']; if(status==='unread')where.push('read_at IS NULL'); if(status==='read')where.push('read_at IS NOT NULL');
    const [rows]=await this.pool.execute<MessageRow[]>(`SELECT id,category,title,content,read_at,created_at FROM user_messages WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`,[userId]);
    return rows.map(r=>({id:r.id,category:r.category,title:r.title,content:r.content,read:r.read_at!==null,readAt:r.read_at?iso(r.read_at):null,createdAt:iso(r.created_at)}));
  }

  async listCards(userId:string, options:{q?:unknown}={}) {
    const q=boundedQuery(options.q); const where=["d.user_id = ?", "d.delivery_kind = 'card'"]; const values:string[]=[userId];
    if(q){const like=`%${q}%`;if(/^[\x20-\x7E]+$/.test(q)){where.push('(o.order_number LIKE ? OR d.product_name LIKE ?)');values.push(like,like)}else{where.push('d.product_name LIKE ?');values.push(like)}}
    const [rows]=await this.pool.execute<CardRow[]>(`SELECT d.id,d.order_id,o.order_number,d.product_id,d.product_name,d.credential_state,d.created_at FROM order_delivery_items d JOIN orders o ON o.id=d.order_id WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC LIMIT 200`,values);
    return rows.map(r=>({id:r.id,orderId:r.order_id,orderNumber:r.order_number,productId:r.product_id,productName:r.product_name,credentialState:r.credential_state,credentialAvailable:false,createdAt:iso(r.created_at)}));
  }

  async listFootmarks(userId:string) {
    const [rows]=await this.pool.execute<FootmarkRow[]>(`SELECT product_id,product_name,product_image_path,price_cents,viewed_at FROM user_footmarks WHERE user_id=? ORDER BY viewed_at DESC LIMIT 200`,[userId]);
    return rows.map(r=>({productId:r.product_id,productName:r.product_name,productImagePath:r.product_image_path,priceCents:asInteger(r.price_cents),viewedAt:iso(r.viewed_at)}));
  }

  async recordFootmark(userId:string,input:{productId:unknown;productName:unknown;productImagePath?:unknown;priceCents:unknown}) {
    if(typeof input.productId!=='string'||!input.productId.trim()||input.productId.length>64) throw new Error('INVALID_FOOTMARK');
    if(typeof input.productName!=='string'||!input.productName.trim()||input.productName.length>255) throw new Error('INVALID_FOOTMARK');
    const price=Number(input.priceCents); if(!Number.isSafeInteger(price)||price<0||price>100_000_000_000) throw new Error('INVALID_FOOTMARK');
    const image=input.productImagePath==null?null:typeof input.productImagePath==='string'&&input.productImagePath.length<=512?input.productImagePath:null;
    await this.pool.execute(`INSERT INTO user_footmarks (user_id,product_id,product_name,product_image_path,price_cents,viewed_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP(6)) ON DUPLICATE KEY UPDATE product_name=VALUES(product_name),product_image_path=VALUES(product_image_path),price_cents=VALUES(price_cents),viewed_at=UTC_TIMESTAMP(6)`,[userId,input.productId.trim(),input.productName.trim(),image,price]);
  }

  async listPriceLogs(options:{q?:unknown}={}) {
    const q=boundedQuery(options.q); const where:string[]=[]; const values:string[]=[];
    if(q){where.push('(product_name_snapshot LIKE ? OR product_id LIKE ?)');const like=`%${q}%`;values.push(like,like)}
    const clause=where.length?`WHERE ${where.join(' AND ')}`:'';
    const [rows]=await this.pool.execute<PriceLogRow[]>(`SELECT id,product_id,product_name_snapshot,old_price_cents,new_price_cents,status,changed_at FROM product_price_logs ${clause} ORDER BY changed_at DESC LIMIT 200`,values);
    return rows.map(r=>{const oldPriceCents=asInteger(r.old_price_cents),newPriceCents=asInteger(r.new_price_cents);return {id:r.id,productId:r.product_id,productName:r.product_name_snapshot,oldPriceCents,newPriceCents,changeCents:newPriceCents-oldPriceCents,status:r.status,changedAt:iso(r.changed_at)}});
  }

  async adminOrders(options:{q?:unknown;status?:unknown}={}) {
    const q=boundedQuery(options.q); const status=typeof options.status==='string'?options.status.trim():''; const where:string[]=[]; const values:string[]=[];
    if(q){where.push('(o.order_number LIKE ? OR u.username_normalized LIKE ? OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id=o.id AND oi.product_name LIKE ?))');const like=`%${q}%`;values.push(like,like,like)}
    if(['pending_payment','processing','completed','after_sale','cancelled'].includes(status)){where.push('o.status=?');values.push(status)}
    const clause=where.length?`WHERE ${where.join(' AND ')}`:'';
    const [rows]=await this.pool.execute<AdminOrderRow[]>(`SELECT o.id,o.order_number,u.username_normalized,o.status,o.payment_status,o.delivery_status,o.manual_processing_status,o.admin_note,o.total_amount_cents,o.created_at,o.updated_at FROM orders o JOIN users u ON u.id=o.user_id ${clause} ORDER BY o.created_at DESC LIMIT 200`,values);
    return rows.map(r=>({id:r.id,orderNumber:r.order_number,username:r.username_normalized,status:r.status,paymentStatus:r.payment_status,deliveryStatus:r.delivery_status,manualProcessingStatus:r.manual_processing_status,adminNote:r.admin_note,totalAmountCents:asInteger(r.total_amount_cents),createdAt:iso(r.created_at),updatedAt:iso(r.updated_at)}));
  }

  async setAdminOrderManualState(orderId:string,input:{manualStatus:unknown;note:unknown}) {
    if(!['none','reviewing','held'].includes(String(input.manualStatus))) throw new Error('INVALID_MANUAL_STATUS');
    const manualStatus=String(input.manualStatus) as 'none'|'reviewing'|'held';
    const note=typeof input.note==='string'?input.note.trim().slice(0,500):'';
    await this.pool.execute('UPDATE orders SET manual_processing_status=?,admin_note=?,updated_at=UTC_TIMESTAMP(6) WHERE id=?',[manualStatus,note||null,orderId]);
    const [rows]=await this.pool.execute<AdminOrderRow[]>(`SELECT o.id,o.order_number,u.username_normalized,o.status,o.payment_status,o.delivery_status,o.manual_processing_status,o.admin_note,o.total_amount_cents,o.created_at,o.updated_at FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=? LIMIT 1`,[orderId]);
    const r=rows[0]; if(!r)return null;
    return {id:r.id,orderNumber:r.order_number,username:r.username_normalized,status:r.status,paymentStatus:r.payment_status,deliveryStatus:r.delivery_status,manualProcessingStatus:r.manual_processing_status,adminNote:r.admin_note,totalAmountCents:asInteger(r.total_amount_cents),createdAt:iso(r.created_at),updatedAt:iso(r.updated_at)};
  }

  async adminCustomers(options:{q?:unknown;tier?:unknown}={}) {
    const q=boundedQuery(options.q); const tier=typeof options.tier==='string'&&['普通用户','基础版站长'].includes(options.tier)?options.tier:''; const where=["u.role='customer'"];const values:string[]=[];
    if(q){where.push('(u.username_normalized LIKE ? OR COALESCE(p.nickname, u.username_normalized) LIKE ?)');const like=`%${q}%`;values.push(like,like)}
    if(tier){where.push("COALESCE(p.account_tier,'普通用户') = ?");values.push(tier)}
    const [rows]=await this.pool.execute<CustomerRow[]>(`SELECT u.id,u.username_normalized,COALESCE(p.nickname,u.username_normalized) AS nickname,COALESCE(p.account_tier,'普通用户') AS account_tier,u.account_status,u.created_at,COUNT(o.id) AS order_count,COALESCE(SUM(CASE WHEN o.payment_status='paid' AND o.status <> 'cancelled' THEN o.total_amount_cents ELSE 0 END),0) AS total_spend_cents FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id LEFT JOIN orders o ON o.user_id=u.id WHERE ${where.join(' AND ')} GROUP BY u.id,u.username_normalized,p.nickname,p.account_tier,u.account_status,u.created_at ORDER BY u.created_at DESC LIMIT 200`,values);
    return rows.map(r=>({id:r.id,username:r.username_normalized,nickname:r.nickname??r.username_normalized,accountTier:r.account_tier,accountStatus:r.account_status,createdAt:iso(r.created_at),orderCount:asInteger(r.order_count),totalSpendCents:asInteger(r.total_spend_cents)}));
  }
}
function maskContact(kind:'email'|'phone',value:string):string { if(kind==='email'){const at=value.indexOf('@');if(at<=0)return '***';const local=value.slice(0,at);return `${local.slice(0,Math.min(2,local.length))}***${value.slice(at)}`;} if(value.length<=7)return '***';return `${value.slice(0,6)}****${value.slice(-4)}`; }
function maskIp(value:string|null):string { if(!value)return '—'; if(value.includes('.')){const parts=value.split('.');if(parts.length===4){parts[3]='*';return parts.join('.')}} const parts=value.split(':').filter(Boolean);return parts.length?`${parts.slice(0,4).join(':')}:*`:'—'; }
function mapItem(row:ItemRow){return {id:row.id,productId:row.product_id,specId:row.spec_id,productName:row.product_name,specName:row.spec_name,unitPriceCents:asInteger(row.unit_price_cents),deliveryType:row.delivery_type,quantity:asInteger(row.quantity),lineTotalCents:asInteger(row.line_total_cents),productImagePath:row.product_image_path}}
function mapOrder(row:OrderRow,items:ReturnType<typeof mapItem>[]){return {id:row.id,orderNumber:row.order_number,status:row.status,paymentStatus:row.payment_status,deliveryStatus:row.delivery_status,paymentMethod:row.payment_method,totalAmountCents:asInteger(row.total_amount_cents),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),items}}

function isDuplicateEntry(error:unknown):boolean{return typeof error==='object'&&error!==null&&'code' in error&&(error as {code?:unknown}).code==='ER_DUP_ENTRY'}

function mapRecharge(row:RechargeRow){return {id:row.id,rechargeNumber:row.recharge_number,amountCents:asInteger(row.amount_cents),channel:row.channel,status:row.status,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)}}
