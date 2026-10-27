# 51mai Phase 4 财务与充值持久化实施计划

**Goal:** 将参考站已确认的三类余额、资金/佣金/充值明细和充值申请从静态/localStorage改为真实MySQL状态，同时不伪造支付成功。

**Spec:** docs/功能矩阵-2026-10-23.md

## Global Constraints
- 仅复制当前参考站已观察到的功能和字段。
- 金额全部使用整数分。
- 充值创建只生成待支付订单；未接真实支付宝/加款卡Provider时不增加余额、不生成虚假支付结果。
- 提现方式/真实姓名/打款流程因提交规则与敏感数据安全尚未验证，本小阶段不擅自实现写入。
- 不部署、不推送、不迁移生产数据。

## Task 1 Schema
- [x] RED: 真实MySQL测试要求 account_balances/account_transactions/recharge_orders。
- [x] GREEN: 新增 003_finance.sql，现有用户补零余额行。

## Task 2 API
- [x] RED: 当前用户余额/流水/充值记录隔离；创建充值订单保持余额不变；CSRF保护。
- [x] GREEN: GET /api/finance/summary, GET /api/finance/transactions, GET/POST /api/recharges。

## Task 3 Frontend
- [x] RED: 财务页和充值页不再显示假金额/假已完成记录。
- [x] GREEN: UserFinance/UserRecharge接真实API；三类余额从数据库读取；充值创建待支付记录并显示支付渠道尚未接通。

## Task 4 Verification
- [x] 前端全量、真实MySQL后端全量、typecheck、build、hygiene。
- [x] 更新矩阵和交接报告；不标记提现/支付Provider已完成。
