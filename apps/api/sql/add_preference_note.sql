-- 자연어 선호 기능(선택): 근로자가 말한 원문 + AI 요약을 보관할 컬럼.
-- 없어도 동작한다(서버가 저장 실패를 무시함). 보관·관리자 화면 표시를 원하면 Supabase SQL 에디터에서 1회 실행.
--
--   POST /api/v1/preferences/parse 가 다음 형태로 기록:
--   { "text": "조용한 회의실 선호", "summary": "회의실 중심으로 조용한 곳 선호로 이해했어요." }

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS preference_note jsonb;
