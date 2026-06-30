-- 0. Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- NOTE: auth.users is managed by Supabase and already exists in cloud.

-- 1. users 테이블 (Supabase Auth 확장 · 관광객 프로필)
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    nickname VARCHAR(100),                                   -- 관광객 닉네임(선택)
    preferred_categories JSONB DEFAULT '[]'::jsonb,          -- 선호 카테고리(restaurant/cafe/attraction/culture)
    visit_time_pref VARCHAR(20) CHECK (visit_time_pref IN ('morning', 'afternoon', 'evening')),  -- 선호 방문 시간대
    role VARCHAR(20) DEFAULT 'tourist' CHECK (role IN ('tourist', 'admin')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. facilities 테이블 (관광 POI)
CREATE TABLE IF NOT EXISTS public.facilities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('restaurant', 'cafe', 'attraction', 'culture')),
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    capacity INT NOT NULL,                                   -- 수용 추정치(좌석/적정 동시 수용 인원)
    operating_hours JSONB DEFAULT '{}'::jsonb,
    features JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. congestion_logs 테이블 (혼잡도 이력)
CREATE TABLE IF NOT EXISTS public.congestion_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id UUID NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    current_count INT NOT NULL,
    congestion_level DOUBLE PRECISION NOT NULL CHECK (congestion_level >= 0.0 AND congestion_level <= 1.0),
    source VARCHAR(50) NOT NULL CHECK (source IN ('traffic_cctv', 'tour_api', 'event', 'user_report'))
);

-- 4. recommendations 테이블 (추천 이력)
CREATE TABLE IF NOT EXISTS public.recommendations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    original_facility_id UUID NOT NULL REFERENCES public.facilities(id) ON DELETE SET NULL,
    recommended_facility_id UUID NOT NULL REFERENCES public.facilities(id) ON DELETE SET NULL,
    spot_score DOUBLE PRECISION NOT NULL,
    score_breakdown JSONB DEFAULT '{}'::jsonb,
    accepted BOOLEAN DEFAULT FALSE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 5. user_feedback 테이블 (피드백 루프)
CREATE TABLE IF NOT EXISTS public.user_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    recommendation_id UUID NOT NULL REFERENCES public.recommendations(id) ON DELETE CASCADE,
    action VARCHAR(20) NOT NULL CHECK (action IN ('accepted', 'rejected', 'ignored')),
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- --- 인덱스 설정 ---
-- congestion_logs: (facility_id, timestamp DESC) 복합 인덱스
CREATE INDEX IF NOT EXISTS idx_congestion_logs_facility_time
ON public.congestion_logs (facility_id, timestamp DESC);

-- recommendations: user_id 인덱스
CREATE INDEX IF NOT EXISTS idx_recommendations_user_id
ON public.recommendations (user_id);

-- user_feedback: user_id 인덱스
CREATE INDEX IF NOT EXISTS idx_user_feedback_user_id
ON public.user_feedback (user_id);


-- --- 트리거 함수: updated_at 자동 업데이트 ---
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_modtime
    BEFORE UPDATE ON public.users
    FOR EACH ROW
    EXECUTE PROCEDURE public.handle_updated_at();

CREATE TRIGGER update_facilities_modtime
    BEFORE UPDATE ON public.facilities
    FOR EACH ROW
    EXECUTE PROCEDURE public.handle_updated_at();


-- --- Realtime 활성화 ---
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

ALTER PUBLICATION supabase_realtime ADD TABLE public.congestion_logs;
-- Realtime 활성화 확인 완료
