-- inquiries INSERT 정책의 신원 위조 구멍 차단.
--
-- 무엇이 깨져 있었나:
--   20260531220000_add_inquiries_table.sql 의
--     CREATE POLICY "Allow anonymous or auth inserts on inquiries"
--       ON public.inquiries FOR INSERT WITH CHECK (true);
--   에는 TO 절도, 소유권 조건도 없다. WITH CHECK (true) 는 "무엇이든 통과"라는 뜻이므로
--   anon 키만 있으면(프런트 번들에 들어 있다) **아무나 남의 user_id 로 문의를 넣을 수 있다.**
--   그 문의는 관리자 화면(/admin/support)에 피해자가 보낸 것처럼 뜨고,
--   select_own_or_admin_inquiries 때문에 정작 피해자 본인의 '내 문의' 목록에도 나타난다.
--   또 SELECT/UPDATE 는 20260601120000·20260707120000 에서 이미 조여졌는데 INSERT 만
--   그때 함께 조여지지 않고 남아 있었다 — 하드닝의 누락분이다.
--
-- 익명 문의 경로는 유지해야 한다(로그인 없이도 문의할 수 있어야 한다). 다행히
-- inquiries.user_id 는 처음부터 NULL 허용 컬럼이고(초기 정의에 NOT NULL 이 없고, 이후
-- 어떤 마이그레이션도 NOT NULL 을 붙이지 않았다 — 20260825120000 은 FK 의 ON DELETE 만
-- SET NULL → CASCADE 로 바꿨다), 그래서 "NULL 이거나 본인" 형태를 쓸 수 있다.
--
-- 멱등: DROP POLICY IF EXISTS → CREATE POLICY.

-- 구 정책 제거. 이름에 공백이 있어 큰따옴표가 필요하다.
DROP POLICY IF EXISTS "Allow anonymous or auth inserts on inquiries" ON public.inquiries;

DROP POLICY IF EXISTS inquiries_insert_own_or_anonymous ON public.inquiries;
CREATE POLICY inquiries_insert_own_or_anonymous ON public.inquiries
    FOR INSERT TO anon, authenticated
    -- user_id IS NULL  = 익명 문의(세션 없이 보낸 문의).
    -- user_id = auth.uid() = 로그인/익명세션 사용자의 본인 문의.
    -- 그 외(남의 uid)는 거부된다. 앱은 익명 세션(signInAnonymously)을 쓰므로 대부분
    -- 두 번째 가지를 타고, 익명 세션 부팅이 실패한 경우에만 첫 번째 가지로 떨어진다.
    WITH CHECK (user_id IS NULL OR user_id = auth.uid());

-- service_role(백엔드 admin 라우터)용 명시 정책 — 다른 표들(user_coupons, saved_facilities,
-- facility_owners …)이 모두 갖고 있는 *_service_all 관례를 여기에도 맞춘다.
-- 구 정책은 TO 절이 없어 PUBLIC(=service_role 포함)에 적용됐다. 위에서 TO anon, authenticated
-- 로 좁혔으므로, service_role 의 BYPASSRLS 에만 기대지 않도록 명시적으로 열어 둔다.
DROP POLICY IF EXISTS inquiries_service_all ON public.inquiries;
CREATE POLICY inquiries_service_all ON public.inquiries
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ⚠️ 프런트와 한 세트다. apps/web/app/mypage/support/page.tsx 가 로그아웃 상태에서
--    하드코딩 UUID(a2222222-…)를 보내고 있었다. 이 정책이 적용되면 그 INSERT 는 거부된다.
--    같은 커밋에서 "세션 있으면 실제 uid, 없으면 NULL" 로 고쳤다.
