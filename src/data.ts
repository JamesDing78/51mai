export type ReviewStatus = 'approved' | 'pending' | 'blocked';
export type SyncStatus = 'synced' | 'failed' | 'pending';
export type SaleMode = 'cost_plus' | 'fixed';
export type ProductSpec = { id:string; name:string; upstreamSpecId:string; partnerCost:number; stock:number };
export type Product = { id:string; upstreamProductId:string; upstreamCategoryId:string; name:string; category:string; categories:string[]; description:string; partnerCost:number; price:number; marketPrice?:number; stock:number; reviewStatus:ReviewStatus; syncStatus:SyncStatus; saleMode:SaleMode; sourceStatus:'enabled'|'disabled'; deliveryType:'card'|'content'; brandIsolationStatus:'passed'|'pending'|'blocked'; lastSyncedAt:string; specs:ProductSpec[]; badge?:string; icon:string; image:string };
export const DEFAULT_MARKUP=1.25;
export function calculateSalePrice(partnerCost:number,multiplier=DEFAULT_MARKUP){return Math.round((partnerCost*multiplier+Number.EPSILON)*100)/100}
export const categories=[
  ["全部分类","全"],
  ["AI产品系列","AI"],
  ["搭建同款-赠送货源","搭"],
  ["搭建后立送 无限拿码","码"],
  ["获客系列","获"],
  ["数字人直播系列","数"],
  ["OEM贴牌系列","牌"],
  ["独立后台系列","后"],
  ["测试卡系列","测"],
  ["腾讯广告投放系统","广"],
  ["粉丝系列","粉"],
  ["后台充值类","充"],
  ["OEM贴牌供应","供"],
  ["海外营销","海"],
  ["AI超级员工系列","员"],
  ["数字人免费系列","免"],
  ["渠道变现助手","渠"],
  ["手机直播带货","播"],
] as const;
const raw=[
  ["p-001", "UP-001", "CAT-02", "合伙人权益-赠送同款货源站", "搭建同款-赠送货源", ["搭建同款-赠送货源", "搭建后立送 无限拿码"], "合伙人权益-赠送同款货源站。", 558.4, 698.0, 100, "合", "approved", "synced", "passed", "content", "/products/51mai-placeholder.svg"],
  ["p-002", "UP-002", "CAT-17", "手机直播【开户】", "手机直播带货", ["手机直播带货"], "手机直播【开户】。", 99.0, 199.0, 100, "手", "approved", "synced", "passed", "content", "/products/51mai-placeholder.svg"],
  ["p-003", "UP-003", "CAT-17", "手机直播【无限开】", "手机直播带货", ["手机直播带货"], "手机直播【无限开】。", 794.0, 1599.0, 100, "手", "approved", "synced", "passed", "card", "/products/51mai-placeholder.svg"],
  ["p-004", "UP-004", "CAT-17", "980套餐包含100小时", "手机直播带货", ["手机直播带货"], "980套餐包含100小时。", 300.0, 980.0, 100, "9", "approved", "synced", "passed", "content", "/products/51mai-placeholder.svg"],
  ["p-005", "UP-005", "CAT-01", "雷帝AI数字人直播年卡", "AI产品系列", ["AI产品系列", "数字人直播系列"], "雷帝AI数字人直播年卡。", 199.0, 1980.0, 100, "雷", "approved", "synced", "passed", "card", "/products/source-005.png"],
  ["p-006", "UP-006", "CAT-05", "雷帝AI数字人直播测试卡", "数字人直播系列", ["数字人直播系列", "测试卡系列"], "雷帝AI数字人直播测试卡。", 3.0, 9.9, 100, "雷", "approved", "synced", "passed", "card", "/products/source-006.png"],
  ["p-007", "UP-007", "CAT-01", "专业版双数字人直播系统测试卡【升级合伙人无限0元提卡正版授权】", "AI产品系列", ["AI产品系列", "测试卡系列"], "专业版双数字人直播系统测试卡【升级合伙人无限0元提卡正版授权】。", 7.92, 9.9, 100, "专", "approved", "synced", "passed", "card", "/products/source-007.png"],
  ["p-008", "UP-008", "CAT-00", "青龙聚合AI【通用额度】", "全部分类", [], "青龙聚合AI【通用额度】。", 100.0, 599.0, 100, "青", "approved", "synced", "passed", "card", "/products/source-008.png"],
  ["p-009", "UP-009", "CAT-00", "青龙聚合AI代理后台", "全部分类", [], "青龙聚合AI代理后台。", 100.0, 1599.0, 100, "青", "approved", "synced", "passed", "content", "/products/source-009.png"],
  ["p-010", "UP-010", "CAT-08", "青龙聚合AI【测试卡】", "测试卡系列", ["测试卡系列"], "青龙聚合AI【测试卡】。", 3.0, 9.9, 100, "青", "approved", "synced", "passed", "card", "/products/source-010.png"],
  ["p-011", "UP-011", "CAT-05", "雷帝AI数字人直播月卡", "数字人直播系列", ["数字人直播系列"], "雷帝AI数字人直播月卡。", 99.0, 298.0, 100, "雷", "approved", "synced", "passed", "card", "/products/source-011.png"],
  ["p-012", "UP-012", "CAT-03", "某音采集 【无限卡密版】", "搭建后立送 无限拿码", ["搭建后立送 无限拿码"], "某音采集 【无限卡密版】。", 558.4, 698.0, 100, "某", "approved", "synced", "passed", "card", "/products/source-012.png"],
  ["p-013", "UP-013", "CAT-16", "渠道变现助手", "渠道变现助手", ["渠道变现助手"], "渠道变现助手。", 558.4, 698.0, 100, "渠", "approved", "synced", "passed", "content", "/products/51mai-placeholder.svg"],
  ["p-014", "UP-014", "CAT-15", "数字人手机版【无限生成】", "数字人免费系列", ["数字人免费系列"], "数字人手机版【无限生成】。", 558.4, 698.0, 100, "数", "approved", "synced", "passed", "content", "/products/source-014.png"],
  ["p-015", "UP-015", "CAT-14", "AI超级员工【终端采购】", "AI超级员工系列", ["AI超级员工系列"], "AI超级员工【终端采购】。", 99.0, 1980.0, 100, "A", "approved", "synced", "passed", "content", "/products/source-015.png"],
  ["p-016", "UP-016", "CAT-01", "升级合伙人赠送-数字人直播共享年卡3张", "AI产品系列", ["AI产品系列", "搭建后立送 无限拿码"], "升级合伙人赠送-数字人直播共享年卡3张。", 558.4, 698.0, 100, "升", "approved", "synced", "passed", "card", "/products/source-016.webp"],
  ["p-017", "UP-017", "CAT-03", "龙虾获客【年卡】", "搭建后立送 无限拿码", ["搭建后立送 无限拿码"], "龙虾获客【年卡】。", 150.4, 188.0, 100, "龙", "approved", "synced", "passed", "card", "/products/source-017.jpg"],
  ["p-018", "UP-018", "CAT-03", "红薯全场景自动回复-合伙人无限拿码赠送后台", "搭建后立送 无限拿码", ["搭建后立送 无限拿码"], "红薯全场景自动回复-合伙人无限拿码赠送后台。", 159.2, 199.0, 100, "红", "approved", "synced", "passed", "content", "/products/source-018.jpg"],
  ["p-019", "UP-019", "CAT-03", "合伙人手机开卡后台", "搭建后立送 无限拿码", ["搭建后立送 无限拿码"], "合伙人手机开卡后台。", 558.4, 698.0, 100, "合", "approved", "synced", "passed", "card", "/products/source-019.jpg"],
  ["p-020", "UP-020", "CAT-03", "暴力获客-【升级合伙人无限0元提卡+后台无限开卡版】", "搭建后立送 无限拿码", ["搭建后立送 无限拿码"], "暴力获客-【升级合伙人无限0元提卡+后台无限开卡版】。", 159.2, 199.0, 100, "暴", "approved", "synced", "passed", "card", "/products/source-020.jpg"],
  ["p-021", "UP-021", "CAT-03", "速客通后台无限开卡版 【升级合伙人无限0元提卡+后台无限开卡】", "搭建后立送 无限拿码", ["搭建后立送 无限拿码"], "速客通后台无限开卡版 【升级合伙人无限0元提卡+后台无限开卡】。", 159.2, 199.0, 100, "速", "approved", "synced", "passed", "card", "/products/source-021.jpg"],
  ["p-022", "UP-022", "CAT-03", "某音采集 天卡", "搭建后立送 无限拿码", ["搭建后立送 无限拿码"], "某音采集 天卡。", 0.0, 0.0, 100, "某", "approved", "synced", "passed", "card", "/products/source-022.png"],
  ["p-023", "UP-023", "CAT-04", "DY综合截流系统永久卡【正版授权】", "获客系列", ["获客系列"], "DY综合截流系统永久卡【正版授权】。", 70.0, 299.0, 100, "D", "approved", "synced", "passed", "card", "/products/source-023.jpg"],
  ["p-024", "UP-024", "CAT-06", "本地版矩阵系统【贴牌授权商】", "OEM贴牌系列", ["OEM贴牌系列", "OEM贴牌供应"], "本地版矩阵系统【贴牌授权商】。", 3000.0, 4980.0, 100, "本", "approved", "synced", "passed", "content", "/products/source-024.png"],
  ["p-025", "UP-025", "CAT-07", "GEO企业推广系统独立后台", "独立后台系列", ["独立后台系列"], "GEO企业推广系统独立后台。", 299.0, 1698.0, 100, "G", "approved", "synced", "passed", "content", "/products/source-025.jpg"],
  ["p-026", "UP-026", "CAT-07", "GEO独立后台充值专用", "独立后台系列", ["独立后台系列"], "GEO独立后台充值专用。", 80.0, 100.0, 100, "G", "approved", "synced", "passed", "card", "/products/source-026.png"],
  ["p-027", "UP-027", "CAT-07", "GEO企业推广系统【贴牌授权商】", "独立后台系列", ["独立后台系列", "OEM贴牌供应"], "GEO企业推广系统【贴牌授权商】。", 1000.0, 2980.0, 100, "G", "approved", "synced", "passed", "content", "/products/source-027.png"],
  ["p-028", "UP-028", "CAT-08", "一站式电商工作台【测试卡30张图片】", "测试卡系列", ["测试卡系列"], "一站式电商工作台【测试卡30张图片】。", 9.9, 29.9, 100, "一", "approved", "synced", "passed", "card", "/products/source-028.png"],
  ["p-029", "UP-029", "CAT-08", "全平台翘客测试卡", "测试卡系列", ["测试卡系列"], "全平台翘客测试卡。", 3.0, 9.9, 100, "全", "approved", "synced", "passed", "card", "/products/source-029.jpg"],
  ["p-030", "UP-030", "CAT-08", "全驱数字人测试卡", "测试卡系列", ["测试卡系列"], "全驱数字人测试卡。", 9.9, 29.9, 100, "全", "approved", "synced", "passed", "card", "/products/source-030.png"],
  ["p-031", "UP-031", "CAT-08", "本地版矩阵系统测试卡", "测试卡系列", ["测试卡系列"], "本地版矩阵系统测试卡。", 0.8, 1.0, 100, "本", "approved", "synced", "passed", "card", "/products/source-031.png"],
  ["p-032", "UP-032", "CAT-08", "抖音综合工具天卡", "测试卡系列", ["测试卡系列"], "抖音综合工具天卡。", 3.5, 9.5, 100, "抖", "approved", "synced", "passed", "card", "/products/source-032.jpg"],
  ["p-033", "UP-033", "CAT-09", "腾讯广告投放系统贴牌定金【正版授权】", "腾讯广告投放系统", ["腾讯广告投放系统", "OEM贴牌供应"], "腾讯广告投放系统贴牌定金【正版授权】。", 99.0, 200.0, 100, "腾", "approved", "synced", "passed", "content", "/products/source-033.png"],
  ["p-034", "UP-034", "CAT-10", "不开播1000包500有效", "粉丝系列", ["粉丝系列"], "不开播1000包500有效。", 280.0, 480.0, 100, "不", "approved", "synced", "passed", "content", "/products/source-034.jpg"],
  ["p-035", "UP-035", "CAT-11", "青龙聚合AI后台充值【充值多少购买多少】", "后台充值类", ["后台充值类"], "青龙聚合AI后台充值【充值多少购买多少】。", 80.0, 100.0, 100, "青", "approved", "synced", "passed", "card", "/products/source-035.png"],
  ["p-036", "UP-036", "CAT-12", "Agent超级员工贴牌定金", "OEM贴牌供应", ["OEM贴牌供应"], "Agent超级员工贴牌定金。", 79.2, 99.0, 100, "A", "approved", "synced", "passed", "content", "/products/51mai-placeholder.svg"],
  ["p-037", "UP-037", "CAT-12", "综合工具全套贴牌OEM【正版授权】", "OEM贴牌供应", ["OEM贴牌供应"], "综合工具全套贴牌OEM【正版授权】。", 500.0, 800.0, 100, "综", "approved", "synced", "passed", "content", "/products/source-037.jpg"],
  ["p-038", "UP-038", "CAT-13", "海外GEO开户", "海外营销", ["海外营销"], "海外GEO开户。", 100.0, 1980.0, 100, "海", "approved", "synced", "passed", "content", "/products/source-038.png"],
  ["p-039", "UP-039", "CAT-13", "海外GEO贴牌充值专用", "海外营销", ["海外营销"], "海外GEO贴牌充值专用。", 100.0, 2980.0, 100, "海", "approved", "synced", "passed", "card", "/products/source-039.png"],
  ["p-040", "UP-040", "CAT-14", "AI超级员工【终端无限开】", "AI超级员工系列", ["AI超级员工系列"], "AI超级员工【终端无限开】。", 1599.0, 19800.0, 100, "A", "approved", "synced", "passed", "card", "/products/source-040.png"],
  ["p-041", "UP-041", "CAT-14", "AI超级员工【充值算力】", "AI超级员工系列", ["AI超级员工系列"], "AI超级员工【充值算力】。", 100.0, 698.0, 100, "A", "approved", "synced", "passed", "card", "/products/source-041.png"],
] as const;
export const products:Product[]=raw.map(([id,upstreamProductId,upstreamCategoryId,name,category,productCategories,description,partnerCost,marketPrice,stock,icon,reviewStatus,syncStatus,brandIsolationStatus,deliveryType,image])=>({
 id,upstreamProductId,upstreamCategoryId,name,category,categories:[...productCategories],description,partnerCost,marketPrice,price:calculateSalePrice(partnerCost),stock,icon,image,reviewStatus,syncStatus,brandIsolationStatus,deliveryType,saleMode:'cost_plus',sourceStatus:'enabled',lastSyncedAt:'2026-10-23 08:00',specs:[{id:`${id}-s1`,name:'默认规格',upstreamSpecId:`${upstreamProductId}-S1`,partnerCost,stock}]
}));
