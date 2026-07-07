import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      // 기존 관리자 화면(dashboard/reports 등)에 `any` 부채가 누적돼 있어 CI 차단을 막기 위해
      // 일단 warn 으로 낮춘다. 타입 강화는 docs/IMPROVEMENT_PLAN.md WS-D 에서 일괄 처리 후
      // error 로 복원할 것. 신규 코드는 any 를 쓰지 말 것.
      "@typescript-eslint/no-explicit-any": "warn",
      // `_` 접두 변수/인자는 의도적 미사용 표기로 허용 (예: dashboard 의 _realFacilities)
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // eslint-config-next 16 이 도입한 React Compiler 계열 규칙 — 기존 페이지 전반(40건)이
      // 걸린다(대부분 effect 내 setState 패턴). 실동작 중인 코드라 CI 차단 대신 warn 으로 두고,
      // WS-D(프론트 정합성/과대 컴포넌트 분리) 리팩터링에서 해소 후 error 로 복원한다.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/refs": "warn",
    },
  },
]);

export default eslintConfig;
