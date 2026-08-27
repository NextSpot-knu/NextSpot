-- 사장님 콘솔 개편 P0 — 4단계 계정 역할(RBAC) + 가게 소유권 스키마.
-- 계획: docs/MERCHANT_CONSOLE_RBAC_PLAN.md (로컬 전용 문서)
--
-- 이 마이그레이션은 **스키마만** 만든다. 기존 동작은 1비트도 바뀌지 않는다 —
-- 아무도 새 역할이 아니고(전원 'tourist'), 새 표는 비어 있으며, 백엔드는 아직 이걸 읽지 않는다.
-- 가드 교체는 P1(백엔드), 화면은 P2 에서 한다.
--
-- 왜 하는가(1순위 동기는 UX 가 아니라 보안):
--   POST /api/v1/merchant/seat-status 와 /merchant/timesale 이 본문의 facility_id 를 그대로
--   신뢰한다. 공유 토큰(프런트 번들에 포함, 기본값 공개)만 있으면 **누구나 아무 가게의**
--   좌석 상태를 방송할 수 있고, 그 방송은 congestion_logs 에 evidence_tier='verified' 로
--   기록된다 — 모델 승격 게이트가 학습에 쓰는 유일한 등급이다(CONGESTION_TRUST_SPEC).
--   즉 외부인이 학습 데이터를 오염시킬 수 있는 경로가 열려 있다. facility_owners 가 그 구멍을 닫는다.
--
-- 멱등: 재실행 가능(IF NOT EXISTS / DROP ... IF EXISTS 후 CREATE).

-- =========================================================================
-- 1. users.role 을 4단계로 확장
-- =========================================================================
-- 기존 CHECK 는 ('tourist','admin') 2종이었다. 제약 이름은 컬럼 정의 시 자동 생성된
-- users_role_check 다(초기 마이그레이션의 인라인 CHECK). 이름이 다른 환경도 있을 수 있어
-- DO 블록으로 실제 이름을 찾아 지운다.
DO $$
DECLARE
    v_constraint TEXT;
BEGIN
    SELECT conname INTO v_constraint
      FROM pg_constraint
     WHERE conrelid = 'public.users'::regclass
       AND contype = 'c'
       -- 'tourist' 로 매칭한다: users 에는 visit_time_pref 등 다른 CHECK 도 있어
       -- '%role%' 로 찾으면 엉뚱한 제약을 지울 수 있다. 새로 만드는 제약도 'tourist' 를
       -- 포함하므로 재실행 시 자기 자신을 찾아 지운다 → 멱등.
       AND pg_get_constraintdef(oid) ILIKE '%tourist%'
     LIMIT 1;
    IF v_constraint IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.users DROP CONSTRAINT %I', v_constraint);
    END IF;
END $$;

ALTER TABLE public.users
    ADD CONSTRAINT users_role_check
    CHECK (role IN ('tourist', 'merchant', 'admin', 'developer'));

-- developer 는 admin 의 상위집합이다. 기존 RLS 8곳의 `get_auth_user_role() = 'admin'` 을
-- 이 헬퍼로 바꿔 developer 도 통과하게 한다(정책 교체는 아래 4절).
CREATE OR REPLACE FUNCTION public.is_admin_or_dev()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT public.get_auth_user_role() IN ('admin', 'developer');
$$;

-- =========================================================================
-- 2. users 의 민감 컬럼을 클라이언트가 직접 못 바꾸게 (트리거)
-- =========================================================================
-- 기존 update_users 정책은 `id = auth.uid()` 만 본다 → 본인이 role 을 바꿀 수 있다.
-- (RESET_AND_SETUP 후반의 재정의본은 role 을 잠갔지만, 정책은 컬럼 단위 제어가 없어
--  앞으로 추가될 민감 컬럼마다 정책을 고쳐야 한다.) 트리거로 한 곳에 모은다.
--
-- 막을 대상은 **클라이언트 경유 두 롤(authenticated·anon)** 뿐이다. 그 외(service_role =
-- 백엔드, postgres = SQL Editor 부트스트랩)는 통과시킨다.
--
-- ⚠️ SECURITY INVOKER(기본값)여야 한다. SECURITY DEFINER 로 두면 함수 안에서 current_user 가
--    **함수 소유자**로 바뀌어 호출자 롤을 알 수 없다 — service_role 백엔드와 SQL Editor 의
--    최초 developer 지정이 둘 다 막힌다. 이 함수는 OLD/NEW 비교만 하므로 권한 상승이 필요 없다.
CREATE OR REPLACE FUNCTION public.guard_users_privileged_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;
    IF NEW.role IS DISTINCT FROM OLD.role THEN
        RAISE EXCEPTION 'role 은 직접 변경할 수 없습니다(백엔드 전용)';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS guard_users_privileged_columns ON public.users;
CREATE TRIGGER guard_users_privileged_columns
    BEFORE UPDATE ON public.users
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_users_privileged_columns();

-- =========================================================================
-- 3. facility_owners — 가게 소유권 (역할과 별개의 축)
-- =========================================================================
-- 'merchant' 역할은 "콘솔에 들어갈 수 있다"만 뜻한다. **어느 가게를 관리하는가**는 여기서 정한다.
-- 한 사장님이 여러 지점을, 한 가게에 여러 계정(공동창업자)이 붙을 수 있다.
-- 직원(staff) 계정은 만들지 않기로 했으므로 member_role 컬럼은 두지 않는다.
CREATE TABLE IF NOT EXISTS public.facility_owners (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id  UUID NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
    -- ⚠️ CASCADE 아님(의도적): 탈퇴해도 "누가 언제 이 가게를 관리했나" 이력을 남긴다.
    --    좌석 방송이 verified 학습 데이터가 되는 이상 감사 대상이다. 탈퇴 처리는
    --    행 삭제가 아니라 revoked_at 갱신 + users 익명화로 한다(P1).
    user_id      UUID NOT NULL REFERENCES public.users(id),
    granted_by   UUID REFERENCES public.users(id) ON DELETE SET NULL,
    granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at   TIMESTAMPTZ,
    verification_request_id UUID,
    note         TEXT
);

-- 같은 (가게, 사용자)의 **활성** 행은 하나만. 회수 후 재부여는 가능하다.
CREATE UNIQUE INDEX IF NOT EXISTS facility_owners_active_uq
    ON public.facility_owners (facility_id, user_id) WHERE revoked_at IS NULL;
-- '내 가게 목록' 조회 경로.
CREATE INDEX IF NOT EXISTS facility_owners_user_idx
    ON public.facility_owners (user_id) WHERE revoked_at IS NULL;
-- 소유권 검사(가게 → 소유자) 경로.
CREATE INDEX IF NOT EXISTS facility_owners_facility_idx
    ON public.facility_owners (facility_id) WHERE revoked_at IS NULL;

ALTER TABLE public.facility_owners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS facility_owners_service_all ON public.facility_owners;
CREATE POLICY facility_owners_service_all ON public.facility_owners
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 읽기만 허용한다. 쓰기(부여/회수)는 백엔드 /dev 경로 전용 — 프런트 직접 INSERT 금지.
DROP POLICY IF EXISTS facility_owners_select_own ON public.facility_owners;
CREATE POLICY facility_owners_select_own ON public.facility_owners
    FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR public.is_admin_or_dev());

-- =========================================================================
-- 4. business_verification_requests — 사업자 인증 요청
-- =========================================================================
-- 오프라인 인증(개발자에게 연락 → 실물 증거 확인)은 유지하되, 요청·심사·결과를 시스템이 기록한다.
-- 승인 한 번으로 역할 임명 + 소유권 부여가 원자적으로 처리되고 감사 이력이 남는다.
--
-- ⚠️ 증빙 보관 정책: 인증이 끝나면 보관하지 않는다. 승인·거절·철회 어느 쪽이든 결정과
--    같은 트랜잭션에서 Storage 파일을 지우고 document_path·business_number_last4 를 NULL 로
--    비운다(P1 백엔드). 사업자등록번호 **전체**는 어느 시점에도 저장하지 않는다.
CREATE TABLE IF NOT EXISTS public.business_verification_requests (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES public.users(id),
    -- 기존 POI 선택(권장). 없으면 store_name 자유 입력으로 받고 개발자가 나중에 매핑한다.
    facility_id   UUID REFERENCES public.facilities(id) ON DELETE SET NULL,
    store_name    TEXT NOT NULL,
    -- 연락처는 필수다: 아이디 계정·카카오 계정은 이메일이 없을 수 있다.
    contact       TEXT NOT NULL,
    business_number_last4 TEXT CHECK (business_number_last4 IS NULL OR business_number_last4 ~ '^[0-9]{4}$'),
    document_path TEXT,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
    reviewed_by   UUID REFERENCES public.users(id) ON DELETE SET NULL,
    reviewed_at   TIMESTAMPTZ,
    review_note   TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 한 사용자가 같은 가게에 pending 을 여러 개 쌓지 못하게. facility_id 가 NULL 인
-- 자유 입력 요청은 이 인덱스에 걸리지 않으므로 store_name 기준으로 따로 막는다.
CREATE UNIQUE INDEX IF NOT EXISTS bvr_pending_facility_uq
    ON public.business_verification_requests (user_id, facility_id)
    WHERE status = 'pending' AND facility_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS bvr_pending_freeform_uq
    ON public.business_verification_requests (user_id, lower(store_name))
    WHERE status = 'pending' AND facility_id IS NULL;
-- 개발자 심사 큐(대기 먼저, 오래된 순).
CREATE INDEX IF NOT EXISTS bvr_status_idx
    ON public.business_verification_requests (status, created_at);

ALTER TABLE public.business_verification_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bvr_service_all ON public.business_verification_requests;
CREATE POLICY bvr_service_all ON public.business_verification_requests
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 본인 요청 조회 + 관리자/개발자는 전체 조회(관리자는 '신청 현황' 읽기 전용).
DROP POLICY IF EXISTS bvr_select_own_or_staff ON public.business_verification_requests;
CREATE POLICY bvr_select_own_or_staff ON public.business_verification_requests
    FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR public.is_admin_or_dev());

-- 본인 요청 생성 — pending 으로만. 심사 필드는 손댈 수 없다.
DROP POLICY IF EXISTS bvr_insert_own ON public.business_verification_requests;
CREATE POLICY bvr_insert_own ON public.business_verification_requests
    FOR INSERT TO authenticated
    WITH CHECK (
        user_id = auth.uid()
        AND status = 'pending'
        AND reviewed_by IS NULL
        AND reviewed_at IS NULL
    );

-- 본인 철회만. 승인/거절은 service_role(개발자 API) 전용이다.
DROP POLICY IF EXISTS bvr_withdraw_own ON public.business_verification_requests;
CREATE POLICY bvr_withdraw_own ON public.business_verification_requests
    FOR UPDATE TO authenticated
    USING (user_id = auth.uid() AND status = 'pending')
    WITH CHECK (user_id = auth.uid() AND status = 'withdrawn');

-- =========================================================================
-- 5. role_audit_log — 권한 변경 감사
-- =========================================================================
-- 모든 임명·회수·심사는 백엔드가 여기 한 줄씩 남긴다. **삭제 API 는 만들지 않는다.**
-- actor_id NULL = 시스템/최초 SQL 부트스트랩(첫 developer 지정).
CREATE TABLE IF NOT EXISTS public.role_audit_log (
    id          BIGSERIAL PRIMARY KEY,
    actor_id    UUID REFERENCES public.users(id) ON DELETE SET NULL,
    target_id   UUID NOT NULL,
    action      TEXT NOT NULL
                CHECK (action IN ('role_change', 'owner_grant', 'owner_revoke', 'verification_review')),
    from_value  TEXT,
    to_value    TEXT,
    reason      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS role_audit_log_target_idx
    ON public.role_audit_log (target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS role_audit_log_created_idx
    ON public.role_audit_log (created_at DESC);

ALTER TABLE public.role_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_audit_log_service_all ON public.role_audit_log;
CREATE POLICY role_audit_log_service_all ON public.role_audit_log
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 읽기는 관리자·개발자만. 쓰기 정책은 두지 않는다(service_role 전용).
DROP POLICY IF EXISTS role_audit_log_select_staff ON public.role_audit_log;
CREATE POLICY role_audit_log_select_staff ON public.role_audit_log
    FOR SELECT TO authenticated
    USING (public.is_admin_or_dev());

-- =========================================================================
-- 6. system_settings.merchant_console_enabled — 사고 시 콘솔 즉시 차단 스위치
-- =========================================================================
-- FALSE 면 /merchant/* 전 엔드포인트가 503 을 돌려준다(maintenance_mode 패턴).
ALTER TABLE public.system_settings
    ADD COLUMN IF NOT EXISTS merchant_console_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- =========================================================================
-- 7. 기존 admin 전용 RLS 를 is_admin_or_dev() 로 교체
-- =========================================================================
-- developer 가 admin 의 상위집합이 되도록. 정책 본문은 그대로고 판정 함수만 바꾼다.
DROP POLICY IF EXISTS select_users ON public.users;
CREATE POLICY select_users ON public.users FOR SELECT TO authenticated
    USING (id = auth.uid() OR public.is_admin_or_dev());

DROP POLICY IF EXISTS admin_all_facilities ON public.facilities;
CREATE POLICY admin_all_facilities ON public.facilities FOR ALL TO authenticated
    USING (public.is_admin_or_dev())
    WITH CHECK (public.is_admin_or_dev());

DROP POLICY IF EXISTS select_own_or_admin_inquiries ON public.inquiries;
CREATE POLICY select_own_or_admin_inquiries ON public.inquiries FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR public.is_admin_or_dev());

DROP POLICY IF EXISTS admin_update_inquiries ON public.inquiries;
CREATE POLICY admin_update_inquiries ON public.inquiries FOR UPDATE TO authenticated
    USING (public.is_admin_or_dev())
    WITH CHECK (public.is_admin_or_dev());

DROP POLICY IF EXISTS admin_all_logs ON public.congestion_logs;
CREATE POLICY admin_all_logs ON public.congestion_logs FOR ALL TO authenticated
    USING (public.is_admin_or_dev())
    WITH CHECK (public.is_admin_or_dev());

DROP POLICY IF EXISTS select_recommendations ON public.recommendations;
CREATE POLICY select_recommendations ON public.recommendations FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR public.is_admin_or_dev());

DROP POLICY IF EXISTS select_feedback ON public.user_feedback;
CREATE POLICY select_feedback ON public.user_feedback FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR public.is_admin_or_dev());

DROP POLICY IF EXISTS admin_update_settings ON public.system_settings;
CREATE POLICY admin_update_settings ON public.system_settings
    FOR UPDATE TO authenticated
    USING (public.is_admin_or_dev())
    WITH CHECK (public.is_admin_or_dev());
