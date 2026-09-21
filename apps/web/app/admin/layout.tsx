'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useAccount, canEnterAdminConsole } from '@/lib/account';
import { isDemoParam } from '@/lib/demoFixtures';

// 정적 export 에서는 Next 미들웨어가 실행되지 않으므로, /admin/* 보호는
// 이 클라이언트 레이아웃 가드가 담당한다.
//  - 인증 = Supabase 계정 + users.role ∈ {admin, developer}. 판정은 lib/account.tsx 단일 출처.
//    (예전엔 번들에 박힌 비밀번호와 localStorage 플래그였다 — 콘솔 한 줄로 통과 가능했다.)
//  - 이 가드는 UX 일 뿐이다. 우회해도 관리자 API 는 서버가 매 요청 role 을 확인해 403 을 낸다.
//  - status==='loading' 동안만 로더를 보인다. /account/me 가 실패하면 status='error' 로 끝나므로
//    "권한 확인 중" 에 영원히 갇히지 않는다(로그인 화면으로 보낸다).
//  - 로그인 페이지(/admin/login)는 공개로 통과. 그 외 /admin/* 는 세션 없으면 로그인으로 보낸다.
// 재방문 스테일-우선 게이트 캐시 — 직전에 관리자로 판정된 브라우저는 "권한 확인 중" 로더 없이
// 콘솔을 먼저 그리고, 실제 판정은 백그라운드에서 계속 진행한다. 이 가드는 UX 일 뿐이므로(아래
// 주석) 낙관 렌더가 보안을 약화하지 않는다: 데이터는 전부 관리자 API 뒤에 있고, 판정이 부정으로
// 끝나는 즉시 로그인으로 보낸다. 대기보드 스테일-우선 캐시와 같은 사상.
const GATE_CACHE_KEY = 'nextspot_admin_gate_v1';
const GATE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const isLoginRoute = pathname === '/admin/login';
  const [mounted, setMounted] = useState(false);
  // 직전 세션의 긍정 판정 캐시 — 마운트 후에만 읽는다(프리렌더/하이드레이션 불일치 방지).
  const [optimisticAllowed, setOptimisticAllowed] = useState(false);
  // 읽기 전용 데모(?demo=1) — 로그인도 역할 검사도 없이 관제 화면을 보여 준다.
  // useSearchParams 대신 location 을 마운트 후에 읽는다: 레이아웃에 Suspense 경계를 두지
  // 않아도 되고(정적 export 의 CSR bailout 회피), 프리렌더 HTML 과도 어긋나지 않는다.
  // 데모는 **화면만** 연다 — 데이터는 전부 고정값이고 관리자 API 는 세션이 없으면 여전히 403 이다.
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    setMounted(true);
    try {
      if (isDemoParam(new URLSearchParams(window.location.search).get('demo'))) setDemo(true);
    } catch { /* URL 파싱 불가 — 평소 게이트 경로 그대로 */ }
    try {
      const raw = window.localStorage.getItem(GATE_CACHE_KEY);
      if (!raw) return;
      const cached = JSON.parse(raw) as { allowed?: boolean; savedAt?: number };
      if (cached.allowed === true && typeof cached.savedAt === 'number'
        && Date.now() - cached.savedAt <= GATE_CACHE_MAX_AGE_MS) {
        setOptimisticAllowed(true);
      }
    } catch { /* 저장소 차단 — 기존 로더 경로 그대로 */ }
  }, []);

  // 마운트 후에만 localStorage 평가(서버 프리렌더/하이드레이션 불일치 방지).
  const { account, status } = useAccount();
  const resolved = mounted && status !== 'loading';
  const authed = resolved && canEnterAdminConsole(account);

  // 판정이 끝날 때마다 캐시를 갱신한다 — 긍정이면 저장, 부정이면 제거(다음 방문은 로더 경로).
  useEffect(() => {
    if (!resolved || demo) return; // 데모는 남의 게이트 캐시를 지우지 않는다.
    try {
      if (authed) {
        window.localStorage.setItem(GATE_CACHE_KEY, JSON.stringify({ allowed: true, savedAt: Date.now() }));
      } else {
        window.localStorage.removeItem(GATE_CACHE_KEY);
      }
    } catch { /* 저장소 차단 — 캐시 없이 동작 */ }
  }, [resolved, authed, demo]);

  useEffect(() => {
    if (resolved && !isLoginRoute && !authed && !demo) {
      router.replace('/admin/login');
    }
  }, [resolved, isLoginRoute, authed, demo, pathname, router]);

  // 로그인 페이지는 항상 통과. 캐시된 긍정 판정은 판정이 '끝나기 전까지만' 낙관 렌더한다 —
  // 부정으로 끝나면 즉시 로더+리다이렉트 경로로 떨어진다.
  const content = isLoginRoute || demo || authed || (optimisticAllowed && !resolved)
    ? children
    : (
      <div className="min-h-screen w-full flex items-center justify-center bg-hanok text-hanok-muted">
        <Loader2 className="animate-spin" size={20} />
        <span className="ml-2 text-sm">권한 확인 중…</span>
      </div>
    );

  // `nextspot-admin` 은 globals.css 에서 단청 강조색(금·청록·주칠)을 한옥 웜다크 서페이스에
  // 맞춰 한 단계 밝히는 토큰 스코프다. `contents` 라 레이아웃 박스를 만들지 않으므로
  // 사이드바+본문 flex 구조에 영향이 없고, 커스텀 속성만 하위로 상속된다.
  return <div className="contents nextspot-admin">{content}</div>;
}
