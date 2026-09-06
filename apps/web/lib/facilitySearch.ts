// 등록된 가게(POI) 검색 — 이름으로 좁혀 고르기.
//
// 두 화면이 같은 질문을 한다: **이 사람이 말하는 가게가 우리 DB 의 어느 행인가.**
//   · /account/business — 사업자 신청자가 자기 가게를 골라 facility_id 를 붙인다.
//   · /dev             — 심사자가 미연결 신청에 가게를 이어 붙인다.
// 두 화면이 각자 Supabase 쿼리를 짜면 검색 방식이 조용히 갈라진다(한쪽만 종류 필터가 있다든지,
// 한쪽만 비활성 가게를 숨긴다든지). 질문이 같으면 함수도 하나여야 한다.
//
// 백엔드 엔드포인트를 새로 만들지 않는 이유: facilities 는 anon SELECT 가 열려 있어
// 브라우저가 직접 읽을 수 있고, 사장님 콘솔의 개발자 피커가 이미 같은 방식으로 돌고 있다
// (apps/web/app/merchant/page.tsx DeveloperFacilityPicker). 경유지를 하나 더 두면
// Render 콜드 스타트가 검색 타이핑에 얹힌다.

import { createPublicClient } from '@/lib/supabase';

export interface FacilityHit {
  id: string;
  name: string;
  type: string;
  address: string | null;
}

export interface FacilitySearchOptions {
  /** 이름 부분 일치(대소문자 무시). 비우면 전체를 이름순으로 훑는다. */
  term?: string;
  /** restaurant | cafe | attraction | culture. null 이면 전체. */
  type?: string | null;
  limit?: number;
  offset?: number;
  /** 총 건수도 함께 받는가(페이지네이션이 있는 화면만 true). */
  withCount?: boolean;
}

export interface FacilitySearchResult {
  items: FacilityHit[];
  /** withCount 를 켰고 서버가 세 줬을 때만 숫자다. */
  total: number | null;
  /** 조회 자체가 실패했는가.
   *
   * **빈 배열로 뭉뚱그리면 안 되는 이유**: 호출부가 그걸 '없다' 로만 읽는다. 신청 화면은
   * '검색 결과가 없어요' 를 그리고, 심사 화면은 한 발 더 나가 "아직 등록되지 않은 가게라면
   * '새 가게로 등록' 을 쓰세요" 라고 **행동까지 지시한다.** Supabase 가 잠깐 흔들리면
   * 이미 존재하는 가게에 중복 유령 POI 가 만들어지고, 되돌릴 자동 수단이 없다.
   * (같은 화면의 카카오 검색은 이미 이 실수를 피해 kind:'failed' 를 따로 둔다.) */
  failed: boolean;
}

/** Postgres LIKE 메타문자를 값으로 되돌린다.
 *
 * `%`·`_` 를 그대로 넘기면 사용자가 친 글자가 와일드카드가 된다 — "커피_" 가 "커피" + 아무 글자
 * 하나로 읽혀 엉뚱한 가게가 딸려 온다. 흔한 입력은 아니지만, 검색 결과 하나를 골라 소유권
 * 신청에 붙이는 화면이라 "왜 이 가게가 나왔지" 가 생기면 안 된다. */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 이름으로 시설을 찾는다.
 *
 * 비활성 시설(is_active=false — 폐업·미검증 시드)은 **제외한다.** 신청자가 고를 수 있게 두면
 * 승인 시 죽은 POI 에 소유권이 붙고, 사장님 콘솔은 열리는데 손님에게는 그 가게가 한 번도
 * 추천되지 않는다. 없는 것으로 보이는 편이 정직하다 — 실제로 영업 중이면 '목록에 없어요'
 * 경로로 신규 등록을 받는다.
 *
 * 실패는 던지지 않는다 — 검색은 신청 폼의 보조 수단이고, Supabase 가 잠깐 안 되는 것이 신청
 * 자체를 막을 이유는 아니다(자유 입력 경로가 항상 열려 있다). 다만 **실패했다는 사실은
 * 그대로 전한다**(failed). 예전에는 빈 배열로 뭉뚱그려 '결과 없음' 과 구분되지 않았다.
 */
export async function searchFacilities(
  options: FacilitySearchOptions = {},
): Promise<FacilitySearchResult> {
  const { term = '', type = null, limit = 8, offset = 0, withCount = false } = options;
  const trimmed = term.trim();
  try {
    let query = createPublicClient()
      .from('facilities')
      .select('id, name, type, address', withCount ? { count: 'exact' } : undefined)
      .eq('is_active', true)
      .order('name')
      .range(offset, offset + limit - 1);
    if (trimmed) query = query.ilike('name', `%${escapeLikeTerm(trimmed)}%`);
    if (type) query = query.eq('type', type);
    const { data, count, error } = await query;
    if (error) throw error;
    return {
      items: (data ?? []).map((row) => ({
        id: String(row.id),
        name: String(row.name ?? ''),
        type: String(row.type ?? ''),
        address: (row.address as string | null) ?? null,
      })),
      total: typeof count === 'number' ? count : null,
      failed: false,
    };
  } catch {
    return { items: [], total: null, failed: true };
  }
}
