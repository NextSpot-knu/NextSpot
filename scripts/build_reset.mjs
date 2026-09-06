#!/usr/bin/env node
// =====================================================================
// build_reset.mjs — supabase/RESET_AND_SETUP.sql 자동 생성기
// (docs/archive/IMPROVEMENT_PLAN.md §1 D2: migrations/ 가 스키마 소스 오브 트루스,
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
//    테이블은 이 스크립트가 스스로 검증한다 — migrations 의 `CREATE TABLE public.X` 를 전부
//    모아 PRELUDE 의 `DROP TABLE IF EXISTS public.X` 와 대조하고, 빠진 게 있으면 실패한다
//    (아래 assertPreludeCoversTables). CI schema job 이 이 스크립트를 실행하므로 누락은
//    PR 에서 막힌다.
//    ⚠️ **함수는 자동 검증하지 않는다**(시그니처까지 맞춰야 해서 오탐이 크다) — 새 함수를
//       만들면 PRELUDE 의 DROP FUNCTION 목록에 손으로 추가할 것.
//    (한때 여기에 "현재 커버: users, facilities, …" 하는 손으로 관리하는 목록이 있었다.
//     그 목록이 PRELUDE 와 어긋난 채 방치되면서 saved_facilities·user_coupons·
//     merchant_timesales·admin_ingest_requests·app_events 5개가 DROP 에서 통째로 빠졌고,
//     "모든 테이블을 삭제한다"던 리셋이 실제로는 부분 리셋이었다. 손 목록은 또 어긋나므로
//     다시 두지 않는다 — 진실은 PRELUDE 본문 하나뿐이고, 검증은 코드가 한다.)
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
--    \`node scripts/build_reset.mjs\` 를 재실행해 이 파일을 재생성할 것. (D2, docs/archive/IMPROVEMENT_PLAN.md)
--
-- 사용법: Supabase Dashboard > SQL Editor 에 이 파일 전체를 붙여넣고 [Run].
-- ⚠️ 기존 스키마/데이터를 모두 삭제한 뒤 관광 스키마+경주 시드를 생성합니다(되돌릴 수 없음).
--    DB 비밀번호 공유 없이, 대시보드 SQL Editor 접근만으로 1회 실행하면 됩니다.
-- =====================================================================`;

// DROP 프렐류드 — 기존 수기 RESET_AND_SETUP.sql 상단 블록을 승계.
// migrations 가 생성하는 모든 테이블/함수를 삭제해 어떤 상태의 DB에서도 재실행 가능하게 한다.
// (get_auth_user_info 는 InduSpot 레거시 함수 — 구 DB 정리를 위해 유지.)
//
// ⚠️ 삭제 범위 — 이 스크립트가 만드는 RESET 은 **되돌릴 수 없는 전체 초기화**다.
//    특히 다음 둘은 "사용자 데이터"가 아니라 **운영 기록**이라 다시 만들 수 없다:
//      - app_events            : 누적 퍼널/리텐션 로그. 지우면 과거 지표가 영구 소실된다.
//      - admin_ingest_requests : 운영자 승인 대기 큐. 지우면 미처리 요청이 사라진다.
//    제품 담당자가 이 파괴 범위를 알고 승인했다("전체 리셋이 목적이면 코드를 주석에 맞춰라").
//    부분 리셋이 필요하면 이 파일이 아니라 별도 스크립트를 만들 것 — 여기서 몰래 빼면
//    "모든 테이블을 삭제한다"는 주석이 다시 거짓말이 된다.
//
// DROP 순서 — 전부 CASCADE 라 순서가 없어도 동작하지만, 순서를 **의도적으로** 둔다.
//   CASCADE 는 "의존물을 말없이 같이 지운다"라서, 순서가 뒤죽박죽이면 어떤 표가 어떤 표를
//   참조하는지 이 목록만 봐서는 알 수 없고 누락도 눈에 안 띈다(이번 5개 누락이 그 경우다).
//   규칙: **참조하는 쪽(자식)이 먼저, 참조당하는 쪽(부모)이 나중.**
//   즉 users / facilities 를 가리키는 표를 전부 먼저 죽이고 → facilities → users 순.
//   FK 가 아예 없는 표(app_events, admin_ingest_requests, system_settings …)는 순서에
//   자유롭지만, 읽는 사람이 "왜 여기 있지"를 묻지 않도록 뒤쪽 독립 블록에 모아 둔다.
const PRELUDE = `DROP TABLE IF EXISTS public.role_audit_log CASCADE;
DROP TABLE IF EXISTS public.business_verification_requests CASCADE;
DROP TABLE IF EXISTS public.facility_owners CASCADE;
DROP TABLE IF EXISTS public.user_feedback CASCADE;
DROP TABLE IF EXISTS public.facility_availability_reports CASCADE;
-- users + facilities 를 함께 참조하는 표(부모 둘보다 반드시 먼저).
DROP TABLE IF EXISTS public.user_coupons CASCADE;
DROP TABLE IF EXISTS public.saved_facilities CASCADE;
-- facilities 만 참조하는 표.
DROP TABLE IF EXISTS public.merchant_timesales CASCADE;
DROP TABLE IF EXISTS public.area_demand_snapshot_lots CASCADE;
DROP TABLE IF EXISTS public.area_demand_snapshots CASCADE;
DROP TABLE IF EXISTS public.recommendation_outcomes CASCADE;
DROP TABLE IF EXISTS public.model_registry CASCADE;
DROP TABLE IF EXISTS public.facility_source_refs CASCADE;
DROP TABLE IF EXISTS public.tourism_insight_snapshots CASCADE;
DROP TABLE IF EXISTS public.tourism_concentration_forecasts CASCADE;
DROP TABLE IF EXISTS public.recommendations CASCADE;
DROP TABLE IF EXISTS public.congestion_logs CASCADE;
-- users 만 참조하는 표(부모보다 먼저 — 예전에는 users 아래에 있었다. CASCADE 덕에
-- 동작은 했지만 "자식 먼저" 규칙을 깨서 목록을 읽기 어렵게 만들고 있었다).
DROP TABLE IF EXISTS public.inquiries CASCADE;
DROP TABLE IF EXISTS public.user_preference_vectors CASCADE;
-- 부모 — facilities 를 먼저, users 를 마지막에.
DROP TABLE IF EXISTS public.facilities CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;
-- FK 가 없는 독립 표 — 순서 무관. app_events(누적 퍼널 로그)와
-- admin_ingest_requests(운영자 승인 큐)도 전체 리셋 대상이다(상단 ⚠️ 참고).
DROP TABLE IF EXISTS public.system_settings CASCADE;
DROP TABLE IF EXISTS public.app_events CASCADE;
DROP TABLE IF EXISTS public.admin_ingest_requests CASCADE;
DROP FUNCTION IF EXISTS public.get_auth_user_info() CASCADE;
DROP FUNCTION IF EXISTS public.get_auth_user_role() CASCADE;
DROP FUNCTION IF EXISTS public.is_admin_or_dev() CASCADE;
DROP FUNCTION IF EXISTS public.guard_users_privileged_columns() CASCADE;
DROP FUNCTION IF EXISTS public.latest_congestion_for_facilities(UUID[]) CASCADE;
DROP FUNCTION IF EXISTS public.apply_localdata_sync(JSONB) CASCADE;
DROP FUNCTION IF EXISTS public.promote_recommendation_model(TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.record_recommendation_outcome(UUID, UUID, TEXT, TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.correlate_congestion_report_evidence() CASCADE;
DROP FUNCTION IF EXISTS public.project_outcome_congestion_log() CASCADE;
DROP FUNCTION IF EXISTS public.merge_guest_account_data(UUID, UUID) CASCADE;
DROP FUNCTION IF EXISTS public.record_facility_availability_report(UUID, UUID, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.recompute_facility_availability_evidence(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.refresh_facility_availability_after_delete() CASCADE;
DROP FUNCTION IF EXISTS public.log_facility_owner_deletion() CASCADE;
DROP FUNCTION IF EXISTS public.area_demand_points_near(DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, DOUBLE PRECISION, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.merge_guest_account_data_without_availability(UUID, UUID) CASCADE;
DO $$
DECLARE
  v_job_id BIGINT;
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    FOR v_job_id IN EXECUTE
      'SELECT jobid FROM cron.job WHERE jobname IN (''nextspot-area-demand-primary'', ''nextspot-area-demand-retry'')'
    LOOP
      EXECUTE format('SELECT cron.unschedule(%s)', v_job_id);
    END LOOP;
  END IF;
END;
$$;
DROP FUNCTION IF EXISTS public.request_area_demand_collection(BOOLEAN) CASCADE;
DROP FUNCTION IF EXISTS public.configure_area_demand_collection(TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.record_area_demand_snapshot(TEXT, TIMESTAMPTZ, JSONB) CASCADE;
DROP FUNCTION IF EXISTS public.handle_updated_at() CASCADE;`;

/** CRLF→LF 정규화 + 꼬리 공백 개행 제거(마지막 개행은 조립 시 일괄 부여). */
function normalize(sql) {
  return sql.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

/**
 * 줄 단위 `--` 주석 제거. CREATE/DROP TABLE 스캔이 주석 속 예시 문장에 걸리지 않게 한다.
 * (문자열 리터럴 안의 `--` 까지 가리는 완전한 파서는 아니지만, 이 스캔의 목적은
 *  "PRELUDE 에 빠진 표를 찾는 것"이라 오탐보다 미탐이 위험하다 — 주석 줄만 지우고
 *  나머지는 그대로 본다.)
 */
function stripLineComments(sql) {
  return sql.replace(/^[ \t]*--.*$/gm, "");
}

const CREATE_TABLE_RE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.([a-z0-9_]+)/gi;
const DROP_TABLE_RE = /\bDROP\s+TABLE\s+IF\s+EXISTS\s+public\.([a-z0-9_]+)/gi;

/**
 * PRELUDE 가 migrations 의 모든 `CREATE TABLE public.X` 를 덮는지 검증한다.
 *
 * 왜 필요한가: PRELUDE 는 손으로 관리하는 목록이라 새 표가 생겨도 아무 일도 안 일어난다.
 *   실제로 saved_facilities·user_coupons·merchant_timesales·admin_ingest_requests·app_events
 *   5개가 조용히 빠진 채로 "모든 테이블을 삭제한다"는 주석만 남아 있었다 — 리셋을 돌려도
 *   구 데이터가 살아남는, 아무도 모르는 부분 리셋이었다. 리뷰나 주석으로는 못 막는다.
 *
 * 반대 방향(PRELUDE 에만 있고 migrations 엔 없는 DROP)은 실패로 보지 않는다 —
 * get_auth_user_info 처럼 구 DB 잔재를 정리하는 DROP 은 정당하다.
 */
function assertPreludeCoversTables(bodiesByFile) {
  const dropped = new Set(
    [...stripLineComments(PRELUDE).matchAll(DROP_TABLE_RE)].map((m) => m[1].toLowerCase())
  );
  const missing = new Map(); // 표 이름 → 그 표를 만든 마이그레이션 파일
  for (const [file, body] of bodiesByFile) {
    for (const m of stripLineComments(body).matchAll(CREATE_TABLE_RE)) {
      const table = m[1].toLowerCase();
      if (!dropped.has(table) && !missing.has(table)) missing.set(table, file);
    }
  }
  if (missing.size === 0) return;

  console.error(
    "DROP 프렐류드가 덮지 않는 테이블이 있습니다 — RESET 이 전체 리셋이 아니게 됩니다.\n" +
      [...missing].map(([t, f]) => `  - public.${t}  (migrations/${f})`).join("\n") +
      "\n\n고치는 법: scripts/build_reset.mjs 의 PRELUDE 에\n" +
      [...missing.keys()].map((t) => `  DROP TABLE IF EXISTS public.${t} CASCADE;`).join("\n") +
      "\n을 추가하세요. 위치는 'FK 자식 먼저, 부모 나중' 규칙을 따를 것" +
      "(users/facilities 를 참조하는 표는 그 둘보다 위)."
  );
  process.exit(1);
}

const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort(); // 타임스탬프 파일명 오름차순 = 적용 순서

if (migrations.length === 0) {
  console.error("supabase/migrations/ 에 .sql 파일이 없습니다.");
  process.exit(1);
}

const bodies = migrations.map((file) => [
  file,
  normalize(readFileSync(join(MIGRATIONS_DIR, file), "utf8")),
]);

// 산출물을 쓰기 **전에** 검증한다 — 실패한 채로 반쯤 낡은 RESET 을 남기지 않기 위해.
assertPreludeCoversTables(bodies);

const sections = bodies.map(
  ([file, body]) =>
    `\n\n-- ============================= migrations/${file} =============================\n${body}`
);

const output = `${HEADER}\n${PRELUDE}${sections.join("")}\n`;

writeFileSync(OUT_FILE, output, { encoding: "utf8" });
console.log(
  `supabase/RESET_AND_SETUP.sql 생성 완료 — 마이그레이션 ${migrations.length}개:\n` +
    migrations.map((f) => `  - ${f}`).join("\n")
);
