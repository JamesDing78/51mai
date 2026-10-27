# 51mai 账号与持久化后端实施方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. 用户已指定 luna-worker 协作。用户已确认推荐方案（2026-10-23），不得把计划视作已实现。

**Goal:** 让现有51mai页面具备真实注册、登录、退出、密码重置、服务端会话和受保护后台，为后续订单及资金数据库化提供基础。

**Architecture:** 保留React/Vite页面，新增同源Express API并由同一Node进程提供生产静态文件；MySQL保存账号、会话、验证码挑战及日志。生产只允许经HTTPS访问；后台角色和所有业务授权在服务端强制检查。后续同步/补单采用数据库任务记录加定时触发，不依赖常驻worker。

**Tech Stack:** Node.js受支持LTS（先读回Hostinger可选版本，再锁定22/24等实际支持版本）、TypeScript、Express、mysql2、Node crypto.scrypt。新增依赖及具体版本在用户确认后查官方文档并锁定；不引入新前端框架、Redis或外部数据库服务。

**Spec:** docs/51mai分站功能1比1任务清单.md；docs/功能矩阵-2026-10-23.md；docs/分类与接入核查-2026-10-23.md。

## Global Constraints

- 唯一根目录：`/Volumes/My Passport/Project/51mai website clone`。
- 域名：`51mai.marginpage.com`。
- 保留当前页面结构和UI风格；功能以参考分站实际启用证据为准。
- 未经明确授权不提交、推送、部署、改变线上配置、迁移生产数据。
- 不在前端、Git、日志或聊天中存储密码、验证码、供货凭据或支付密钥。
- 不用演示登录成功代替服务端认证；没有配置发送渠道时验证码发送必须失败，不回退到固定验证码。
- 本阶段不实施支付、真实采购、卡密获取、佣金规则或生产数据库；后续严格遵循Phase3–11。
- 本轮先修正现有登录和分类原型的字段/行为，不标记Phase2已实现。

## 已验证事实及选型依据

- 现有依赖只有React/Vite及测试工具，没有服务端/数据库/鉴权。后台登录是直接链接。
- 已有104个测试通过基线覆盖的是原型。源码未提交，无HEAD，保护现有文件。
- 用户Hostinger界面显示Business Web Hosting及Node应用、MySQL、SSH、定时任务入口。新应用可用配额和Node版本未读回确认。
- 官方文档说明Business支持Node应用；每请求120秒限制，不支持常驻worker、Redis/Docker等额外服务。故不选择依赖这些能力的队列架构。
- 官方文档说明托管数据库为MySQL；应用连接建议使用127.0.0.1，凭据配置于环境变量。因此不把SQLite文件作为生产数据库。
- 账号注册、手机/邮箱验证码登录、找回密码字段已在隔离未登录会话核实；二维码登录未证实。
- 供货正式文档、支付服务商及短信/邮件发送服务尚未接通；界面与Provider接口可先实现，不能声称外部链路可用。

资料（2026-10-23读取）：
- https://www.hostinger.com/support/hostinger-node-js-limits-for-web-and-cloud-plans/
- https://www.hostinger.com/support/connecting-a-hostinger-mysql-database-to-a-node-js-application/

### 替代方案

PHP/MySQL也可能适配当前主机，但会新增第二种业务语言并重新组织测试；当前没有足以抵消迁移成本的证据。Supabase等外部服务增加供应商和数据管理边界，暂不选用。上述是推荐判断，不是已取得的架构批准。

## Review Focus

- 重启/重新部署后会话仍可验证，注销或冻结后立即失效，不依赖React/localStorage判断权限。
- 恶意Origin、跨站请求及伪造代理头不能绕过鉴权、CSRF或限流。
- 并发注册/验证码消费不会产生重复账号；验证码不能跨用途重放。
- 密码重置后旧会话撤销；账号是否存在不通过重置和登录错误文案泄露。
- 未配置/发送失败的邮件短信不会返回“已发送”，生产不暴露开发验证码。

## 数据边界与API

只增加Phase2所需表，不提前铺设全部资金/商品表：

- users：随机ID、规范化唯一username、密码hash、account状态（active/frozen/disabled）、role（customer/admin）、timestamps；普通注册永远只能创建customer。
- user_contacts：user ID、kind（email/phone）、规范化identifier、verified_at；(kind, identifier)唯一；没有验证不得用于重置密码。
- registration_consents：user_id、terms_version、privacy_version、服务端记录的同意时间；注册和验证码自动注册都需明确同意当前有效协议。
- audit_logs：管理员创建、冻结/解冻、角色变更及会话撤销事件，不含秘密。
- sessions：token_hash、user_id、到期/撤销时间、CSRF绑定信息；不存明文cookie。
- verification_challenges：高熵随机challenge_id摘要、目标HMAC摘要、purpose枚举、code的HMAC摘要、expires_at、失败次数、consumed_at、发送状态、冷却时间。
- auth_rate_limits：HMAC后的限流键、时间窗口、次数；数据库持久化跨重启限流。
- login_logs：用户ID（可空）、成功/失败、时间及受控IP/设备信息，不记录密码或验证码。
- schema_migrations：已应用版本；只通过显式本地命令迁移，不在生产启动时静默改表。

推荐会话：32字节随机不透明token，仅HttpOnly/Secure/SameSite=Lax cookie，生产使用__Host-前缀，Path=/且不设置Domain；数据库保存SHA-256摘要；登录后轮换。默认24小时，记住我7天，退出撤销。匿名注册/登录/验证码请求必须校验固定允许Origin（缺失或不匹配拒绝）；已有会话的状态改变接口还必须校验会话绑定CSRF token，随机生成并在服务端存摘要、登录轮换/撤销时一并失效，常量时间比较；不开放跨域CORS。部署代理信任范围显式设置并测试，不能直接信任所有X-Forwarded-For。

推荐密码：8–20位按参考表单限制；异步scrypt+独立salt，参数和版本编码存储、常量时间比较。具体资源参数在实现时依官方建议与主机内存测量，不使用快速摘要作为密码hash。

接口约定：JSON成功响应{data:...}，错误{error:{code,message}}，禁止返回内部异常原文。

| Method / path | 输入 | 成功结果 | 保护 |
| --- | --- | --- | --- |
| POST /api/auth/register | username,password,confirmPassword,termsVersion,privacyVersion,acceptTerms | 201 + customer会话 | Origin、限流、唯一约束；推荐关系仅后续实现，不擅自赋佣 |
| POST /api/auth/login | identifier,password,remember | 200 +脱敏用户 | 通用失败、限流、冻结校验 |
| POST /api/auth/challenges | identifier,purpose | 202 通用受理提示+随机challengeId（无账户时也返回不可区分的随机ID） | 渠道配置、冷却/次数、发送成功才建立可消费challenge；不泄露账号存在 |
| POST /api/auth/code-login | challengeId,identifier,code,termsVersion?,privacyVersion?,acceptTerms? | 200 +脱敏用户 | 验证成功后才创建/绑定用户；原子消费 |
| POST /api/auth/reset-password | challengeId,identifier,code,password,confirmPassword | 204 | 仅已验证联系方式；原子消费、撤销全部会话 |
| GET /api/auth/session | 无 | 200 {user,csrfToken}或401 | cookie只验证服务端，不返回token |
| POST /api/auth/logout | 无 | 204 | 会话+CSRF，重复调用安全 |
| POST /api/admin/login | identifier,password | 200 +admin会话 | 角色核实，不能从前端赋权 |

Phone/email规范化使用显式规则；不把任意手机号归一化成中国大陆号码。默认仅支持+86手机号（表单明确提示）及规范化邮箱，其他地区需另行确认扩展，不默默误绑定。账号与联系方式的解析不能把未验证username当成可重置联系方式。

推荐人ID字段在前端保留；Phase2不发送给注册API、不保存或声称推荐关系已生效。待Phase5实现后再接入。

短信/邮件采用VerificationSender.send({destination,code,purpose})接口。开发测试使用进程内测试收件箱，仅测试代码可读取，API不返回code；验证码最多存活5分钟、最多5次尝试、同目标/用途发送间隔60秒；新挑战使同目标同用途旧挑战失效。消费时客户端同时提交identifier，服务端重算HMAC与挑战绑定目标常量时间比较，不能从hash逆推出联系方式或只凭challengeId创建新用户。challengeId、用途和目标在服务端绑定，登录消费不能用于重置。发送服务调用不占数据库长事务，发送状态明确pending/sent/failed，只有sent能消费。短验证码、手机号和限流标识使用专用服务端HMAC密钥，密钥不进Git；高熵会话token继续使用SHA-256摘要。

生产配置缺失返回服务不可用，不给客户展示工程提示。渠道选择由用户后台配置和部署前配置步骤完成，不要求聊天粘贴秘密。

## Task 1: MySQL连接、迁移和服务入口

**Files:** Create server/app.ts, server/main.ts, server/db/pool.ts, server/db/migrate.ts, server/db/migrations/001_auth.sql, server/config.ts, server/tsconfig.json, server/db/migrate.test.ts, .env.example；Modify package.json, vite.config.ts。

**Interfaces:** createApp(deps: AppDependencies): Express；createPool(config: DatabaseConfig): Pool；migrate(pool: Pool): Promise<void>。AppDependencies在server/app.ts显式定义，后续auth模块注册到该app，不引入全局测试状态。

- [x] 在独立MySQL测试库验证空库迁移、再次运行无变化、失败不被记为成功；测试库名称必须显式指定并位于测试允许列表，不按名称猜测生产/测试。
- [x] 使用mysql2参数查询、受限连接池、事务、UTC时间及utf8mb4；开发API绑定127.0.0.1，生产PORT由主机提供。
- [x] JSON请求体上限16KB，拒绝错误Content-Type；配置CSP、frame-ancestors、nosniff、Referrer-Policy，HSTS仅HTTPS生产启用；测试超大/错误body和堆栈不泄露。
- [x] /api/*不存在返回JSON404，不能退回SPA HTML；仅非API GET回退index.html，禁止暴露server/.env源码。
- [x] npm脚本区分前端构建、后端编译、显式迁移和同源生产start，开发Vite代理/api；server/tsconfig.json使用NodeNext输出dist-server，ESM导入保留.js，typecheck/build分别检查前后端；后端HTTP测试用node:http监听临时loopback端口+内置fetch，不新增supertest；原前端脚本保持兼容。
- [x] MySQL DDL可能隐式提交，不承诺事务回滚：迁移采用advisory lock、文件checksum、逐步记录；失败禁止自动重试未知DDL状态，检查已应用步骤后显式修复，生产须备份恢复预案。使用真实MySQL完成迁移/恢复方案验证；没有本地MySQL时明确报告，不用SQLite测试替代证明。

## Task 2: 密码、会话与安全边界

**Files:** Create server/auth/password.ts, server/auth/sessions.ts, server/auth/guards.ts, server/auth/rate-limit.ts, server/auth/security.test.ts。

**Interfaces:** hashPassword(password:string):Promise<string>；verifyPassword(password:string,encoded:string):Promise<boolean>；requireSession与requireAdmin为Express中间件，验证结果写入显式request类型。

- [x] 测试错误密码、畸形hash、不同salt、会话过期/撤销/冻结/重启、customer访问admin为403、匿名401。
- [x] 实现会话cookie、CSRF、固定Origin校验和代理信任设置；测试恶意Origin/CSRF/转发头、cookie属性、撤销后拒绝访问。
- [x] 数据库限流覆盖账号和请求来源；失败日志不包含秘密；不存在账号仍执行等成本dummy scrypt验证；测试并发请求和进程重启不重置限制。

## Task 3: 注册、登录、验证码及重置

**Files:** Create server/auth/routes.ts, server/auth/service.ts, server/auth/verification.ts, server/auth/sender.ts, server/auth/routes.test.ts, server/auth/verification.test.ts, server/scripts/create-admin.ts。

**Interfaces:** registerAuth(app,deps):void；VerificationSender.send(input):Promise<void>。只在显式本地交互命令创建首个管理员，普通注册拒绝role等额外授权字段。注册同意时间由服务端记录，校验当前协议版本和acceptTerms=true，不信任客户端时间。

- [x] 测试重复/并发注册、冻结账号、冻结/密码重置与会话撤销事务一致、错误密码通用反馈、登录后轮换cookie、退出重放失败。
- [x] 测试验证码过期/错误次数/冷却/跨用途/并发消费/发送失败/生产缺配置；确认API与日志无验证码。
- [x] 测试注册/验证码自动注册缺协议同意被拒绝；测试账号密码注册后无已验证联系方式不能走重置；验证码登录只按验证后的联系方式查找/创建，不按同名username自动合并。
- [x] 测试重置后所有旧会话失效；账号存在/不存在的请求返回格式一致。
- [x] 首管理员命令通过终端隐藏输入或本地配置读取秘密，不写默认密码或打印密码；执行生产命令需要另行批准。

## Task 4: 接入现有页面与路由

**Files:** Create src/auth/AuthProvider.tsx, src/auth/RequireAuth.tsx, src/auth/client.ts, src/auth/auth.test.tsx；Modify src/App.tsx, src/pages/LoginPage.tsx, src/admin/AdminPages.tsx。

**Interfaces:** useAuth():{user,status,refresh,logout}；RequireAuth({role?,children})；client统一携带cookie和CSRF，401清理状态。服务端始终是权限真源。

- [x] 先测试匿名访问/ucenter、/orders、/checkout、/admin跳转；/admin/login例外；已登录customer无权进入管理页。
- [x] 登录成功返回站内安全路径；拒绝//evil、https://evil等跳转地址；刷新从session恢复，退出后页面与服务端同时失效。
- [x] 替换登录/注册/找回/验证码提示为真实API结果，阻止重复提交；错误可访问，保留现有视觉样式。
- [x] 测试受保护页面加载期间不闪出其他用户/静态管理员数据。现有用户中心业务假数据在后续Phase3替换，本阶段不称全站数据库化。

## Task 5: 验收与交接

- [ ] npm test -- --run；npm run typecheck；npm run build，报告测试文件数/通过/失败和构建结果。
- [ ] 真实MySQL集成测试覆盖重启、唯一约束、事务、验证码并发与会话撤销；浏览器验证注册→退出→登录→刷新→退出链路。
- [ ] 独立审查鉴权/日志/CSRF/密码/角色边界并修复发现；更新功能矩阵，不将发送渠道未接通项标已验收。登录日志默认保留30天，设备仅保留受限长度User-Agent，不额外采集设备指纹；仅管理员可读，通过显式定时清理任务处理。
- [ ] 不提交或部署，交付本地可运行版本和明确剩余项。部署/迁移生产/正式收款仍需用户确认。

## 后续阶段（本方案不实施）

Phase3用户与订单持久化→Phase4充值/提现/流水→Phase5已确认分销规则→Phase6卡密/交付→Phase7消息/收藏/售后/调价→Phase8后台数据→Phase9上游Provider→Phase10支付Provider→Phase11全链路验收。订单金额用整数分，服务端重新报价；支付验签/金额校验/幂等及上游采购未知状态先查单是后续方案必需项。

## 当前待确认和不确定项

- 用户已确认Node.js/Express + MySQL、本地先实现后部署的方案；不授权生产部署或DNS修改。
- Oracle浏览器复核本轮页面停留加载状态，尚无Oracle审查结论；luna-worker已完成本地独立方案审查并纳入challengeId、协议同意、CSRF、并发消费和MySQL DDL恢复等修正；不得记作通过。不改用付费API。可先进行本地独立方案审查作为补充，结果仅为建议。
- 生产可选Node版本/新应用配额、真实MySQL接入、短信/邮件服务商、上游协议和支付渠道待核实；这些不能由假数据通过的测试替代。


### 审查取舍

本地独立审查已完成（仅方案，未执行安全测试）。不将审查建议自动扩成新业务需求：MFA未有参考启用证据，本阶段不新增；管理员敏感资金操作的二次确认仍按任务清单后续实施，并在正式收款前复核安全方案。生产认证上线不得保留静态假客户/假订单作为真实数据，需完成相应Phase3–11验收。

## 本地实施记录（2026-10-23）
Task1–3实现及独立审查完成；父代理12:19真实MySQL后端5文件46项全通过。Task4实现中。Code-login统一要求当前协议同意以避免存在性枚举，成功消费与业务同事务、失败次数独立持久化。Hostinger资源预算与真实短信/邮件未验证，不属于本地通过结论。完整日志保留runtime/development/account-backend/progress.md，禁止未经授权提交/部署。
