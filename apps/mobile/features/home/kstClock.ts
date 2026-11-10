// 홈 상단 경주 현지 시계(KST) 문구 — react-native 를 모른다(테스트: kstClock.test.ts).
// 웹 원본: apps/web/app/main/page.tsx 749-776 — Intl timeZone 'Asia/Seoul', 로케일 ko-KR/en-US/ja-JP/zh-CN.
// Hermes Intl 이 timeZone 을 못 다루는 기기가 있을 수 있어(G2-10 네이티브 확인), 결과가 KST 와 어긋나면 UTC+9 를 직접 계산한 글로 돌아간다.
export type ClockLocale = 'ko' | 'en' | 'ja' | 'zh';

const INTL_LOCALE: Record<ClockLocale, string> = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP', zh: 'zh-CN' };
const WEEKDAY: Record<ClockLocale, string[]> = {
  ko: ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  ja: ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'],
  zh: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'],
};

/** UTC+9 로 옮긴 달력 값 — 기기 시간대와 무관. */
export function kstFields(at: Date) {
  const k = new Date(at.getTime() + 9 * 3600_000);
  return { month: k.getUTCMonth() + 1, day: k.getUTCDate(), weekday: k.getUTCDay(), hour: k.getUTCHours(), minute: k.getUTCMinutes() };
}

function manualLabels(at: Date, locale: ClockLocale) {
  const f = kstFields(at);
  const h12 = f.hour % 12 === 0 ? 12 : f.hour % 12;
  const mm = String(f.minute).padStart(2, '0');
  const pm = f.hour >= 12;
  const week = WEEKDAY[locale][f.weekday];
  if (locale === 'en') return { date: `${week}, ${f.month}/${f.day}`, time: `${h12}:${mm} ${pm ? 'PM' : 'AM'}` };
  const date =
    locale === 'ko' ? `${f.month}월 ${f.day}일 ${week}` : locale === 'ja' ? `${f.month}月${f.day}日${week}` : `${f.month}月${f.day}日${week}`;
  const mer = locale === 'ko' ? (pm ? '오후' : '오전') : locale === 'ja' ? (pm ? '午後' : '午前') : pm ? '下午' : '上午';
  return { date, time: `${mer} ${h12}:${mm}` };
}

export function clockLabels(at: Date, locale: ClockLocale): { date: string; time: string } {
  try {
    const intlLocale = INTL_LOCALE[locale];
    const zone = { timeZone: 'Asia/Seoul' } as const;
    const time = new Intl.DateTimeFormat(intlLocale, { ...zone, hour: 'numeric', minute: '2-digit', hour12: true }).format(at);
    // 시간대를 무시하는 엔진 점검 — 시(hour)만 따로 뽑아 UTC+9 계산과 맞는지 본다.
    const hourPart = new Intl.DateTimeFormat('en-US', { ...zone, hour: 'numeric', hourCycle: 'h23' }).format(at);
    if (Number.parseInt(hourPart, 10) % 24 !== kstFields(at).hour) return manualLabels(at, locale);
    const date = new Intl.DateTimeFormat(intlLocale, { ...zone, month: 'long', day: 'numeric', weekday: 'long' }).format(at);
    return { date, time };
  } catch {
    return manualLabels(at, locale);
  }
}
