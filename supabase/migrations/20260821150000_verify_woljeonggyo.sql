-- 월정교는 초기 데모 좌표가 실제 교량에서 약 286m 벗어나 있었다.
-- 경주시·한국관광공사가 안내하는 주소(경주시 교동 274)와 일치하는
-- Kakao Local의 유일한 경주 월정교 장소를 수동 검증해 운영 장소로 승격한다.
UPDATE public.facilities
SET latitude = 35.82929954620109,
    longitude = 129.21812129691938,
    address = '경북 경주시 교동 274',
    operating_hours = '{"weekday":"09:00-22:00","weekend":"09:00-22:00"}'::jsonb,
    is_active = true,
    features = (
        COALESCE(features, '{}'::jsonb)
        - 'deactivation_reason'
        - 'deactivated_at'
    ) || jsonb_build_object(
        'production_eligible', true,
        'coordinate_source', 'kakao_manual_verified',
        'kakao_place_id', '1839209698',
        'kakao_place_url', 'https://place.map.kakao.com/1839209698',
        'coordinate_verified_at', '2026-08-21T15:00:00+09:00',
        'address_source', 'gyeongju_visitkorea',
        'opening_hours_source', 'visitkorea'
    ),
    updated_at = now()
WHERE id = 'f3000000-0000-0000-0000-000000000004'
  AND name = '월정교';
