'use client';

// 마이페이지 계정 섹션 — docs/OAUTH_PLAN.md F5.
// 익명(게스트) 세션 위에 카카오·구글 소셜 계정으로 '계속하기'. 회원가입/로그인은 버튼 하나로 통합된다:
//   처음 연결하는 계정이면 현재 익명 사용자에 연결(회원가입), 이미 연결된 적 있는 계정이면
//   콜백이 자동으로 로그인(계정 전환)으로 폴백한다(lib/auth.ts linkOAuth + app/auth/callback).
// 상태 분기:
//   · guest/none : '계속하기' 유도 배너 + 프로바이더 버튼(카카오/구글)
//   · linked     : 연동된 프로바이더 뱃지(로그아웃은 마이페이지 기존 버튼이 담당)

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Link2, Check } from 'lucide-react';
import { getAuthState, linkOAuth, type AuthState, type OAuthProvider } from '@/lib/auth';
import { useT } from '@/lib/i18n/I18nProvider';

const PROVIDERS: OAuthProvider[] = ['kakao', 'google'];

// 프로바이더 브랜드 버튼 스타일(카카오=노랑/검정, 구글=흰색/테두리).
function providerButtonClass(id: OAuthProvider): string {
  if (id === 'kakao') return 'bg-[#FEE500] text-[#191600] hover:brightness-95';
  return 'bg-white text-muk border border-line hover:bg-hanji-deep';
}

export function AccountSection() {
  const t = useT();
  const [state, setState] = useState<AuthState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getAuthState().then((s) => {
      if (alive) setState(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 성공 시 브라우저가 프로바이더로 리다이렉트되므로, 실패(리다이렉트 전 오류)만 여기서 처리.
  const handleContinue = async (provider: OAuthProvider) => {
    if (busy) return;
    setBusy(true);
    const { error } = await linkOAuth(provider, '/mypage');
    if (error) {
      setBusy(false);
      toast.error(t('auth.linkError'));
    }
    // error 가 없으면 리다이렉트 진행 중 — busy 유지(중복 클릭 방지).
  };

  // 로딩 중에는 렌더하지 않는다(별도 스켈레톤은 과함 — 섹션이 선택적 보조 UI).
  if (!state) return null;

  if (state.status === 'linked') {
    return (
      <div className="bg-white border border-line rounded-3xl p-5 shadow-[0_2px_14px_rgba(43,35,32,0.06)] mb-4">
        <div className="flex items-center gap-2 mb-3">
          <Check size={18} className="text-jade" />
          <h3 className="font-bold text-muk">{t('auth.linkedTitle')}</h3>
        </div>
        <div className="flex flex-wrap gap-2">
          {state.providers.map((p) => (
            <span
              key={p}
              className="px-3 py-1.5 rounded-full bg-jade/10 border border-jade/30 text-jade text-sm font-semibold"
            >
              {t('auth.linkedVia', { provider: t(`auth.provider${p === 'kakao' ? 'Kakao' : 'Google'}`) })}
            </span>
          ))}
        </div>
      </div>
    );
  }

  // guest / none — '계속하기' 유도(회원가입/로그인 통합).
  return (
    <div className="bg-gradient-to-r from-gold/15 via-white to-terracotta/10 border border-gold/35 rounded-3xl p-5 shadow-[0_2px_14px_rgba(43,35,32,0.06)] mb-4">
      <div className="flex items-center gap-2 mb-1">
        <Link2 size={18} className="text-gold-deep" />
        <h3 className="font-bold text-muk">{t('auth.guestTitle')}</h3>
      </div>
      <p className="text-xs text-muk-soft mb-4">{t('auth.guestDesc')}</p>

      <div className="flex flex-col gap-2">
        {PROVIDERS.map((p) => (
          <button
            key={p}
            type="button"
            disabled={busy}
            onClick={() => handleContinue(p)}
            className={`flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm transition-all disabled:opacity-50 ${providerButtonClass(p)}`}
          >
            {t(p === 'kakao' ? 'auth.continueKakao' : 'auth.continueGoogle')}
          </button>
        ))}
      </div>
    </div>
  );
}
