-- 계정 역할 변경 신청 — business_verification_requests 를 '사업자 전용'에서 '역할 신청' 큐로 넓힌다.
--
-- 왜 새 표를 만들지 않는가:
--   신청 → 개발자 심사 → 역할 임명 + 감사 로그의 파이프라인이 이미 여기 다 있다. 표를 하나 더
--   만들면 심사 화면·승인 로직·RLS·증빙 삭제 정책을 통째로 두 벌 유지해야 하고, 두 큐 중
--   어느 쪽을 봐야 하는지 개발자가 매번 판단해야 한다. 컬럼 하나가 정직하고 싸다.
--
-- 어떤 역할까지 신청 대상인가:
--   merchant — 가게 사장님. 기존 사업자 인증 그대로다(가게 매핑 + 소유권 부여가 따라온다).
--   admin    — 정부기관 관제 담당자. 소속 확인은 오프라인이고, 시스템은 요청·결정만 기록한다.
--   developer 는 **넣지 않는다.** 팀 내부 권한이라 신청 대상이 아니며, 신청으로 얻을 수 있게
--   두면 심사 실수 한 번이 곧 전체 권한 위임이 된다. 개발자 임명은 /dev 콘솔에서 직접 한다.
--
-- 기존 행은 전부 사업자 신청이므로 DEFAULT 'merchant' 가 곧 정확한 백필이다.
--
-- 멱등: 재실행 가능(ADD COLUMN IF NOT EXISTS + 제약은 이름으로 확인 후 추가).

ALTER TABLE public.business_verification_requests
    ADD COLUMN IF NOT EXISTS requested_role TEXT NOT NULL DEFAULT 'merchant';

-- CHECK 은 따로 붙인다. ADD COLUMN IF NOT EXISTS 의 인라인 CHECK 은 컬럼이 이미 있으면
-- 통째로 건너뛰어, 컬럼만 먼저 만들어진 환경에 제약이 영영 안 붙는다.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.business_verification_requests'::regclass
           AND conname = 'bvr_requested_role_check'
    ) THEN
        ALTER TABLE public.business_verification_requests
            ADD CONSTRAINT bvr_requested_role_check
            CHECK (requested_role IN ('merchant', 'admin'));
    END IF;
END $$;

-- 심사 큐는 대기 → 오래된 순으로 본다. 역할별로 나눠 보는 화면이 생겼으므로 인덱스도 맞춘다.
CREATE INDEX IF NOT EXISTS bvr_role_status_idx
    ON public.business_verification_requests (requested_role, status, created_at);

-- 한 사용자가 pending 을 여러 개 쌓지 못하게 막는 기존 부분 유니크 인덱스 2개는
-- (user_id, facility_id) / (user_id, lower(store_name)) 기준이라 그대로 둔다.
-- 관리자 신청은 facility_id 가 NULL 이고 store_name 에 소속 기관명이 들어가므로
-- freeform 인덱스에 걸린다 — 같은 소속으로 두 번 신청하는 것만 막히고, 사업자 신청과는
-- store_name 이 달라 충돌하지 않는다. 의도한 동작이다.

-- INSERT RLS 정책(bvr_insert_own)은 status/reviewed_* 만 검사하므로 새 컬럼의 영향이 없다.
-- 실제 쓰기는 어차피 service_role(백엔드 /api/v1/account)이 한다.
