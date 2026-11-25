// 관제 시스템 설정 데모(`/admin/settings?demo=1`) 고정 데이터 — 전부 합성값이다.
// 이 화면은 데모에서 백엔드(관리자 API·Supabase)를 부르지 않고 아래 값으로만 그린다. 저장도 하지 않는다.

/** GET /api/v1/admin/settings 응답 — system_settings 단일 행(snake_case, admin-api 는 케이스 변환 없음).
 *  행이 없으면 백엔드가 null 을 반환한다(마이그레이션 미적용 환경 = 'missing').
 *  필드별 typeof 가드가 있으므로 넓게 잡는다. */
export interface SystemSettingsRow {
  maintenance_mode?: boolean | null;
  notice_text?: string | null;
  congestion_threshold?: number | null;
  coldstart_weight?: number | null;
}

/** 데모 설정 행 — 점검 안내 꺼짐, 기본 공지, 혼잡 경계 80%. */
export const DEMO_SETTINGS_ROW: SystemSettingsRow = {
  maintenance_mode: false,
  notice_text: '경주 주요 관광지·맛집 혼잡 정보를 실시간으로 제공하고 있습니다.',
  congestion_threshold: 80,
  coldstart_weight: 50,
};

export interface DemoSettingsStats {
  facilities: number;
  logs: number;
  lastLog: string;
}

/** 데이터베이스 현황 — 최근 수집 시각은 지금 기준 7분 전(호출 시점 기준, 결정적 오프셋). */
export function demoSettingsStats(now: number = Date.now()): DemoSettingsStats {
  return {
    facilities: 1912,
    logs: 48630,
    lastLog: new Date(now - 7 * 60 * 1000).toISOString(),
  };
}
