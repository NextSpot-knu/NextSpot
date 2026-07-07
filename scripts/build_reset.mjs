#!/usr/bin/env node
// =====================================================================
// build_reset.mjs — supabase/RESET_AND_SETUP.sql 자동 생성기
// (docs/IMPROVEMENT_PLAN.md §1 D2: migrations/ 가 스키마 소스 오브 트루스,
//  RESET_AND_SETUP.sql 은 이 스크립트가 만드는 산출물이다.)
//
// 동작:
//   supabase/migrations/*.sql 을 파일명 순으로 읽어
//   [고정 헤더] + [DROP 프렐류드] + [마이그레이션별 구분 주석 + 원문] 으로 이어붙인다.
//
// 사용법:  node scripts/build_reset.mjs
//   스키마 변경 시 migrations/ 에 새 타임스탬프 마이그레이션을 추가한 뒤
//   이 스크립트를 재실행해 RESET_AND_SETUP.sql 을 재생성·커밋한다.
//   CI(.github/workflows/ci.yml schema job)가 재생성 결과와 커밋본의 일치를 검증한다.
//
// 결정적 출력: 파일명 오름차순(ASCII) 정렬, LF 개행, 마지막 개행 1개 —
//   CI 에서 `git diff --exit-code` 로 드리프트를 잡을 수 있게 한다.
//
// DROP 프렐류드는 별도 파일 대신 아래 PRELUDE 상수로 이 스크립트 안에 둔다.
// ⚠️ 새 마이그레이션이 **테이블/함수를 새로 만들면** PRELUDE 의 DROP 목록에도 추가할 것.
//    (현재 커버: users, facilities, congestion_logs, recommendations, user_feedback,
//     inquiries, system_settings, user_preference_vectors /
//     get_auth_user_info(레거시), get_auth_user_role, handle_updated_at)
// =====================================================================

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const OUT_FILE = join(ROOT, "supabase", "RESET_AND_SETUP.sql");

const HEADER = `-- =====================================================================
-- NextSpot — RESET + 관광 스키마/시드 일괄 적용 (Supabase SQL Editor 용)
--
-- ⚠️ 자동 생성 파일 — 직접 수정 금지!
--    이 파일은 scripts/build_reset.mjs 가 supabase/migrations/ 에서 자동 생성한다.
--    스키마 변경은 migrations/ 에 새 마이그레이션을 추가한 뒤
--    \`node scripts/build_reset.mjs\` 를 재실행해 이 파일을 재생성할 것. (D2, docs/IMPROVEMENT_PLAN.md)
--
-- 사용법: Supabase Dashboard > SQL Editor 에 이 파일 전체를 붙여넣고 [Run].
-- ⚠️ 기존 스키마/데이터를 모두 삭제한 뒤 관광 스키마+경주 시드를 생성합니다(되돌릴 수 없음).
--    DB 비밀번호 공유 없이, 대시보드 SQL Editor 접근만으로 1회 실행하면 됩니다.
-- =====================================================================`;

// DROP 프렐류드 — 기존 수기 RESET_AND_SETUP.sql 상단 블록을 승계.
// migrations 가 생성하는 모든 테이블/함수를 삭제해 어떤 상태의 DB에서도 재실행 가능하게 한다.
// (get_auth_user_info 는 InduSpot 레거시 함수 — 구 DB 정리를 위해 유지.)
const PRELUDE = `DROP TABLE IF EXISTS public.user_feedback CASCADE;
DROP TABLE IF EXISTS public.recommendations CASCADE;
DROP TABLE IF EXISTS public.congestion_logs CASCADE;
DROP TABLE IF EXISTS public.facilities CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;
DROP TABLE IF EXISTS public.system_settings CASCADE;
DROP TABLE IF EXISTS public.inquiries CASCADE;
DROP TABLE IF EXISTS public.user_preference_vectors CASCADE;
DROP FUNCTION IF EXISTS public.get_auth_user_info() CASCADE;
DROP FUNCTION IF EXISTS public.get_auth_user_role() CASCADE;
DROP FUNCTION IF EXISTS public.handle_updated_at() CASCADE;`;

/** CRLF→LF 정규화 + 꼬리 공백 개행 제거(마지막 개행은 조립 시 일괄 부여). */
function normalize(sql) {
  return sql.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort(); // 타임스탬프 파일명 오름차순 = 적용 순서

if (migrations.length === 0) {
  console.error("supabase/migrations/ 에 .sql 파일이 없습니다.");
  process.exit(1);
}

const sections = migrations.map((file) => {
  const body = normalize(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  return `\n\n-- ============================= migrations/${file} =============================\n${body}`;
});

const output = `${HEADER}\n${PRELUDE}${sections.join("")}\n`;

writeFileSync(OUT_FILE, output, { encoding: "utf8" });
console.log(
  `supabase/RESET_AND_SETUP.sql 생성 완료 — 마이그레이션 ${migrations.length}개:\n` +
    migrations.map((f) => `  - ${f}`).join("\n")
);
