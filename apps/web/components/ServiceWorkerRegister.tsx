"use client";

import { useEffect } from "react";

/**
 * 서비스 워커(/sw.js) 등록 — 설치형 PWA의 오프라인 복원력.
 *
 * - 브라우저 환경 + serviceWorker 지원 시에만 동작(SSR/정적 export 안전 가드).
 * - 개발(localhost, NODE_ENV !== 'production')에서는 등록을 건너뛴다 —
 *   dev 서버 HMR/캐시와의 충돌을 피하고 프로덕션 유사 환경에서만 캐싱한다.
 * - 어떤 실패도 페이지를 막지 않도록 조용히 삼킨다.
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    // 프로덕션 유사 환경에서만 등록(dev 서버에서는 스킵).
    const isLocalhost =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";
    if (process.env.NODE_ENV !== "production" || isLocalhost) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* 등록 실패는 무시 — 오프라인 미지원일 뿐 앱 동작에는 영향 없음. */
      });
    };

    // 초기 로드 경쟁을 피해 load 이후 등록.
    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
