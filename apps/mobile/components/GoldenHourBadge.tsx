// 골든타임 배지 — 웹 components/GoldenHourBadge.tsx(226df81). 카드·저장·대기가 이 하나를 쓴다(§4.3).
// GET /predict/golden-hour 로 '오늘 남은 시간 중 가장 한산한 60분 창'을 지연 조회해 "🕐 오늘 한산: 16~17시" 를 보여 준다.
// 없음·실패·available:false 는 조용히 숨는다.
// 옆의 '알림 받기'(F1, D10 ①)는 그 시각에 기기 안 로컬 알림을 한 번 예약한다 — lib/platform/notify(네이티브 expo-notifications ·
// 웹 빌드 브라우저 Notification). 권한은 누를 때만 묻고, 서버로 보내는 것이 없다. 예약 뒤에는 '예약됨'(비활성).
import { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { Bell, BellRing } from 'lucide-react-native';

import { fetchGoldenHour, type GoldenHour } from '~/features/waiting/api';
import { useT } from '~/lib/i18n/I18nProvider';
import {
  getGoldenNotifyState,
  initialGoldenNotifyState,
  scheduleGolden,
  type GoldenNotifyState,
} from '~/lib/platform/notify';
import { reactionFor } from '~/lib/platform/notifyCore';

import { Icon } from './ui/Icon';
import { Pressable } from './ui/Pressable';
import { Text } from './ui/Text';
import { toast } from './ui/Toast';

const IS_WEB = Platform.OS === 'web';
// 버튼 높이가 21 이라 위아래로 넓힌다(저장소 규칙 11 — R3 G5a-19). 좌우는 배지와 붙어 있어 조금만.
const NOTIFY_HIT_SLOP = { top: 12, bottom: 12, left: 4, right: 4 };

export function GoldenHourBadge({ facilityId, className = '' }: { facilityId?: string | null; className?: string }) {
  const t = useT();
  const [golden, setGolden] = useState<GoldenHour | null>(null);
  const [notify, setNotify] = useState<GoldenNotifyState>(initialGoldenNotifyState);
  const busyRef = useRef(false);

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

  // 배지가 보일 때만 — 이미 예약했는지(다시 열어도 '예약됨'), 설정에서 막혔는지 본다. 권한은 묻지 않는다.
  const hasGolden = golden != null;
  useEffect(() => {
    setNotify(initialGoldenNotifyState());
    if (!facilityId || !hasGolden) return;
    let alive = true;
    void getGoldenNotifyState(facilityId).then((s) => {
      if (alive) setNotify(s);
    });
    return () => {
      alive = false;
    };
  }, [facilityId, hasGolden]);

  if (!golden || !facilityId) return null;
  const start = String(golden.start);
  const end = String(golden.end);
  const scheduled = notify === 'scheduled';

  const onNotify = async () => {
    if (scheduled || busyRef.current) return;
    busyRef.current = true;
    try {
      const outcome = await scheduleGolden({
        facilityId,
        start: golden.start,
        title: t('golden.notifyTitle'),
        body: t('golden.notifyBody', { start, end }),
      });
      const reaction = reactionFor(outcome, IS_WEB);
      if (reaction.state) setNotify(reaction.state);
      if (reaction.deniedToast) toast.error(t('alert.denied'), { description: t('alert.deniedSub') });
    } finally {
      busyRef.current = false;
    }
  };

  return (
    <View className={`flex-row items-center gap-[4px] ${className}`}>
      {/* 웹 `px-2 py-0.5 rounded-md text-[10px] font-bold border bg-jade/10 border-jade/30 text-jade whitespace-nowrap`(109.7×21) */}
      <View className="self-start rounded-md border border-jade/30 bg-jade/10 px-[8px] py-[2px]">
        {/* 이모지는 읽기 화면에서 숨긴다(스크린리더가 '1시' 로 읽지 않게). 글자색 jade 10px/jade10% 는 웹과 같다(4.31:1, 웹도 동일 — 패리티 유지). */}
        <View className="flex-row items-center">
          <Text
            className="text-[10px] leading-[15px] text-jade"
            weight="bold"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {'🕐 '}
          </Text>
          <Text className="text-[10px] leading-[15px] text-jade" weight="bold" numberOfLines={1}>
            {t('golden.badge', { start, end })}
          </Text>
        </View>
      </View>
      {/* 웹 `inline-flex shrink-0 items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-bold border` +
          기본 `bg-white/70 border-line text-muk-soft` · 예약됨 `bg-jade/15 border-jade/30 text-jade`(58.5×21). 알림을 쓸 수 없으면 그리지 않는다. */}
      {notify !== 'hidden' ? (
        <Pressable
          onPress={() => void onNotify()}
          disabled={scheduled}
          hitSlop={NOTIFY_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={scheduled ? t('golden.notifyScheduledAria') : t('golden.notifyAria', { start })}
          accessibilityState={{ disabled: scheduled }}
          className={`shrink-0 flex-row items-center gap-[2px] self-start rounded-md border px-[6px] py-[2px] ${
            scheduled ? 'border-jade/30 bg-jade/15' : 'border-line bg-white/70'
          }`}
        >
          <Icon icon={scheduled ? BellRing : Bell} size={10} color={scheduled ? 'jade' : 'muk-soft'} />
          <Text
            className={`text-[10px] leading-[15px] ${scheduled ? 'text-jade' : 'text-muk-soft'}`}
            weight="bold"
            numberOfLines={1}
          >
            {scheduled ? t('golden.notifyScheduled') : t('golden.notifyCta')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default GoldenHourBadge;
