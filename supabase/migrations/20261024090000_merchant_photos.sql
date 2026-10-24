-- 사장님 가게 사진 — 사장님 콘솔에서 올린 사진을 카드의 첫 사진으로(디벨롭 로드맵 3, 10-24 PM: 바로 공개 · 관리자 사후 관리).
--
-- 왜 features.merchant_photo 인가: image_url 은 밤 TourAPI 적재가 '사진 없음 확정'이면 지운다(ingest_tourapi 의 clear_image)
-- — 사장님 사진을 거기 두면 다음 날 사라진다. features 는 적재가 {**기존, **새} 로 병합하므로 이 키가 남는다.
-- 화면 경로(추천 API·지도 API·Supabase 직접 읽기)는 모두 features 를 싣는다(지도 API 는 차단목록 방식 — 새 키는 내려간다).
--
-- 저장: 공개 버킷 facility-photos, 경로 = '<facility_id>/<파일>'. 올리기·지우기는 그 가게의 현재 사장님(facility_owners,
-- revoked_at IS NULL)만 — 관리자는 지우기도 된다. 읽기는 공개 URL(카드가 바로 띄운다).
-- 기록: set_merchant_photo(가게, 경로) — 가게 주인을 다시 확인하고 features.merchant_photo = {path, updated_at}.
-- 내리기: clear_merchant_photo(가게) — 그 가게 사장님 또는 관리자(is_admin_or_dev). 앞 경로를 돌려줘 웹이 파일도 지운다.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'facility-photos',
    'facility-photos',
    true,                                    -- 카드가 공개 URL 로 바로 띄운다.
    5242880,                                 -- 5MB — 휴대폰 사진 한 장.
    ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET public = true,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 경로의 첫 폴더가 지금 이 사람이 관리하는 가게 id 인가(스토리지 정책·RPC 공용).
CREATE OR REPLACE FUNCTION public.owns_facility_folder(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.facility_owners o
         WHERE o.user_id = auth.uid()
           AND o.revoked_at IS NULL
           AND o.facility_id::text = (storage.foldername(p_name))[1]
    );
$$;
REVOKE ALL ON FUNCTION public.owns_facility_folder(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owns_facility_folder(TEXT) TO authenticated;

DROP POLICY IF EXISTS facility_photos_insert_owner ON storage.objects;
CREATE POLICY facility_photos_insert_owner ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'facility-photos' AND public.owns_facility_folder(name));

-- 지우기(storage remove)는 그 객체를 볼 수 있어야 한다 — 사장님은 자기 가게 폴더만.
DROP POLICY IF EXISTS facility_photos_select_owner ON storage.objects;
CREATE POLICY facility_photos_select_owner ON storage.objects
    FOR SELECT TO authenticated
    USING (bucket_id = 'facility-photos' AND (public.owns_facility_folder(name) OR public.is_admin_or_dev()));

DROP POLICY IF EXISTS facility_photos_delete_owner ON storage.objects;
CREATE POLICY facility_photos_delete_owner ON storage.objects
    FOR DELETE TO authenticated
    USING (bucket_id = 'facility-photos' AND (public.owns_facility_folder(name) OR public.is_admin_or_dev()));

CREATE OR REPLACE FUNCTION public.set_merchant_photo(p_facility_id UUID, p_path TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_photo JSONB;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.facility_owners
         WHERE facility_id = p_facility_id AND user_id = auth.uid() AND revoked_at IS NULL
    ) THEN
        RAISE EXCEPTION 'not_facility_owner' USING ERRCODE = '42501';
    END IF;
    IF p_path IS NULL
       OR char_length(p_path) > 200
       OR split_part(p_path, '/', 1) <> p_facility_id::text
       OR position('..' IN p_path) > 0 THEN
        RAISE EXCEPTION 'invalid_photo_path' USING ERRCODE = '22023';
    END IF;
    v_photo := jsonb_build_object('path', p_path, 'updated_at', now());
    UPDATE public.facilities
       SET features = COALESCE(features, '{}'::jsonb) || jsonb_build_object('merchant_photo', v_photo)
     WHERE id = p_facility_id;
    RETURN v_photo;
END;
$$;
REVOKE ALL ON FUNCTION public.set_merchant_photo(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_merchant_photo(UUID, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.clear_merchant_photo(p_facility_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_prev TEXT;
BEGIN
    IF NOT (
        EXISTS (
            SELECT 1 FROM public.facility_owners
             WHERE facility_id = p_facility_id AND user_id = auth.uid() AND revoked_at IS NULL
        )
        OR public.is_admin_or_dev()
    ) THEN
        RAISE EXCEPTION 'not_facility_owner' USING ERRCODE = '42501';
    END IF;
    SELECT features -> 'merchant_photo' ->> 'path' INTO v_prev FROM public.facilities WHERE id = p_facility_id;
    UPDATE public.facilities SET features = features - 'merchant_photo' WHERE id = p_facility_id;
    RETURN v_prev;
END;
$$;
REVOKE ALL ON FUNCTION public.clear_merchant_photo(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clear_merchant_photo(UUID) TO authenticated;

-- 적용 후 SQL Editor 에서 `NOTIFY pgrst, 'reload schema';` — RPC 두 개를 PostgREST 가 봐야 콘솔이 부를 수 있다.
--
-- 관리자 사후 내리기(문제 사진): select public.clear_merchant_photo('<facility_id>');  -- 관리자 계정 세션에서
-- 또는 SQL Editor(서비스 역할): update public.facilities set features = features - 'merchant_photo' where id = '<facility_id>';
