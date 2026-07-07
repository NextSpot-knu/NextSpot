-- users.preference_note 추가 (2026-07-07) — docs/IMPROVEMENT_PLAN.md WS-B-6 / §1 D2
-- 원래 apps/api/sql/add_preference_note.sql 로 방치되어 있던 고아 SQL을
-- D2 결정(migrations/ 단일 소스 오브 트루스)에 따라 정식 마이그레이션으로 승격했다.
-- (승격 전에는 신규 셋업에서 이 컬럼이 조용히 누락되어 자연어 선호 기능의 DB 보존이 실패했다.)
--
-- 자연어 선호 기능(선택): 사용자가 말한 원문 + AI 요약을 보관할 컬럼.
-- 없어도 동작한다(서버가 저장 실패를 무시함).
--
--   POST /api/v1/preferences/parse 가 다음 형태로 기록:
--   { "text": "조용한 한옥카페 선호", "summary": "카페 중심으로 조용한 곳 선호로 이해했어요." }

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS preference_note jsonb;
