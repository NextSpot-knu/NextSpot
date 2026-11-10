// 골든타임 배지 — 웹 components/GoldenHourBadge.tsx(226df81)의 표시 부분. 카드·저장·대기가 이 하나를 쓴다(§4.3).
// GET /predict/golden-hour 로 '오늘 남은 시간 중 가장 한산한 60분 창'을 지연 조회해 "🕐 오늘 한산: 16~17시" 를 보여 준다.
// 없음·실패·available:false 는 조용히 숨는다. '알림 받기' 버튼은 여기 없다 — D10 ① 에 따라 F1 이 더한다.
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { fetchGoldenHour, type GoldenHour } from '~/features/waiting/api';
import { useT } from '~/lib/i18n/I18nProvider';

import { Text } from './ui/Text';

export function GoldenHourBadge({ facilityId, className = '' }: { facilityId?: string | null; className?: string }) {
  const t = useT();
  const [golden, setGolden] = useState<GoldenHour | null>(null);
  useEffect(() => {
    setGolden(null);
    if (!facilityId) return;
    const controller = new AbortController();
    let alive = true;
    void fetchGoldenHour(facilityId, controller.signal).then((g) => {
      if (alive) setGolden(g);
    });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [facilityId]);
  if (!golden) return null;
  return (
    <View className={`flex-row items-center ${className}`}>
      {/* 웹 `px-2 py-0.5 rounded-md text-[10px] font-bold border bg-jade/10 border-jade/30 text-jade whitespace-nowrap`(109.7×21) */}
      <View className="self-start rounded-md border border-jade/30 bg-jade/10 px-[8px] py-[2px]">
        <Text className="text-[10px] leading-[15px] text-jade" weight="bold" numberOfLines={1}>
          {`🕐 ${t('golden.badge', { start: String(golden.start), end: String(golden.end) })}`}
        </Text>
      </View>
    </View>
  );
}

export default GoldenHourBadge;
