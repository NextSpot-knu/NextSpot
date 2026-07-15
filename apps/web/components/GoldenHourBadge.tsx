'use client';

// 골든타임 알리미 배지 — 추천 카드의 혼잡도 pill 줄에 끼워 넣는 한 줄짜리 소형 배지.
//
// 백엔드(GET /predict/golden-hour)에서 '오늘 남은 시간대 중 가장 한산한 60분 창'을 지연 조회(lazy fetch)해
// "🕐 오늘 한산: 16~17시" 식으로 보여준다. 백엔드 미기동/실패/available:false(모델 미학습·남은 시간대
// 없음) 는 전부 조용히 숨긴다(무해 폴백 — 카드 나머지 렌더에는 영향 없음).
//
// '알림 받기'는 서버 Push 인프라 없이 브라우저 Notification API 로 해당 시각에 setTimeout 로컬 알림을
// 예약하는 세션 한정 MVP다(lib/useCongestionAlerts.ts 의 로컬 알림 패턴과 동일 사상, 폴링 없이 1회 예약만
// 다르다). 탭을 닫거나 새로고침하면 예약도 함께 사라진다 — 그 이상의 영속 스케줄링은 범위 밖.

import { useEffect, useRef, useState } from 'react';
import { Bell, BellRing } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { useT } from '@/lib/i18n/I18nProvider';

interface GoldenHourData {
  available: boolean;
  facilityId?: string | null;
  start?: number | null; // KST 시(0-23) — 최저 혼잡 60분 창의 시작
  end?: number | null;
  congestion?: number | null;
  curve?: { hour: number; congestion: number }[];
}

function notificationSupported(): boolean {
  return typeof window !== 'undefined' && typeof Notification !== 'undefined';
}

export function GoldenHourBadge({
  facilityId,
  className = '',
}: {
  facilityId?: string | null;
  className?: string;
}) {
  const t = useT();
  const [data, setData] = useState<GoldenHourData | null>(null);
  const [scheduled, setScheduled] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 카드가 뜬 시설에 대해 지연 조회 — 시설이 바뀌면 이전 배지/예약 흔적을 즉시 초기화한다.
  useEffect(() => {
    setData(null);
    setScheduled(false);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!facilityId) return;
    let active = true;
    apiClient
      .get(`/predict/golden-hour?facilityId=${encodeURIComponent(facilityId)}`)
      .then((res) => {
        if (active) setData(res);
      })
      .catch(() => {
        // 백엔드 미기동/네트워크 실패 — 배지 없이 조용히 숨긴다(카드 나머지는 영향 없음).
        if (active) setData(null);
      });
    return () => {
      active = false;
    };
  }, [facilityId]);

  // 언마운트 시 예약된 로컬 알림 타이머 정리(세션 한정이라 페이지를 벗어나면 예약도 함께 사라짐).
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!data || !data.available || data.start == null || data.end == null) return null;

  const { start, end } = data;

  const handleNotify = async () => {
    if (!notificationSupported() || scheduled) return;
    let permission = Notification.permission;
    if (permission === 'default') {
      try {
        permission = await Notification.requestPermission();
      } catch {
        return;
      }
    }
    if (permission !== 'granted') return;

    // 오늘 날짜의 start:00(로컬 기기 시각 — 관광객은 실제로 한국 현지에 있어 KST 와 사실상 동일하게
    // 취급하는 기존 관례를 따른다, RecommendationCard 의 currentTime/dayPred 표시와 동일 전제).
    const target = new Date();
    target.setHours(start, 0, 0, 0);
    const delayMs = Math.max(0, target.getTime() - Date.now());

    timerRef.current = setTimeout(() => {
      try {
        new Notification(t('golden.notifyTitle'), {
          body: t('golden.notifyBody', { start: String(start), end: String(end) }),
          tag: `nextspot-golden-${facilityId}`,
          icon: '/icon.svg',
        });
      } catch {
        /* 알림 생성 실패는 무시 */
      }
    }, delayMs);
    setScheduled(true);
  };

  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <span className="px-2 py-0.5 rounded-md text-[10px] font-bold border bg-jade/10 border-jade/30 text-jade whitespace-nowrap">
        🕐 {t('golden.badge', { start: String(start), end: String(end) })}
      </span>
      {/* Notification API 미지원 환경(일부 iOS Safari 등)에서는 눌러도 되지 않는 버튼을 보여주지 않는다. */}
      {notificationSupported() && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation(); // 카드 헤더의 toggleExpand 로 이벤트가 새는 것을 방지
            void handleNotify();
          }}
          disabled={scheduled}
          aria-label={scheduled ? t('golden.notifyScheduledAria') : t('golden.notifyAria', { start: String(start) })}
          className={`inline-flex shrink-0 items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-bold border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
            scheduled
              ? 'bg-jade/15 border-jade/30 text-jade cursor-default'
              : 'bg-white/70 border-line text-muk-soft hover:bg-jade/10 hover:border-jade/30 hover:text-jade'
          }`}
        >
          {scheduled ? <BellRing size={10} aria-hidden /> : <Bell size={10} aria-hidden />}
          {scheduled ? t('golden.notifyScheduled') : t('golden.notifyCta')}
        </button>
      )}
    </span>
  );
}

export default GoldenHourBadge;
