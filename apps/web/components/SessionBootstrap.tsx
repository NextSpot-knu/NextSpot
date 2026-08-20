"use client";

import { useEffect } from "react";
import { reconcileUserData } from "@/lib/userData";
import { syncSaved } from "@/lib/savedFacilities";
import { flushRecommendationOutcomes } from "@/lib/recommendationOutcomes";
import { ensureAnonymousSession } from "@/lib/anonymousSession";

/**
 * SessionBootstrap — 관광객 무마찰(frictionless) 익명 세션 부트스트랩.
 *
 * 관광객 로그인 UI 없이 모든 방문자에게 '진짜' per-device 세션을 만들어 준다. 마운트 시 현재 세션을
 * 확인하고, 없으면 Supabase 익명 로그인(signInAnonymously)을 1회 시도한다. 성공하면 개인화 필수
 * 엔드포인트(/recommendations, /courses/recommend, /coupons/*, /reports/congestion, /users/me/vector)가
 * 실제 JWT 로 동작하고, 저장/쿠폰/리포트가 이어진다. 세션은 lib/supabase.ts 의 persistSession 으로
 * localStorage 에 지속돼 새로고침·재방문에도 같은 사용자로 유지된다.
 *
 * 그레이스풀 폴백: typeof window 가드 + try/catch 로 완전히 감싼다. 프로젝트에서 익명 로그인이
 * 비활성이면 공개 화면은 유지하되 인증 필수 요청은 명시적으로 실패하고 로컬 규칙 추천으로 전환한다.
 * 존재하지 않는 고정 mock 사용자 ID를 서버에 보내지는 않는다.
 *
 * ⚠️ 이 기능을 실제로 활성화하려면 Supabase 프로젝트 설정 두 가지가 필요하다:
 *   1) Authentication → Sign In / Providers → "Allow anonymous sign-ins" 를 켠다.
 *   2) 마이그레이션 supabase/migrations/20260710160000_handle_new_user.sql 를 적용한다.
 *      (auth.users INSERT → public.users 행 자동 생성. 없으면 recommendations.fetch_user 가 404 → 추천 차단.)
 *   둘 중 하나라도 빠지면 익명 로그인이 실패하거나 추천이 404 가 되고, 위 폴백으로 예전 동작이 된다.
 */
export default function SessionBootstrap() {
  useEffect(() => {
    // 정적 export(SSR) 프리렌더 시점에는 실행되지 않게 브라우저 가드.
    if (typeof window === "undefined") return;

    let cancelled = false;

    (async () => {
      try {
        const session = await ensureAnonymousSession();

        if (cancelled) return;

        // 세션 user_id 가 직전과 바뀌었으면(로그아웃→새 익명, 계정 전환) 이전 사용자의 개인
        // 로컬 데이터를 청소해 사용자 간 데이터 유출을 막는다. linkIdentity(승격)는 uid 가 유지돼 보존.
        reconcileUserData(session?.user?.id ?? null);

        // 청소 직후 이 사용자의 저장 장소를 Supabase 에서 로컬로 동기화(기기 변경 시 복원).
        if (session?.user?.id) {
          void syncSaved();
          void flushRecommendationOutcomes();
        }
      } catch (err) {
        // 네트워크 오류/설정 부재 등 예외 — 앱을 막지 않고 조용히 폴백.
        console.warn(
          "[SessionBootstrap] 세션 부트스트랩 예외 — 목업 방문자 동작으로 폴백합니다(무회귀).",
          err,
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
