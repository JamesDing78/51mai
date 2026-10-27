import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, codeLogin, getPolicies, login, loginRedirect, register, requestChallenge, resetPassword, returnToFromSearch, type AuthPolicies } from '../auth/client';
import { useAuth } from '../auth/AuthProvider';

type View = 'login' | 'register' | 'reset';
type LoginMode = 'password' | 'code';
type SubmitMode = 'login' | 'register' | 'reset' | null;
type ErrorOperation = SubmitMode | 'code-login' | 'challenge' | 'policy';

const passwordRule = '密码长度为 8–20 位';

function isValidPassword(value: string) {
  const length = Array.from(value).length;
  return length >= 8 && length <= 20;
}

function isSixDigitCode(value: string) {
  return /^\d{6}$/.test(value);
}

function isPhoneOrEmail(value: string) {
  const trimmed = value.trim();
  const email = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(trimmed);
  const phone = /^(?:\+86)?1[3-9]\d{9}$/.test(trimmed);
  return email || phone;
}

function isValidUsername(value: string) {
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  const length = Array.from(normalized).length;
  return length >= 1 && length <= 64 && !/[\p{Cc}\p{White_Space}]/u.test(normalized) && !normalized.includes('@') && !/^(?:\+?86)?1[3-9]\d{9}$/.test(normalized);
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function errorMessage(error: unknown, operation: ErrorOperation): string {
  if (!(error instanceof ApiError)) {
    return operation === 'challenge' ? '验证码服务暂不可用，请稍后重试。' : '操作失败，请稍后重试。';
  }
  if (operation === 'policy') return '协议版本暂时无法获取，请稍后重试。';
  if (operation === 'challenge') {
    if (error.code === 'SERVICE_UNAVAILABLE' || error.status === 503 || error.isNetwork) return '验证码服务暂不可用，请稍后重试。';
    if (error.code === 'VERIFICATION_COOLDOWN' || error.code === 'RATE_LIMITED') {
      return error.retryAfterSeconds ? `操作过于频繁，请 ${Math.ceil(error.retryAfterSeconds)} 秒后重试。` : '操作过于频繁，请稍后重试。';
    }
    if (error.code === 'INVALID_IDENTIFIER') return '请输入有效的手机号或邮箱';
    return '验证码服务暂不可用，请稍后重试。';
  }
  if (error.code === 'AUTHENTICATION_FAILED') return operation === 'login' ? '账号或密码不正确' : '验证码错误或已失效，请重新获取';
  if (error.code === 'VERIFICATION_INVALID') return '验证码错误或已失效，请重新获取';
  if (error.code === 'CONSENT_REQUIRED') return '请先阅读并同意用户协议和隐私政策';
  if (error.code === 'USERNAME_TAKEN') return '该账号已注册，请更换账号';
  if (error.code === 'PASSWORD_LENGTH') return passwordRule;
  if (error.code === 'PASSWORD_MISMATCH') return '两次输入的密码不一致';
  if (error.code === 'INVALID_IDENTIFIER') return operation === 'register' ? '请输入有效的账号' : '请输入有效的手机号或邮箱';
  if (error.code === 'RATE_LIMITED') return error.retryAfterSeconds ? `操作过于频繁，请 ${Math.ceil(error.retryAfterSeconds)} 秒后重试。` : '操作过于频繁，请稍后重试。';
  if (error.isNetwork || error.status === 503) return operation === 'reset' ? '暂时无法重置密码，请稍后重试。' : operation === 'register' ? '暂时无法注册，请稍后重试。' : '暂时无法登录，请稍后重试。';
  return '操作失败，请稍后重试。';
}

function linkWithReturnTo(path: string, returnTo: string) {
  return `${path}?returnTo=${encodeURIComponent(returnTo)}`;
}

export default function LoginPage() {
  const { status, user, setSession } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [view, setView] = useState<View>('login');
  const [loginMode, setLoginMode] = useState<LoginMode>('password');
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [referrerId, setReferrerId] = useState('');
  const [remember, setRemember] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [submitMode, setSubmitMode] = useState<SubmitMode>(null);
  const [challengeBusy, setChallengeBusy] = useState(false);
  const [challengeId, setChallengeId] = useState('');
  const [challengePurpose, setChallengePurpose] = useState<'code_login' | 'reset_password' | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [cooldownNow, setCooldownNow] = useState(Date.now());
  const [policies, setPolicies] = useState<AuthPolicies | null>(null);
  const [policyState, setPolicyState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  const challengeGeneration = useRef(0);
  const challengeController = useRef<AbortController | null>(null);
  const policyController = useRef<AbortController | null>(null);
  const policyPromise = useRef<Promise<AuthPolicies> | null>(null);
  const returnTo = returnToFromSearch(location.search, '/ucenter');

  const invalidateChallenge = useCallback(() => {
    challengeGeneration.current += 1;
    challengeController.current?.abort();
    challengeController.current = null;
    setChallengeBusy(false);
    setChallengeId('');
    setChallengePurpose(null);
    setCode('');
    setCooldownUntil(null);
  }, []);

  const openView = (nextView: View) => {
    invalidateChallenge();
    setView(nextView);
    setErrors([]);
    setNotice('');
    setAcceptTerms(false);
  };

  const switchLoginMode = (nextMode: LoginMode) => {
    invalidateChallenge();
    setLoginMode(nextMode);
    setErrors([]);
    setNotice('');
    setAcceptTerms(false);
  };

  const updateAccount = (value: string) => {
    if (value !== account) invalidateChallenge();
    setAccount(value);
    setErrors([]);
    setNotice('');
  };

  const loadPolicies = useCallback(async (): Promise<AuthPolicies> => {
    if (policies) return policies;
    if (policyPromise.current) return policyPromise.current;
    const controller = new AbortController();
    policyController.current = controller;
    setPolicyState('loading');
    const pending = getPolicies(controller.signal)
      .then((result) => {
        if (!result.termsVersion || !result.privacyVersion || !result.termsUrl || !result.privacyUrl) throw new Error('Invalid policy response');
        setPolicies(result);
        setPolicyState('ready');
        return result;
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) setPolicyState('error');
        throw error;
      })
      .finally(() => {
        if (policyPromise.current === pending) policyPromise.current = null;
        if (policyController.current === controller) policyController.current = null;
      });
    policyPromise.current = pending;
    return pending;
  }, [policies]);

  useEffect(() => {
    const needsPolicies = view === 'register' || (view === 'login' && loginMode === 'code');
    if (needsPolicies && !policies) void loadPolicies().catch(() => undefined);
  }, [loadPolicies, loginMode, policies, view]);

  useEffect(() => {
    if (!cooldownUntil) return undefined;
    const timer = window.setInterval(() => setCooldownNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  useEffect(() => () => {
    challengeController.current?.abort();
    policyController.current?.abort();
  }, []);

  useEffect(() => {
    if (status === 'authenticated' && user) {
      navigate(loginRedirect(returnTo, user.role), { replace: true });
    }
  }, [navigate, returnTo, status, user]);

  const validate = () => {
    const nextErrors: string[] = [];
    if (!account.trim()) {
      nextErrors.push(view === 'register' || (view === 'login' && loginMode === 'password') ? '请输入账号' : '请输入手机号或邮箱');
    } else if (view === 'register' && !isValidUsername(account)) {
      nextErrors.push('请输入有效的账号');
    } else if ((view === 'reset' || (view === 'login' && loginMode === 'code')) && !isPhoneOrEmail(account)) {
      nextErrors.push('请输入有效的手机号或邮箱');
    }

    if (view === 'login') {
      if (loginMode === 'password' && !isValidPassword(password)) nextErrors.push(passwordRule);
      if (loginMode === 'code') {
        if (!isSixDigitCode(code)) nextErrors.push('请输入6位数字验证码');
        if (!challengeId) nextErrors.push('请先获取验证码');
        if (!acceptTerms) nextErrors.push('请先阅读并同意用户协议和隐私政策');
      }
    }

    if (view === 'register') {
      if (!isValidPassword(password)) nextErrors.push(passwordRule);
      if (!confirmPassword) nextErrors.push('请再次输入密码');
      else if (password !== confirmPassword) nextErrors.push('两次输入的密码不一致');
      if (!acceptTerms) nextErrors.push('请先阅读并同意用户协议和隐私政策');
    }

    if (view === 'reset') {
      if (!isSixDigitCode(code)) nextErrors.push('请输入6位数字验证码');
      if (!challengeId) nextErrors.push('请先获取验证码');
      if (!isValidPassword(password)) nextErrors.push(passwordRule);
      if (!confirmPassword) nextErrors.push('请再次输入新密码');
      else if (password !== confirmPassword) nextErrors.push('两次输入的新密码不一致');
    }

    return nextErrors;
  };

  const handleSendCode = async () => {
    if (challengeBusy || submitMode) return;
    const contact = account.trim();
    if (!contact) {
      setErrors(['请输入手机号或邮箱']);
      setNotice('');
      return;
    }
    if (!isPhoneOrEmail(contact)) {
      setErrors(['请输入有效的手机号或邮箱']);
      setNotice('');
      return;
    }
    const purpose = view === 'reset' ? 'reset_password' : 'code_login';
    invalidateChallenge();
    const generation = challengeGeneration.current;
    const controller = new AbortController();
    challengeController.current = controller;
    setChallengeBusy(true);
    setErrors([]);
    setNotice('');
    try {
      const result = await requestChallenge({ identifier: contact, purpose }, controller.signal);
      if (generation !== challengeGeneration.current) return;
      setChallengeId(result.challengeId);
      setChallengePurpose(purpose);
      setCooldownUntil(Date.now() + 60_000);
      setCooldownNow(Date.now());
      setNotice('验证码请求已受理，请留意手机或邮箱。');
    } catch (error) {
      if (generation !== challengeGeneration.current || isAbortError(error)) return;
      setErrors([errorMessage(error, 'challenge')]);
    } finally {
      if (generation === challengeGeneration.current) {
        setChallengeBusy(false);
        challengeController.current = null;
      }
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitMode || challengeBusy) return;
    const nextErrors = validate();
    setErrors(nextErrors);
    setNotice('');
    if (nextErrors.length > 0) return;

    const operation: SubmitMode = view === 'register' ? 'register' : view === 'reset' ? 'reset' : 'login';
    setSubmitMode(operation);
    try {
      let policy = policies;
      if (view === 'register' || (view === 'login' && loginMode === 'code')) {
        try {
          policy = await loadPolicies();
        } catch (error) {
          setErrors([errorMessage(error, 'policy')]);
          return;
        }
      }

      if (view === 'register') {
        if (!policy) {
          setErrors(['协议版本暂时无法获取，请稍后重试。']);
          return;
        }
        const session = await register({
          username: account,
          password,
          confirmPassword,
          termsVersion: policy.termsVersion,
          privacyVersion: policy.privacyVersion,
          acceptTerms: true,
        });
        setSession(session);
        navigate(loginRedirect(returnTo, session.user.role), { replace: true });
        return;
      }

      if (view === 'reset') {
        await resetPassword({ challengeId, identifier: account.trim(), code, password, confirmPassword });
        invalidateChallenge();
        setView('login');
        setLoginMode('password');
        setPassword('');
        setConfirmPassword('');
        setAcceptTerms(false);
        setNotice('密码已重置，请使用新密码登录。');
        return;
      }

      if (loginMode === 'code') {
        if (!policy) {
          setErrors(['协议版本暂时无法获取，请稍后重试。']);
          return;
        }
        const session = await codeLogin({
          challengeId,
          identifier: account.trim(),
          code,
          termsVersion: policy.termsVersion,
          privacyVersion: policy.privacyVersion,
          acceptTerms: true,
        });
        setSession(session);
        navigate(loginRedirect(returnTo, session.user.role), { replace: true });
        return;
      }

      const session = await login({ identifier: account.trim(), password, remember });
      setSession(session);
      navigate(loginRedirect(returnTo, session.user.role), { replace: true });
    } catch (error) {
      const errorOperation = operation === 'login' && loginMode === 'code' ? 'code-login' : operation;
      setErrors([errorMessage(error, errorOperation)]);
    } finally {
      setSubmitMode(null);
    }
  };

  const remainingSeconds = cooldownUntil ? Math.max(0, Math.ceil((cooldownUntil - cooldownNow) / 1000)) : 0;
  const codeButtonLabel = challengeBusy ? '发送中…' : remainingSeconds > 0 ? `重新获取（${remainingSeconds}秒）` : '获取验证码';
  const policyTermsUrl = '/terms';
  const policyPrivacyUrl = '/privacy';
  const policyLinks = <><Link to={linkWithReturnTo(policyTermsUrl, returnTo)}>用户协议</Link>和<Link to={linkWithReturnTo(policyPrivacyUrl, returnTo)}>隐私政策</Link></>;
  const consentField = (label: string) => <label className="auth-consent"><input aria-label={label} type="checkbox" checked={acceptTerms} onChange={(event) => setAcceptTerms(event.target.checked)} />我已阅读并同意{policyLinks}</label>;
  const submitLabel = submitMode === 'register' ? '注册中…' : submitMode === 'reset' ? '重置中…' : submitMode === 'login' ? '登录中…' : view === 'register' ? '注册' : view === 'reset' ? '重置密码' : '登录';

  const renderAccountField = (contactOnly = false) => (
    <label>
      {contactOnly ? '手机号或邮箱' : '账号 / 手机号 / 邮箱'}
      <input
        aria-label={contactOnly ? '手机号或邮箱' : '账号 / 手机号 / 邮箱'}
        value={account}
        onChange={(event) => updateAccount(event.target.value)}
        placeholder={contactOnly ? '请输入手机号或邮箱' : '请输入账号、手机号或邮箱'}
        autoComplete="username"
        aria-invalid={errors.length > 0}
      />
    </label>
  );

  const renderCodeField = () => (
    <label>
      6位验证码
      <span className="auth-input-with-action">
        <input
          aria-label="6位验证码"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          maxLength={6}
          placeholder="请输入6位验证码"
          autoComplete="one-time-code"
          aria-invalid={errors.length > 0}
        />
        <button type="button" className="text-button" onClick={() => void handleSendCode()} disabled={challengeBusy || Boolean(submitMode) || remainingSeconds > 0}>{codeButtonLabel}</button>
      </span>
    </label>
  );

  return (
    <main className="auth-page shell page-space">
      <section className="auth-card">
        <div className="auth-brand-panel">
          <span className="eyebrow">51mai 数字资源商城</span>
          <h2>一个更好的<br />数字资源购买平台</h2>
          <p>正版资源、自动交付、安全交易，让数字内容购买更简单。</p>
          <div className="auth-trust"><span>✓ 正版资源</span><span>⚡ 自动交付</span><span>◉ 安全交易</span><span>♚ 专业服务</span></div>
        </div>
        <div className="auth-form-panel">
          <h1>欢迎来到 51mai</h1>
          <div className="auth-tabs" role="tablist" aria-label="账号操作">
            <button type="button" className={view === 'login' ? 'active' : ''} onClick={() => openView('login')} role="tab" aria-selected={view === 'login'}>登录</button>
            <button type="button" className={view === 'register' ? 'active' : ''} onClick={() => openView('register')} role="tab" aria-selected={view === 'register'}>注册</button>
          </div>

          {view === 'login' && (
            <>
              <div className="auth-tabs auth-method-tabs" role="tablist" aria-label="登录方式">
                <button type="button" className={loginMode === 'password' ? 'active' : ''} onClick={() => switchLoginMode('password')} role="tab" aria-selected={loginMode === 'password'}>账号密码登录</button>
                <button type="button" className={loginMode === 'code' ? 'active' : ''} onClick={() => switchLoginMode('code')} role="tab" aria-selected={loginMode === 'code'}>验证码登录</button>
              </div>
              <form className="auth-form" onSubmit={handleSubmit} noValidate>
                {renderAccountField(loginMode === 'code')}
                {loginMode === 'password' ? (
                  <label>
                    密码
                    <input aria-label="密码" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" autoComplete="current-password" aria-invalid={errors.length > 0} />
                  </label>
                ) : (
                  <>
                    {renderCodeField()}
                    <p className="auth-help">未注册的手机号/邮箱验证后将创建本站账号并登录</p>
                    {consentField('同意用户协议和隐私政策')}
                    <label>推荐人ID（可选，暂未启用，不影响注册）<input aria-label="推荐人ID" value={referrerId} onChange={(event) => setReferrerId(event.target.value)} placeholder="暂未启用，不影响注册" /></label>
                  </>
                )}
                <div className="auth-options"><label><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />记住我</label><button className="text-button" type="button" onClick={() => openView('reset')}>忘记密码？</button></div>
                <button className="primary auth-submit" type="submit" disabled={Boolean(submitMode) || challengeBusy}>{submitLabel}</button>
              </form>
            </>
          )}

          {view === 'register' && (
            <form className="auth-form" onSubmit={handleSubmit} noValidate>
              <label>账号<input aria-label="注册账号" value={account} onChange={(event) => updateAccount(event.target.value)} placeholder="请输入账号" autoComplete="username" aria-invalid={errors.length > 0} /></label>
              <label>新密码<input aria-label="新密码" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={passwordRule} autoComplete="new-password" aria-invalid={errors.length > 0} /></label>
              <label>确认新密码<input aria-label="确认新密码" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="请再次输入密码" autoComplete="new-password" aria-invalid={errors.length > 0} /></label>
              {consentField('同意用户协议和隐私政策')}
              <label>推荐人ID（可选，暂未启用，不影响注册）<input aria-label="推荐人ID" value={referrerId} onChange={(event) => setReferrerId(event.target.value)} placeholder="暂未启用，不影响注册" /></label>
              <button className="primary auth-submit" type="submit" disabled={Boolean(submitMode) || challengeBusy}>{submitLabel}</button>
              <button className="text-button" type="button" onClick={() => openView('login')}>已有账号？返回登录</button>
            </form>
          )}

          {view === 'reset' && (
            <form className="auth-form" onSubmit={handleSubmit} noValidate>
              {renderAccountField(true)}
              {renderCodeField()}
              <label>新密码<input aria-label="重置新密码" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={passwordRule} autoComplete="new-password" aria-invalid={errors.length > 0} /></label>
              <label>确认新密码<input aria-label="重置确认新密码" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="请再次输入新密码" autoComplete="new-password" aria-invalid={errors.length > 0} /></label>
              <button className="primary auth-submit" type="submit" disabled={Boolean(submitMode) || challengeBusy}>{submitLabel}</button>
              <button className="text-button" type="button" onClick={() => openView('login')}>返回登录</button>
            </form>
          )}

          {policyState === 'error' && (view === 'register' || (view === 'login' && loginMode === 'code')) && <p className="auth-feedback error" role="alert">协议版本暂时无法获取，请稍后重试。</p>}
          {errors.length > 0 && <div className="auth-feedback error" role="alert"><ul>{errors.map((error, index) => <li key={`${error}-${index}`}>{error}</li>)}</ul></div>}
          {notice && <p className="auth-feedback notice" role="status" aria-live="polite">{notice}</p>}
        </div>
      </section>
    </main>
  );
}
