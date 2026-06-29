-- =========================================================================
-- inquiries RLS 강화
-- =========================================================================
-- 배경: 20260531220000_add_inquiries_table.sql 의 "Allow all select/update/delete"
--   정책이 FOR ALL USING(true) 로 역할 한정 없이 선언돼, anon 키만으로 모든 사용자의 문의
--   (user_name/content 등 PII)를 조회·수정·삭제할 수 있었다(특히 무제한 DELETE = 데이터 유실 위험).
--
-- 조치: 과도한 FOR ALL 정책을 제거하고 SELECT/UPDATE 로만 좁힌다. DELETE 정책은 두지 않아
--   기본 거부(default deny)가 되게 한다 — 현재 어떤 UI 흐름도 inquiries DELETE 를 쓰지 않으므로
--   동작 보존. admin/support·mypage/support 의 조회·상태변경(resolve)·익명 insert 는 그대로 유지된다.
--
-- 적용: Supabase SQL Editor 또는 `supabase db push` 로 1회 실행(재실행해도 안전).

DROP POLICY IF EXISTS "Allow all select/update/delete on inquiries" ON public.inquiries;
DROP POLICY IF EXISTS "Allow select on inquiries" ON public.inquiries;
DROP POLICY IF EXISTS "Allow update on inquiries" ON public.inquiries;

CREATE POLICY "Allow select on inquiries"
ON public.inquiries FOR SELECT
USING (true);

CREATE POLICY "Allow update on inquiries"
ON public.inquiries FOR UPDATE
USING (true) WITH CHECK (true);
