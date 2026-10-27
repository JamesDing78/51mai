import type { Pool } from 'mysql2/promise';
import { categories, products } from '../../src/data.js';
import { referenceCatalogDrafts } from './reference-drafts.js';

const categoryIds=new Map<string,string>(categories.filter(([name])=>name!=='全部分类').map(([name],index)=>[String(name),`local-cat-${String(index+1).padStart(2,'0')}`]));
const safePlaceholder='/products/51mai-placeholder.svg';
const unsafeSourceImages=['/products/source-001.png','/products/source-002.png','/products/source-003.png','/products/source-004.png','/products/source-013.png','/products/source-036.png'];

export async function ensureLocalCatalogSeeded(pool:Pool):Promise<void>{
  const connection=await pool.getConnection();
  let locked=false;
  try{
    const [lockRows]=await connection.query<any[]>("SELECT GET_LOCK('51mai-local-catalog-seed',10) AS acquired");
    locked=Number(lockRows[0]?.acquired)===1;if(!locked)throw new Error('LOCAL_CATALOG_SEED_LOCK_TIMEOUT');
    const [again]=await connection.query<any[]>('SELECT COUNT(*) AS total FROM local_products');
    await connection.beginTransaction();
    if(Number(again[0]?.total)===0){
      let sort=0;
      for(const [name,icon] of categories){if(name==='全部分类')continue;const id=categoryIds.get(name)!;await connection.execute('INSERT INTO local_categories (id,name,icon,sort_order,status) VALUES (?,?,?,?,\'active\')',[id,name,icon,++sort])}
      for(const product of products){
        await connection.execute('INSERT INTO local_products (id,name,description,image_path,icon,market_price_cents,delivery_type,status) VALUES (?,?,?,?,?,?,?,\'active\')',[product.id,product.name,product.description,product.image,product.icon,product.marketPrice===undefined?null:Math.round(product.marketPrice*100),product.deliveryType]);
        let categorySort=0;for(const name of product.categories){const categoryId=categoryIds.get(name);if(categoryId)await connection.execute('INSERT INTO local_product_categories (product_id,category_id,sort_order) VALUES (?,?,?)',[product.id,categoryId,++categorySort])}
        for(const [index,spec] of product.specs.entries()){
          await connection.execute('INSERT INTO local_product_specs (id,product_id,name,partner_cost_cents,price_cents,status,sort_order) VALUES (?,?,?,?,?,\'active\',?)',[spec.id,product.id,spec.name,Math.round(spec.partnerCost*100),Math.round(product.price*100),index+1]);
          await connection.execute('INSERT INTO local_product_inventory (product_id,spec_id,available_quantity) VALUES (?,?,?) ON DUPLICATE KEY UPDATE product_id=VALUES(product_id)',[product.id,spec.id,Math.max(0,Math.floor(spec.stock))]);
        }
      }
    }
    for(const draft of referenceCatalogDrafts){
      const [found]=await connection.execute<any[]>('SELECT id FROM local_products WHERE id=? OR name=? LIMIT 1',[draft.id,draft.name]);
      if(found[0])continue;
      const specId=`${draft.id}-s1`;
      await connection.execute("INSERT INTO local_products (id,name,description,image_path,icon,market_price_cents,delivery_type,status) VALUES (?,?,?,NULL,?,NULL,'content','inactive')",[draft.id,draft.name,'待补充本站成本、售价、库存、交付方式、说明和图片，审核完成后方可上架。',draft.name.slice(0,1)]);
      await connection.execute("INSERT INTO local_product_specs (id,product_id,name,partner_cost_cents,price_cents,status,sort_order) VALUES (?,?, '待补资料',0,0,'inactive',1)",[specId,draft.id]);
      await connection.execute('INSERT INTO local_product_inventory (product_id,spec_id,available_quantity) VALUES (?,?,0)',[draft.id,specId]);
    }
    await connection.query(`UPDATE local_products SET image_path=? WHERE image_path IN (${unsafeSourceImages.map(()=>'?').join(',')})`,[safePlaceholder,...unsafeSourceImages]);
    await connection.commit();
  }catch(error){await connection.rollback().catch(()=>undefined);throw error}finally{if(locked)await connection.query("SELECT RELEASE_LOCK('51mai-local-catalog-seed')").catch(()=>undefined);connection.release()}
}
