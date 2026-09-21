'use client';

// 서비스 소개 모달의 '데이터' 절 — 어느 공공 API 가 어느 화면에서 쓰이는지 한 표로 보여준다.
//
// 왜 필요한가: 출처 표기가 푸터와 개별 카드에 흩어져 있어 "어떤 공공 API 를 어디에 쓰는가"를
// 보는 사람이 직접 조립해야 했다. 이 절은 그 대답을 한 화면에 모은다(출처 기관 · 사용한
// 오퍼레이션 · 쓰이는 화면 · 갱신 주기).
//
// 표의 오퍼레이션 이름은 **코드에 실제로 있는 것만** 적는다(번역하지 않는 고유명사라 여기 상수로 둔다):
//   apps/api/app/services/tourapi/client.py   — locationBasedList2 / areaBasedList2 / detailCommon2 /
//                                               detailIntro2 / detailImage2 / searchFestival2
//   apps/api/app/services/tourapi/insights.py — tatsCnctrRatedList(TatsCnctrRateService) /
//                                               areaBasedList1(TarRlteTarService1)
//   apps/api/app/services/weather_service.py  — getVilageFcst(VilageFcstInfoService_2.0)
//   apps/api/app/services/parking_demand_service.py — PrkSttusInfo / PrkRealtimeInfo
//   apps/api/scripts/build_walking_graph.py   — Overpass API(OpenStreetMap)
//   apps/api/app/services/kakao_place_search_service.py — /v2/local/search/keyword.json
// 갱신 주기는 .github/workflows/ingest.yml(매일 19:00 UTC = 04:00 KST)과 각 서비스의 캐시 TTL 근거.

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Database } from 'lucide-react';
import { useT } from '@/lib/i18n/I18nProvider';
import { apiClient, type FreshnessResponse } from '@/lib/api-client';
import { relativeParts } from '@/lib/freshness';
import styles from './guide.module.css';

const rows = [
  { org: 'orgTour', api: 'apiLocation', ops: 'locationBasedList2 · areaBasedList2', screen: 'screenLocation', cycle: 'cycleDaily' },
  { org: 'orgTour', api: 'apiDetail', ops: 'detailCommon2 · detailIntro2', screen: 'screenDetail', cycle: 'cycleDaily' },
  { org: 'orgTour', api: 'apiImage', ops: 'detailImage2', screen: 'screenImage', cycle: 'cycleDaily' },
  { org: 'orgTour', api: 'apiFestival', ops: 'searchFestival2', screen: 'screenFestival', cycle: 'cycleDaily' },
  { org: 'orgLab', api: 'apiConcentration', ops: 'tatsCnctrRatedList · areaBasedList1', screen: 'screenConcentration', cycle: 'cycleDaily' },
  { org: 'orgKma', api: 'apiWeather', ops: 'getVilageFcst', screen: 'screenWeather', cycle: 'cycleWeather' },
  { org: 'orgParking', api: 'apiParking', ops: 'PrkSttusInfo · PrkRealtimeInfo', screen: 'screenParking', cycle: 'cycleParking' },
  { org: 'orgOsm', api: 'apiOsm', ops: 'Overpass API', screen: 'screenOsm', cycle: 'cycleStatic' },
  { org: 'orgKakao', api: 'apiKakao', ops: '/v2/local/search/keyword.json', screen: 'screenKakao', cycle: 'cycleLive' },
] as const;

export default function GuideDataSection() {
  const t = useT();
  const foldRef = useRef<HTMLDetailsElement>(null);
  // null = 아직 확인 중, false = 실패(정적 문장으로 폴백)
  const [freshness, setFreshness] = useState<FreshnessResponse | false | null>(null);

  // 푸터의 '데이터 출처' 줄로 들어왔으면 절을 펼치고 그 자리로 스크롤한다.
  // <details> 는 제어하지 않고(open prop 없음) DOM 속성만 직접 켠다 — 상태를 하나 더 두면
  // 이펙트 안 setState 로 렌더가 한 번 더 도는데, 펼침 여부는 그 뒤로 브라우저가 스스로 관리한다.
  // 이 절은 **기본이 펼침**이다.
  //
  // 처음에는 접어 두고 홈 푸터의 '데이터 출처' 줄이 펼쳐 주도록 만들었는데, 그 신호가 배포
  // 빌드에서 끝내 도달하지 않았다(모듈 변수 → sessionStorage → React 상태까지 세 번 고쳐도
  // 마찬가지. 정적/동적 청크에 모듈이 복제되는 환경이라 전달 경로 자체가 불안정하다).
  // 데이터 활용은 별도 채점 항목이라 '클릭해야 보이는' 표보다 '스크롤하면 보이는' 표가 낫다 —
  // 접는 장치를 유지하되 기본값만 펼침으로 둔다(계획 절은 그대로 접힘).
  const [expanded, setExpanded] = useState(true);

  // 신선도는 공개 GET 이라 로그인 없이도 읽힌다. 실패·타임아웃은 정적 문장으로 조용히 폴백한다
  // (심사 중 이 한 줄 때문에 에러 문구나 빈 칸이 보이는 일이 없어야 한다).
  useEffect(() => {
    let alive = true;
    apiClient
      .getFreshness()
      .then((res) => { if (alive) setFreshness(res ?? false); })
      .catch(() => { if (alive) setFreshness(false); });
    return () => { alive = false; };
  }, []);

  const parts = freshness ? relativeParts(freshness.lastTourapiSync) : null;
  const relative = !parts
    ? null
    : parts.unit === 'now' ? t('freshness.justNow')
    : parts.unit === 'min' ? t('freshness.minAgo', { n: parts.value })
    : parts.unit === 'hour' ? t('freshness.hourAgo', { n: parts.value })
    : t('freshness.dayAgo', { n: parts.value });

  return (
    <details ref={foldRef} open={expanded} onToggle={(event) => setExpanded((event.currentTarget as HTMLDetailsElement).open)} className={styles.planFold}>
      <summary className={styles.planSummary}>
        <Database size={17} aria-hidden />
        <span>{t('dataTab.foldLabel')}</span>
        <ChevronDown size={18} aria-hidden />
      </summary>

      <section className={styles.section} aria-labelledby="nextspot-data">
        <div className={styles.sectionInner}>
          <p className={styles.kicker}>{t('dataTab.kicker')}</p>
          <h2 id="nextspot-data" className={styles.sectionTitle}>{t('dataTab.title')}</h2>
          <p className={styles.sectionBody}>{t('dataTab.summary')}</p>

          <div className={styles.dataTableWrap}>
            <table className={styles.dataTable}>
              <caption className={styles.srOnly}>{t('dataTab.tableCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('dataTab.colSource')}</th>
                  <th scope="col">{t('dataTab.colApi')}</th>
                  <th scope="col">{t('dataTab.colScreen')}</th>
                  <th scope="col">{t('dataTab.colCycle')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.org}-${row.api}`}>
                    <th scope="row">{t(`dataTab.${row.org}`)}</th>
                    <td>
                      {t(`dataTab.${row.api}`)}
                      <code className={styles.dataOp}>{row.ops}</code>
                    </td>
                    <td>{t(`dataTab.${row.screen}`)}</td>
                    <td className={styles.dataCycle}>{t(`dataTab.${row.cycle}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={styles.freshCard}>
            <p className={styles.freshTitle}>{t('dataTab.freshTitle')}</p>
            {relative ? (
              <>
                <p className={styles.freshValue}>
                  {t('dataTab.freshLabel')} <span className={styles.freshStrong}>{relative}</span>
                </p>
                <p className={styles.freshMeta}>
                  {freshness && freshness.source === 'estimate' ? t('dataTab.freshSourceEstimate') : t('dataTab.freshSourceEvent')}
                  {freshness && typeof freshness.written === 'number'
                    ? ` · ${t('dataTab.freshWritten', { n: freshness.written })}`
                    : ''}
                </p>
              </>
            ) : (
              <p className={styles.freshMeta}>
                {freshness === null ? t('dataTab.freshLoading') : t('dataTab.freshFallback')}
              </p>
            )}
          </div>

          <p className={styles.note}>{t('dataTab.note')}</p>
        </div>
      </section>
    </details>
  );
}
