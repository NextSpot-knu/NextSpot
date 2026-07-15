// 휴무일 원문(rest_date_raw, TourAPI detailIntro2 restdate 계열) 보수 파서.
//
// 원칙(정직성): 명확히 판정 가능한 패턴만 오늘 휴무 여부를 말하고, 그 외는 null(모름)을
// 반환한다 — 잘못된 '오늘 휴무' 배지는 영업 중인 가게에 실해를 끼치므로 과판정보다 무판정.
//
// 인식 패턴(실적재 원문 기준):
//  · '연중무휴' / '무휴'                     → 항상 영업(false)
//  · '매주 월요일', '매주 월·화요일' 등       → 해당 요일이면 휴무(true), 아니면 영업(false)
//  · '매월 첫째/둘째/셋째/넷째/마지막 월요일' → n번째 요일 계산해 판정
//  · 그 외(명절·설날·비정형 문구 포함)        → null (주장하지 않음)

const DAY_CHARS = ["일", "월", "화", "수", "목", "금", "토"] as const;

/** 오늘(로컬 시각) 기준 휴무 여부 — true=휴무 확정, false=영업 확정, null=판정 불가. */
export function isClosedToday(restRaw: string | null | undefined, now: Date = new Date()): boolean | null {
  const raw = String(restRaw ?? "").trim();
  if (!raw) return null;

  if (/연중\s*무휴|무휴/.test(raw)) return false;

  const todayIdx = now.getDay();
  const todayChar = DAY_CHARS[todayIdx];

  // '매월 첫째·셋째 월요일' 류 — 서수(들)와 요일(들)을 뽑아 오늘이 그 조합에 해당하는지 계산.
  const monthly = raw.match(/매월\s*([^요]*?)([일월화수목금토][·,\s일월화수목금토]*)요일/);
  if (monthly) {
    const ordinals = monthly[1] ?? "";
    const days = (monthly[2] ?? "").split("").filter((c) => (DAY_CHARS as readonly string[]).includes(c));
    if (!days.includes(todayChar)) return false;
    const nth = Math.ceil(now.getDate() / 7); // 오늘이 이 달의 몇 번째 해당 요일인지
    const isLast = now.getDate() + 7 > new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const wants: number[] = [];
    if (/첫/.test(ordinals)) wants.push(1);
    if (/둘/.test(ordinals)) wants.push(2);
    if (/셋/.test(ordinals)) wants.push(3);
    if (/넷/.test(ordinals)) wants.push(4);
    const wantsLast = /마지막/.test(ordinals);
    if (wants.length === 0 && !wantsLast) return null; // 서수 못 읽으면 무판정
    return wants.includes(nth) || (wantsLast && isLast);
  }

  // '매주 월요일' / '매주 월, 화요일' / '월요일 휴무' 류 — 요일 나열 추출.
  const weekly = raw.match(/(?:매주\s*)?([일월화수목금토][·,\s/일월화수목금토]*)요일/);
  if (weekly && /매주|휴무|휴관|정기/.test(raw)) {
    const days = (weekly[1] ?? "").split("").filter((c) => (DAY_CHARS as readonly string[]).includes(c));
    if (days.length === 0) return null;
    return days.includes(todayChar);
  }

  return null;
}

/** TourAPI '가능/불가능' 류 텍스트 필드의 보수 판정 — true/false/null(모름). */
export function parseAvailability(value: string | null | undefined): boolean | null {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (/불가|없음|무료?없/.test(v)) return false;
  if (/가능|있음|허용/.test(v)) return true;
  return null;
}
