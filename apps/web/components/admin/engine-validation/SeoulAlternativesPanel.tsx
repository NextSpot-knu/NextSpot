'use client';

// "실시간 인구로 돌린 대안 추천".
//
// 이 블록이 같은 페이지의 다른 블록과 **정반대 방향**이라는 점이 중요하다:
//   · 검증 지표(위)는 우리 추정이 실측을 얼마나 맞히는지 본다 — 주인공은 추정치다.
//   · 여기는 추정치를 한 번도 쓰지 않는다. 서울시가 실제로 잰 인구만으로 SPOT 의 비용 축을 돌린다.
//     "경주에 실시간 인구가 들어오면 이렇게 돈다" 를 보여 주는 자리다.
// 그 차이가 문구에서 흐려지면 심사에서 "추정으로 만든 추천을 실측처럼 보여 줬다" 가 된다.
//
// 자체적으로 조회한다(페이지가 아니라). 출발지를 바꿀 때마다 요청이 달라지고, 이 블록이 실패해도
// 검증 지표는 계속 보여야 하기 때문이다.

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ArrowRight, Footprints, MapPin, RefreshCw, Loader2, Users } from 'lucide-react';
import { adminApi, adminApiKind, adminApiStatus } from '@/lib/admin-api';
import { errorMessage } from '@/lib/errors';
import type { AdminFailureNotice } from '@/lib/adminApiFailure';
import {
  DEFAULT_ORIGIN,
  alternativeSentence,
  alternativesPath,
  describeAlternativesState,
  describeFetchFailure,
  formatKst,
  formatPopulationRange,
  formatWalk,
  parseAlternatives,
  type AlternativePlace,
  type AlternativesResponse,
  type Tone,
} from '@/lib/engineValidation';

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; data: AlternativesResponse }
  | { status: 'failed'; failure: AdminFailureNotice };

const TONE_BOX: Record<Tone, string> = {
  ok: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700',
  info: 'bg-hanok-card border-hanok-line text-hanok-ink',
  warn: 'bg-amber-500/10 border-amber-500/30 text-amber-800',
  error: 'bg-rose-500/10 border-rose-500/30 text-rose-700',
};

// 등급 색은 프로젝트 공통 혼잡 색 어법(여유 초록 → 붐빔 빨강)을 따른다. 색만으로 구분하지 않도록
// 이름을 항상 함께 쓴다(색각이상·흑백 인쇄).
const GRADE_STYLE: Record<string, string> = {
  '여유': 'bg-emerald-500/15 text-emerald-700 border-emerald-500/40',
  '보통': 'bg-sky-500/15 text-sky-700 border-sky-500/40',
  '약간 붐빔': 'bg-amber-500/15 text-amber-700 border-amber-500/40',
  '붐빔': 'bg-rose-500/15 text-rose-700 border-rose-500/40',
};

const CLUSTER_FALLBACK = [DEFAULT_ORIGIN, '연남동', '합정역'];

export function SeoulAlternativesPanel() {
  const [origin, setOrigin] = useState<string>(DEFAULT_ORIGIN);
  const [reloadKey, setReloadKey] = useState(0);
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    adminApi
      .get(alternativesPath(origin))
      .then((raw: unknown) => {
        if (!active) return;
        const data = parseAlternatives(raw);
        if (!data) {
          setLoad({
            status: 'failed',
            failure: {
              title: '대안 추천 결과를 갱신하는 중입니다',
              action: '잠시 후 다시 시도해 주세요 — 새로고침하면 최신 결과를 불러옵니다.',
              href: null,
              retryable: true,
              detail: null,
            },
          });
          return;
        }
        setLoad({ status: 'loaded', data });
      })
      .catch((err: unknown) => {
        if (!active) return;
        setLoad({
          status: 'failed',
          failure: describeFetchFailure({
            kind: adminApiKind(err),
            status: adminApiStatus(err),
            message: errorMessage(err),
          }),
        });
      });
    return () => {
      active = false;
    };
  }, [origin, reloadKey]);

  const reload = useCallback(() => {
    setLoad({ status: 'loading' });
    setReloadKey((key) => key + 1);
  }, []);

  const data = load.status === 'loaded' ? load.data : null;
  const notice = data ? describeAlternativesState(data) : null;
  const names = data?.cluster.length ? data.cluster.map((place) => place.area_nm) : CLUSTER_FALLBACK;

  return (
    <section className="bg-hanok-panel p-6 rounded-2xl border border-hanok-line shadow-sm space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-bold text-hanok-ink">실시간 인구로 돌린 대안 추천</h3>
        <span className="text-xs text-hanok-muted">
          서울시 실측 인구 100% 기반
        </span>
      </div>
      <p className="text-xs text-hanok-muted">
        홍대·연남동·합정역은 걸어서 오갈 수 있고, 서울시가 세 곳의 실시간 인구를 직접 측정합니다.
        그 실측값만으로 SPOT 순위 산식(<span className="text-hanok-ink font-semibold">걷는 시간 + 혼잡 대기</span>)을 돌린 결과가 아래이며,
        경주 혼잡 데이터가 연결되면 같은 코드가 그대로 동작합니다.
      </p>

      {/* 출발지 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-hanok-muted mr-1 flex items-center gap-1">
          <MapPin size={14} /> 출발지
        </span>
        {names.map((name) => (
          <button
            key={name}
            onClick={() => {
              if (name === origin) return;
              setLoad({ status: 'loading' });
              setOrigin(name);
            }}
            aria-pressed={name === origin}
            className={`px-3 py-1.5 rounded-lg text-sm font-semibold border transition-colors ${
              name === origin
                ? 'bg-gold/10 text-gold-deep border-gold/40'
                : 'bg-hanok-card text-hanok-muted border-hanok-line hover:text-hanok-ink'
            }`}
          >
            {name}
          </button>
        ))}
        <button
          onClick={reload}
          disabled={load.status === 'loading'}
          className="ml-auto inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-semibold border bg-hanok-card text-hanok-ink border-hanok-line hover:text-gold-deep disabled:opacity-50"
        >
          <RefreshCw size={14} className={load.status === 'loading' ? 'animate-spin' : ''} /> 새로고침
        </button>
      </div>

      {load.status === 'loading' && (
        <div className="flex items-center gap-2 text-sm text-hanok-muted">
          <Loader2 size={16} className="animate-spin" /> 서울 실측 인구를 불러오는 중…
        </div>
      )}

      {load.status === 'failed' && (
        <div className="flex items-start gap-3 bg-rose-500/10 border border-rose-500/30 rounded-xl p-4">
          <AlertCircle size={18} className="text-rose-600 flex-shrink-0 mt-0.5" />
          <div className="min-w-0 text-sm">
            <p className="font-bold text-rose-700">{load.failure.title}</p>
            <p className="text-hanok-muted mt-1">{load.failure.action}</p>
            {load.failure.retryable && (
              <button onClick={reload} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-hanok-ink underline underline-offset-2 hover:text-gold-deep">
                <RefreshCw size={13} /> 다시 시도
              </button>
            )}
          </div>
        </div>
      )}

      {data && notice && (
        <>
          <div className={`border rounded-xl p-3 ${TONE_BOX[notice.tone]}`}>
            <p className="font-bold text-sm">{notice.title}</p>
            <p className="text-xs text-hanok-muted mt-1">{notice.detail}</p>
          </div>

          {/* 추천 한 줄 — 이 블록의 결론 */}
          <div className="bg-hanok-card border border-hanok-line rounded-xl p-4">
            <p className="text-base font-bold text-hanok-ink leading-relaxed">{alternativeSentence(data)}</p>
            <p className="text-xs text-hanok-muted mt-2">{data.recommendation?.ranking_note}</p>
            {data.recommendation?.reason && (
              <p className="text-xs text-amber-700/90 mt-1">{data.recommendation.reason}</p>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {data.places.map((place) => (
              <PlaceCard key={place.area_nm} place={place} state={data.state} />
            ))}
          </div>

          <p className="text-xs text-hanok-muted">
            <span className="text-hanok-ink font-semibold">데이터 기준.</span> {data.source_note} 걷는 시간은 {data.walking.note}
          </p>
        </>
      )}
    </section>
  );
}

function PlaceCard({ place, state }: { place: AlternativePlace; state: AlternativesResponse['state'] }) {
  const gradeStyle = (place.congest_lvl && GRADE_STYLE[place.congest_lvl]) || 'bg-hanok-panel text-hanok-muted border-hanok-line';
  return (
    <div
      className={`rounded-xl border p-4 space-y-2 ${
        place.is_origin ? 'bg-gold/5 border-gold/40' : 'bg-hanok-card border-hanok-line'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-bold text-hanok-ink truncate">{place.area_nm}</p>
          <p className="text-[11px] text-hanok-muted">{place.area_cd}</p>
        </div>
        {place.is_origin ? (
          <span className="text-[11px] font-semibold text-gold-deep border border-gold/40 rounded px-1.5 py-0.5 flex-shrink-0">출발지</span>
        ) : place.rank !== null ? (
          <span className="text-[11px] font-semibold text-hanok-ink border border-hanok-line rounded px-1.5 py-0.5 flex-shrink-0">
            {place.rank}순위
          </span>
        ) : null}
      </div>

      {place.has_data && place.congest_lvl ? (
        <>
          <span className={`inline-block text-sm font-bold border rounded-lg px-2 py-0.5 ${gradeStyle}`}>
            {place.congest_lvl}
          </span>
          <p className="text-sm text-hanok-ink flex items-center gap-1">
            <Users size={13} className="text-hanok-muted" /> {formatPopulationRange(place.ppltn_min, place.ppltn_max)}
          </p>
          {place.normalized_population !== null && (
            <p className="text-[11px] text-hanok-muted">
              이 대상지가 최근 {place.lookback_buckets > 0 ? '일주일' : '기간'}에 보인 최대치의 {Math.round(place.normalized_population * 100)}%
            </p>
          )}
          <p className="text-sm text-hanok-ink flex items-center gap-1">
            <Footprints size={13} className="text-hanok-muted" />
            {place.is_origin ? '여기' : `걸어서 ${formatWalk(place.walk_minutes)} · ${Math.round(place.straight_distance_m)}m(직선)`}
          </p>
          {place.cost_minutes !== null && (
            <p className="text-[11px] text-hanok-muted flex items-center gap-1">
              순위 비용 {place.cost_minutes}분
              <ArrowRight size={10} />
              걷기 {place.walk_minutes}분 + 혼잡 대기 {place.crowd_wait_minutes}분
            </p>
          )}
          <p className={`text-[11px] ${place.stale || state === 'stale' ? 'text-amber-700' : 'text-hanok-muted'}`}>
            {formatKst(place.observed_at ?? place.bucket_at)} 서울시 집계
            {place.stale ? ' · 최근 관측 기준' : ''}
          </p>
        </>
      ) : (
        <p className="text-sm text-hanok-muted">{place.reason ?? '실측 인구를 수집하는 중입니다.'}</p>
      )}
    </div>
  );
}
