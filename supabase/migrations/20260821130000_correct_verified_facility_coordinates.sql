-- Kakao Local의 유일한 엄격 동명 후보로 확인된 교촌마을 좌표를 교정한다.
-- 월정교·발명체험교육관은 동명/명칭변경 가능성이 있어 자동 수정하지 않는다.
UPDATE public.facilities
SET latitude = 35.8300213535354,
    longitude = 129.217092468907,
    features = COALESCE(features, '{}'::jsonb) || jsonb_build_object(
        'coordinate_source', 'kakao',
        'kakao_place_id', '25182534',
        'kakao_place_url', 'https://place.map.kakao.com/25182534',
        'coordinate_verified_at', '2026-08-21T00:00:00+09:00'
    ),
    updated_at = now()
WHERE id = 'f4000000-0000-0000-0000-000000000002';
