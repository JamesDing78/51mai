import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { getPolicies, returnToFromSearch, type AuthPolicies } from '../auth/client';

const termsSections = [
  ['服务范围', '本站提供数字资源商品展示、账号认证和订单入口。具体商品信息以商品页展示为准，购买前请核对商品名称、规格、数量和价格。'],
  ['账号使用', '注册账号时请提供真实、可用的账号信息并妥善保管密码。普通注册账号的角色为客户，管理员权限不会由前台注册获得。'],
  ['交易提示', '商品、规格、库存和交付状态以本站当前可见信息及后续订单页面为准；支付、采购、自动交付和售后规则将在对应功能真实接入后另行说明。'],
];

const privacySections = [
  ['我们处理的信息', '本站为提供账号服务会处理用户名、经验证的手机号或邮箱、会话信息、登录安全日志以及注册时记录的协议版本和同意时间。密码只以服务端安全摘要保存。'],
  ['使用目的', '上述信息用于注册、登录、验证码验证、密码重置、会话安全和管理员权限检查。我们不在浏览器本地存储密码、验证码或会话令牌。'],
  ['你的操作', '你可以通过本站登录、退出和密码重置功能管理账号。商品购买前请自行核对商品信息；其他数据访问、导出或删除能力需在相应功能完成后再提供。'],
];

export default function NewLegalPage() {
  const location = useLocation();
  const isPrivacy = location.pathname === '/privacy';
  const [policies, setPolicies] = useState<AuthPolicies | null>(null);
  const [failed, setFailed] = useState(false);

  const load = () => {
    setFailed(false);
    void getPolicies().then(setPolicies).catch(() => setFailed(true));
  };

  useEffect(() => {
    load();
  }, []);

  const returnTo = returnToFromSearch(location.search, '/ucenter');
  const backHref = location.search.includes('returnTo=') ? `/login?returnTo=${encodeURIComponent(returnTo)}` : '/login';
  const title = isPrivacy ? '隐私政策' : '用户协议';
  const version = isPrivacy ? policies?.privacyVersion : policies?.termsVersion;
  const sections = isPrivacy ? privacySections : termsSections;

  return <main className="auth-page shell page-space">
    <section className="auth-card">
      <div className="auth-form-panel legal-page">
        <Link className="brand" to="/"><span>51</span>mai</Link>
        <h1>{title}</h1>
        {failed && <div className="auth-feedback error" role="alert">协议暂时无法加载，请稍后重试。<button className="text-button" type="button" onClick={load}>重试</button></div>}
        {!failed && !policies && <p role="status" aria-live="polite">正在加载协议…</p>}
        {!failed && policies && <>
          <p className="auth-help">当前版本：{version}</p>
          {sections.map(([heading, text]) => <section key={heading}><h2>{heading}</h2><p>{text}</p></section>)}
        </>}
        <Link className="text-button" to={backHref}>返回登录</Link>
      </div>
    </section>
  </main>;
}
