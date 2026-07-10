"use client";

import { useEffect } from "react";
import { createPublicClient } from "@/lib/supabase";

/**
 * SessionBootstrap — 관광객 무마찰(frictionless) 익명 세션 부트스트랩.
 *
 * 관광객 로그인 UI 없이 모든 방문자에게 '진짜' per-device 세션을 만들어 준다. 마운트 시 현재 세션을
 * 확인하고, 없으면 Supabase 익명 로그인(signInAnonymously)을 1회 시도한다. 성공하면 개인화 필수
 * 엔드포인트(/recommendations, /courses/recommend, /coupons/*, /reports/congestion, /users/me/vector)가
 * 실제 JWT 로 동작하고, 저장/쿠폰/리포트가 이어진다. 세션은 lib/supabase.ts 의 persistSession 으로
 * localStorage 에 지속돼 새로고침·재방문에도 같은 사용자로 유지된다.
 *
 * 그레이스풀 폴백(무회귀): typeof window 가드 + try/catch 로 완전히 감싼다. 프로젝트에서 익명 로그인이
 * 비활성이면 signInAnonymously 가 실패(422 등)하는데, 경고만 남기고 조용히 넘어간다 → 세션이 없으니
 * 각 페이지/ api-client 는 기존 목업 방문자(MOCK_VISITOR_ID) 경로로 그대로 폴백한다(오늘과 동일 동작,
 * UI 변화·크래시 없음).
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
        const supabase = createPublicClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();

        // 이미 세션(익명 포함)이 있으면 재사용 — per-device 지속성 유지(새 익명 사용자 남발 방지).
        if (cancelled || session) return;

        const { error } = await supabase.auth.signInAnonymously();
        if (error && !cancelled) {
          // 익명 로그인 비활성/거부 등 → 목업 방문자 경로로 폴백(무회귀).
          console.warn(
            "[SessionBootstrap] 익명 로그인 실패 — 목업 방문자 동작으로 폴백합니다. " +
              "Supabase Auth 설정에서 'Allow anonymous sign-ins' 를 확인하세요.",
            error.message,
          );
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
