-- 계정 삭제가 인증 신청 이력이 있는 계정에서 영구 실패하는 버그 수정.
--
-- 무엇이 깨져 있었나:
--   DELETE /api/v1/account/me (apps/api/app/routers/account.py) 는 auth.users 행을 지운다.
--   auth.users → public.users 는 ON DELETE CASCADE 이므로 public.users 행도 함께 지워진다.
--   그런데 20260827140000_rbac_roles_and_ownership.sql 이 만든 두 FK 가
--     facility_owners.user_id                  → public.users(id)   -- ON DELETE 절 없음
--     business_verification_requests.user_id   → public.users(id)   -- ON DELETE 절 없음
--   ON DELETE 절이 없으면 NO ACTION 이다. 즉 자식 행이 하나라도 남아 있으면 부모 삭제가
--   FK 위반으로 막힌다. 결과: **사업자/관리자 인증을 한 번이라도 신청한 계정은 탈퇴가
--   영원히 실패한다**(500). 신청을 철회(withdrawn)하거나 거절당해도 행은 남으므로 마찬가지다.
--   소유권을 받은 사장님 계정도 같은 이유로 탈퇴할 수 없다.
--
-- 이 마이그레이션의 목표는 단 하나 — **탈퇴가 실제로 성공하게 만드는 것**이다.
--
-- 나머지 users 참조 FK 는 이미 안전하다(전수 확인함):
--   CASCADE  — recommendations, user_feedback, user_preference_vectors, user_coupons,
--              saved_facilities, recommendation_outcomes, facility_availability_reports,
--              inquiries(20260825120000 에서 SET NULL → CASCADE 로 교체됨)
--   SET NULL — congestion_logs.reporter_user_id, facility_owners.granted_by,
--              business_verification_requests.reviewed_by, role_audit_log.actor_id
--   FK 없음  — app_events.user_id, admin_ingest_requests.requested_by (경량 로그 관례),
--              role_audit_log.target_id (⚠️ 의도적 — 아래 3절 참고),
--              facility_owners.verification_request_id
--              (컬럼만 있고 REFERENCES 가 없다. business_verification_requests 를 가리키는
--               FK 는 DB 어디에도 없으므로 이번 삭제 경로를 막지 않는다. 무결성이 느슨한
--               것은 별개 이슈이고, 지금 FK 를 새로 걸면 **없던 삭제 차단이 생기므로**
--               이 마이그레이션에서는 손대지 않는다.)
--
-- 멱등: 제약을 이름으로 추측하지 않고 카탈로그에서 실제 FK 를 찾아 지운 뒤 다시 만든다.
--   (두 FK 모두 CREATE TABLE 안의 인라인 REFERENCES 로 만들어져 마이그레이션 파일에
--    이름이 적혀 있지 않다 — 실제 이름은 PostgreSQL 기본 규칙인 <표>_<컬럼>_fkey 이지만,
--    이름이 다른 환경까지 덮도록 20260827140000 의 users_role_check 처리와 같은 DO 블록을 쓴다.)

-- =========================================================================
-- 1. business_verification_requests.user_id → ON DELETE CASCADE
-- =========================================================================
-- 왜 CASCADE 인가: 계정이 사라진 뒤의 신청 행은 감사 가치가 없다. 심사 결과(승인/거절)는
--   role_audit_log 에 'verification_review' 로 이미 따로 남아 있고(그쪽은 계정 삭제에
--   영향을 받지 않는다 — 3절), 이 표에 남는 것은 contact(연락처)·store_name(상호) 같은
--   **PII 뿐**이다. 탈퇴한 사용자의 연락처를 붙들고 있는 것은 감사가 아니라 유출 위험이다.
--   증빙 파일(document_path)은 심사 종료 시점에 이미 지워지는 정책이라 남을 것이 없다.
DO $$
DECLARE
    v_name TEXT;
BEGIN
    FOR v_name IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'public.business_verification_requests'::regclass
           AND contype = 'f'
           AND confrelid = 'public.users'::regclass
           AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (user_id)%'
    LOOP
        EXECUTE format(
            'ALTER TABLE public.business_verification_requests DROP CONSTRAINT %I', v_name
        );
    END LOOP;
END $$;

ALTER TABLE public.business_verification_requests
    ADD CONSTRAINT business_verification_requests_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- =========================================================================
-- 2. facility_owners.user_id → ON DELETE CASCADE (+ 이력은 role_audit_log 로 옮겨 보존)
-- =========================================================================
-- 여기는 판단이 다르다. 원래 주석("CASCADE 아님(의도적): 탈퇴해도 누가 언제 이 가게를
-- 관리했나 이력을 남긴다")은 옳은 문제의식이었지만, 그 전제였던 "탈퇴 처리는 행 삭제가
-- 아니라 revoked_at 갱신 + users 익명화로 한다(P1)" 가 **구현되지 않았다.** 실제 탈퇴
-- 경로는 auth.users 를 하드 삭제한다. 그래서 지금의 NO ACTION 은 이력을 지키는 게 아니라
-- 그냥 탈퇴를 막고 있을 뿐이다.
--
-- 검토한 대안:
--   (a) ON DELETE SET NULL — user_id 가 NOT NULL 이라 불가. NOT NULL 을 벗기면 가능은
--       하지만, 소유 이력에서 '누가'를 지우면 남는 건 "언제 어떤 가게에 누군지 모를
--       사람이 있었다"뿐이라 감사 가치가 사라진다. 게다가 부분 유니크 인덱스
--       facility_owners_active_uq (facility_id, user_id) WHERE revoked_at IS NULL 은
--       NULL 을 서로 다른 값으로 보므로 익명화된 활성 행이 무한히 쌓일 수 있다.
--   (b) FK 자체를 제거 — 삭제는 통과하지만 존재하지 않는 user_id 를 가리키는 행이
--       남는다. authz.require_facility_owner 는 revoked_at IS NULL 인 행으로 소유권을
--       판정하므로, 죽은 계정의 활성 소유 행을 남겨 두는 것은 권한 판정 경로에 쓰레기를
--       남기는 일이다. 무결성 없이 이력만 남기는 것도 정직하지 않다.
--   (c) ON DELETE RESTRICT / NO ACTION 유지 + 백엔드가 먼저 정리 — 지금 버그의 재생산이다.
--       탈퇴 API 한 곳에 정리 로직을 얹으면, 앞으로 생길 다른 삭제 경로마다 같은 걸
--       빠뜨린다(이번에 놓친 것과 똑같은 종류의 드리프트).
--
-- 결정: **(d) ON DELETE CASCADE + 삭제 직전에 role_audit_log 로 이력을 옮긴다.**
--   감사 기록을 담당하는 표는 원래부터 role_audit_log 다. 그 표의 target_id 는
--   **일부러 FK 가 없는 UUID** 이고 actor_id 는 ON DELETE SET NULL 이라, 계정이 삭제돼도
--   로그 줄은 그대로 남는다 — 즉 계정 수명과 무관하게 살아남도록 설계된 유일한 표다.
--   소유 이력을 그쪽으로 옮기면 "누가 언제 이 가게를 관리했나"는 보존되고, 권한 판정에
--   쓰이는 facility_owners 에는 죽은 행이 남지 않는다.
--   (dev.py 의 정상 회수 경로는 지금도 삭제가 아니라 revoked_at 갱신이므로 이 트리거를
--    타지 않는다. 여기서 잡는 것은 계정 삭제 연쇄 같은 **물리 삭제**뿐이다.)
CREATE OR REPLACE FUNCTION public.log_facility_owner_deletion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER  -- role_audit_log 는 RLS 가 켜져 있고 쓰기 정책이 service_role 전용이다.
                  -- 계정 삭제는 supabase_auth_admin 롤로 들어오므로 호출자 권한으로는
                  -- INSERT 가 막힌다. 표 소유자(postgres) 권한으로 실행해 그 벽을 넘는다.
SET search_path = public
AS $$
BEGIN
    -- ⚠️ 실패해도 삭제를 되돌리지 않는다. 이 마이그레이션의 목적 자체가 "탈퇴가 성공하게
    --    만드는 것"인데, 감사 로그 쓰기 실패로 탈퇴가 다시 막히면 본말전도다.
    --    (authz.log_role_audit 도 같은 원칙 — "실패해도 주 작업을 되돌리지 않되 경고로 남긴다".)
    BEGIN
        INSERT INTO public.role_audit_log (actor_id, target_id, action, from_value, reason)
        -- actor_id NULL = 시스템. from_value 에 facility_id 를 넣는 것은
        -- dev.py revoke_facility_owner 의 owner_revoke 기록 관례와 같다.
        VALUES (NULL, OLD.user_id, 'owner_revoke', OLD.facility_id::TEXT,
                'facility_owners 행 물리 삭제(계정 삭제 연쇄) — granted_at=' ||
                COALESCE(OLD.granted_at::TEXT, 'unknown') ||
                ', revoked_at=' || COALESCE(OLD.revoked_at::TEXT, 'active'));
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'role_audit_log 기록 실패(facility_owners 삭제는 계속 진행): %', SQLERRM;
    END;
    RETURN NULL;  -- AFTER 트리거의 반환값은 무시된다.
END $$;

DROP TRIGGER IF EXISTS log_facility_owner_deletion ON public.facility_owners;
CREATE TRIGGER log_facility_owner_deletion
    AFTER DELETE ON public.facility_owners
    FOR EACH ROW
    EXECUTE FUNCTION public.log_facility_owner_deletion();

DO $$
DECLARE
    v_name TEXT;
BEGIN
    FOR v_name IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'public.facility_owners'::regclass
           AND contype = 'f'
           AND confrelid = 'public.users'::regclass
           AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (user_id)%'
    LOOP
        EXECUTE format('ALTER TABLE public.facility_owners DROP CONSTRAINT %I', v_name);
    END LOOP;
END $$;

ALTER TABLE public.facility_owners
    ADD CONSTRAINT facility_owners_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- =========================================================================
-- 3. 왜 role_audit_log 는 손대지 않는가
-- =========================================================================
-- target_id 는 UUID NOT NULL 이면서 FK 가 없다. 실수처럼 보이지만 이 표에서는 그게 맞다 —
-- FK 를 걸면 (1) 계정 삭제가 또 막히거나 (2) CASCADE 로 감사 로그가 지워진다. 둘 다
-- "삭제 API 는 만들지 않는다"(dev.py)는 이 표의 존재 이유와 정면으로 충돌한다.
-- 감사 로그는 계정보다 오래 살아야 한다. 그대로 둔다.
