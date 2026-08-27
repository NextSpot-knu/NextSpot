-- 기존 계정 로그인 시 소유 증명된 익명 계정 데이터를 한 트랜잭션으로 승계한다.
-- target의 기존 취향/프로필/중복 북마크·쿠폰을 우선 보존하고, target에 없는 데이터만 이동한다.

-- 계정 삭제 시 문의의 작성자 연결만 끊고 본문을 남기던 SET NULL을 제거한다. 사용자의 탈퇴 요청은
-- 해당 계정이 작성한 문의까지 함께 삭제해야 하므로 auth.users → public.users 삭제에 연쇄한다.
ALTER TABLE public.inquiries DROP CONSTRAINT IF EXISTS inquiries_user_id_fkey;
ALTER TABLE public.inquiries
    ADD CONSTRAINT inquiries_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.merge_guest_account_data(
    p_guest_user_id UUID,
    p_target_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    guest_profile public.users%ROWTYPE;
    target_profile public.users%ROWTYPE;
    recommendations_count INTEGER := 0;
    feedback_count INTEGER := 0;
    outcomes_count INTEGER := 0;
    saved_count INTEGER := 0;
    coupons_count INTEGER := 0;
    reports_count INTEGER := 0;
    inquiries_count INTEGER := 0;
    vector_moved BOOLEAN := FALSE;
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
    END IF;
    IF p_guest_user_id IS NULL OR p_target_user_id IS NULL THEN
        RAISE EXCEPTION 'user ids are required' USING ERRCODE = '22023';
    END IF;
    IF p_guest_user_id = p_target_user_id THEN
        RETURN jsonb_build_object(
            'recommendations', 0, 'user_feedback', 0, 'recommendation_outcomes', 0,
            'saved_facilities', 0, 'user_coupons', 0, 'congestion_reports', 0,
            'inquiries', 0, 'preference_vector_moved', FALSE
        );
    END IF;

    -- 두 프로필을 결정적 순서로 잠가 동시 병합에서도 부분 상태가 보이지 않게 한다.
    PERFORM 1
      FROM public.users
     WHERE id IN (p_guest_user_id, p_target_user_id)
     ORDER BY id
     FOR UPDATE;

    SELECT * INTO guest_profile FROM public.users WHERE id = p_guest_user_id;
    SELECT * INTO target_profile FROM public.users WHERE id = p_target_user_id;
    IF guest_profile.id IS NULL OR target_profile.id IS NULL THEN
        RAISE EXCEPTION 'guest or target profile not found' USING ERRCODE = 'P0002';
    END IF;

    UPDATE public.recommendations SET user_id = p_target_user_id WHERE user_id = p_guest_user_id;
    GET DIAGNOSTICS recommendations_count = ROW_COUNT;

    UPDATE public.user_feedback SET user_id = p_target_user_id WHERE user_id = p_guest_user_id;
    GET DIAGNOSTICS feedback_count = ROW_COUNT;

    UPDATE public.recommendation_outcomes SET user_id = p_target_user_id WHERE user_id = p_guest_user_id;
    GET DIAGNOSTICS outcomes_count = ROW_COUNT;

    -- 같은 장소를 양쪽 계정이 저장/발급받은 경우 기존 계정 행을 진실로 유지한다.
    DELETE FROM public.saved_facilities AS guest_saved
     USING public.saved_facilities AS target_saved
     WHERE guest_saved.user_id = p_guest_user_id
       AND target_saved.user_id = p_target_user_id
       AND guest_saved.facility_id = target_saved.facility_id;
    UPDATE public.saved_facilities SET user_id = p_target_user_id WHERE user_id = p_guest_user_id;
    GET DIAGNOSTICS saved_count = ROW_COUNT;

    DELETE FROM public.user_coupons AS guest_coupon
     USING public.user_coupons AS target_coupon
     WHERE guest_coupon.user_id = p_guest_user_id
       AND target_coupon.user_id = p_target_user_id
       AND guest_coupon.facility_id = target_coupon.facility_id;
    UPDATE public.user_coupons SET user_id = p_target_user_id WHERE user_id = p_guest_user_id;
    GET DIAGNOSTICS coupons_count = ROW_COUNT;

    -- 기존 계정의 학습 벡터가 있으면 보존하고, 없을 때만 게스트 벡터를 승계한다.
    IF EXISTS (SELECT 1 FROM public.user_preference_vectors WHERE user_id = p_target_user_id) THEN
        DELETE FROM public.user_preference_vectors WHERE user_id = p_guest_user_id;
    ELSE
        UPDATE public.user_preference_vectors
           SET user_id = p_target_user_id
         WHERE user_id = p_guest_user_id;
        vector_moved := FOUND;
    END IF;

    UPDATE public.congestion_logs
       SET reporter_user_id = p_target_user_id
     WHERE reporter_user_id = p_guest_user_id;
    GET DIAGNOSTICS reports_count = ROW_COUNT;

    UPDATE public.inquiries SET user_id = p_target_user_id WHERE user_id = p_guest_user_id;
    GET DIAGNOSTICS inquiries_count = ROW_COUNT;

    -- 기존 계정에 값이 없을 때만 게스트 프로필/초기 취향을 채우며 제보 횟수는 합산한다.
    UPDATE public.users
       SET nickname = COALESCE(NULLIF(target_profile.nickname, ''), guest_profile.nickname),
           avatar_url = COALESCE(target_profile.avatar_url, guest_profile.avatar_url),
           visit_time_pref = COALESCE(target_profile.visit_time_pref, guest_profile.visit_time_pref),
           preferred_categories = CASE
               WHEN target_profile.preferred_categories IS NULL
                 OR target_profile.preferred_categories = '[]'::jsonb
               THEN COALESCE(guest_profile.preferred_categories, '[]'::jsonb)
               ELSE target_profile.preferred_categories
           END,
           preference_note = COALESCE(target_profile.preference_note, guest_profile.preference_note),
           report_count = COALESCE(target_profile.report_count, 0) + COALESCE(guest_profile.report_count, 0)
     WHERE id = p_target_user_id;

    -- 재시도 시 제보 횟수가 다시 합산되지 않게 이미 승계한 게스트 프로필을 비운다.
    UPDATE public.users
       SET preferred_categories = '[]'::jsonb,
           preference_note = NULL,
           report_count = 0
     WHERE id = p_guest_user_id;

    RETURN jsonb_build_object(
        'recommendations', recommendations_count,
        'user_feedback', feedback_count,
        'recommendation_outcomes', outcomes_count,
        'saved_facilities', saved_count,
        'user_coupons', coupons_count,
        'congestion_reports', reports_count,
        'inquiries', inquiries_count,
        'preference_vector_moved', vector_moved
    );
END;
$$;

REVOKE ALL ON FUNCTION public.merge_guest_account_data(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_guest_account_data(UUID, UUID) TO service_role;
