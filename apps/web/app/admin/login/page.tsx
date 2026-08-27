'use client';

// 관리자 진입 안내 — **여기에 비밀번호 칸은 없다.**
//
// 예전에는 관리자 전용 비밀번호(`admin`)를 브라우저에서 문자열 비교해 localStorage 플래그를
// 세웠다. 정적 export 라 비밀번호가 번들에 박혔고, 콘솔에서 플래그를 직접 세우면 그냥 통과했다.
//
// 이제 관리자는 **앱 일반 계정**으로 로그인하고(/login — 이메일/비밀번호 또는 소셜),
// 권한은 users.role ∈ {admin, developer} 로 판정한다. 이 화면은 세 가지만 한다:
//   · 권한이 있으면 대시보드로 넘긴다(이미 로그인한 채 이 URL 로 온 경우)
//   · 로그인 전이면 로그인 화면으로 보낸다
//   · 로그인은 했는데 권한이 없으면 그 사실을 알린다(조용히 튕기지 않는다)

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, ShieldAlert, Loader2 } from 'lucide-react';
import { useAccount, canEnterAdminConsole } from '@/lib/account';

export default function AdminLoginPage() {
  const router = useRouter();
  const { account, status } = useAccount();

  const allowed = canEnterAdminConsole(account);

  useEffect(() => {
    if (status === 'loading') return;
    if (allowed) router.replace('/admin/dashboard');
  }, [status, allowed, router]);

  // 권한이 확인되면 리다이렉트가 진행 중이므로 로더를 유지한다.
  const loading = status === 'loading' || allowed;
  // 세션이 없거나 익명이면 '로그인 필요', 로그인은 했는데 role 이 모자라면 '권한 없음'.
  const signedIn = !!account && !account.isAnonymous;

  return (
    <div className="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-hanok font-sans">
      <div className="pointer-events-none absolute left-1/4 top-1/4 h-96 w-96 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gold/10 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-1/4 right-1/4 h-96 w-96 translate-x-1/2 translate-y-1/2 rounded-full bg-gold/10 blur-[120px]" />

      <div className="relative z-10 w-full max-w-sm px-6">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-gold/30 bg-gold/15 text-gold">
            {signedIn && !loading ? <ShieldAlert size={26} /> : <ShieldCheck size={26} />}
          </div>
          <h1 className="font-serif text-2xl font-bold tracking-tight text-white">NextSpot 관제</h1>
          <p className="mt-1 text-sm text-hanok-muted">경북문화관광공사 운영 대시보드</p>
        </div>

        <div className="rounded-3xl border border-hanok-line bg-hanok-deep/60 p-6 text-center">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-hanok-muted">
              <Loader2 className="animate-spin" size={18} />
              <span className="text-sm">권한 확인 중…</span>
            </div>
          ) : signedIn ? (
            <>
              <p className="font-bold text-white">관리자 권한이 없는 계정입니다</p>
              <p className="mt-1.5 text-xs leading-relaxed text-hanok-muted">
                이 대시보드는 관리자 계정만 들어올 수 있어요. 다른 계정으로 로그인하거나
                담당자에게 권한을 요청해 주세요.
              </p>
              <button
                type="button"
                onClick={() => router.push('/login?next=/admin/dashboard')}
                className="mt-5 w-full rounded-xl bg-gradient-to-r from-gold to-terracotta py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
              >
                다른 계정으로 로그인
              </button>
              <button
                type="button"
                onClick={() => router.push('/main')}
                className="mt-2 w-full rounded-xl border border-hanok-line py-2.5 text-sm text-hanok-muted transition-colors hover:text-white"
              >
                관광객 앱으로 돌아가기
              </button>
            </>
          ) : (
            <>
              <p className="font-bold text-white">로그인이 필요합니다</p>
              <p className="mt-1.5 text-xs leading-relaxed text-hanok-muted">
                관제 대시보드는 NextSpot 계정으로 들어옵니다. 별도 관리자 비밀번호는 없습니다.
              </p>
              <button
                type="button"
                onClick={() => router.push('/login?next=/admin/dashboard')}
                className="mt-5 w-full rounded-xl bg-gradient-to-r from-gold to-terracotta py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
              >
                로그인하기
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
