'use client';

// 마이페이지 계정 섹션 — docs/archive/OAUTH_PLAN.md F5.
// 익명(게스트) 세션 위에 카카오·구글 소셜 계정으로 '계속하기'. 회원가입/로그인은 버튼 하나로 자동 분기된다 —
//   신규든 기존이든 signInOAuth 로 **한 번에** 끝나고, 게스트 데이터는 콜백의 병합이 옮긴다.
//   (2026-08-28 이전에는 linkOAuth 라, 이미 가입한 계정이면 콜백이 로그인으로 폴백하며 프로바이더를 두 번 왕복했다.)
// 상태 분기:
//   · guest/none : '계속하기' 유도 배너 + 프로바이더 버튼(카카오/구글)
//   · linked     : 연동된 프로바이더 뱃지(로그아웃은 마이페이지 기존 버튼이 담당)

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Link2, Check } from 'lucide-react';
import { getAuthState, signInOAuth, type AuthState, type OAuthProvider } from '@/lib/auth';
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
  // 왜 linkOAuth 가 아닌가(2026-08-28 변경): linkOAuth 는 현재 익명 세션에 소셜 identity 를
  // 붙이려 한다. 이미 그 소셜 계정으로 가입한 사용자면 identity_already_exists 로 실패하고,
  // 콜백이 signInOAuth 로 자동 폴백한다 — 결과적으로 로그인은 되지만 **프로바이더를 두 번
  // 왕복**한다. 사용자 눈에는 구글 계정 선택 화면이 두 번 떠서 '처음엔 실패했다' 로 읽힌다.
  // 재방문자는 전부 이 경로라 흔한 경우다(/login 은 2026-08-27 에 같은 이유로 이미 바꿨다).
  //
  // signInOAuth 는 신규·기존 모두 한 번에 끝난다. 신규 사용자는 uid 가 바뀌지만 게스트
  // 데이터는 잃지 않는다 — captureGuestSession() 이 익명 토큰을 잡아 두고 콜백의
  // mergeCapturedGuestData() → POST /account/merge-guest 가 취향·닉네임·저장·쿠폰·제보·추천
  // 이력을 원자적으로 옮긴다(merge_guest_account_data RPC).
  const handleContinue = async (provider: OAuthProvider) => {
    if (busy) return;
    setBusy(true);
    const { error } = await signInOAuth(provider, '/mypage');
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
          {state.providers.length === 0 && state.user?.email && (
            <span className="px-3 py-1.5 rounded-full bg-jade/10 border border-jade/30 text-jade text-sm font-semibold">
              {t('auth.linkedEmail', { email: state.user.email })}
            </span>
          )}
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
    <div className="bg-gradient-to-r from-gold/15 via-hanji to-terracotta/10 border border-gold/35 rounded-3xl p-5 shadow-[0_2px_14px_rgba(43,35,32,0.06)] mb-4">
      <div className="flex items-center gap-2 mb-1">
        <Link2 size={18} className="text-gold-deep" />
        <h3 className="font-bold text-muk">{t('auth.guestTitle')}</h3>
      </div>
      <p className="text-xs text-muk-soft mb-4">{t('auth.guestDesc')}</p>

      {/* 2열 1행(PM 지시) — 세로 나열보다 카드가 낮아져 마이탭 스크롤이 짧아진다.
          좁은 화면에서 문구가 길면 줄바꿈 대신 축약되도록 truncate 처리. */}
      <div className="grid grid-cols-2 gap-2">
        {PROVIDERS.map((p) => (
          <button
            key={p}
            type="button"
            disabled={busy}
            onClick={() => handleContinue(p)}
            className={`flex items-center justify-center gap-2 py-3 px-2 rounded-xl font-bold text-sm transition-all disabled:opacity-50 ${providerButtonClass(p)}`}
          >
            <span className="truncate">{t(p === 'kakao' ? 'auth.continueKakao' : 'auth.continueGoogle')}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
