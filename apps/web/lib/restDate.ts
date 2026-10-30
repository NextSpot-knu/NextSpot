// 휴무일·영업시간 원문 보수 파서 — 서버 apps/api/app/services/travel_context.py 와 **같은 규칙·같은 식**.
//
// 원칙(정직성): 명확히 판정 가능한 패턴만 휴무·영업을 말하고, 그 외는 null·needs_confirmation(모름)이다 —
// 잘못된 '오늘 휴무' 배지는 영업 중인 가게에 실해를 끼치므로 과판정보다 무판정.
// 두 구현은 같은 사례 파일(apps/api/tests/fixtures/opening_hours_parity.json)을 각자의 테스트가 읽는다 —
// 한쪽만 고치면 그쪽 테스트가 깨진다.
//
// ⚠️ 이 파일의 정규식에는 '뒤쪽 보기'(앞 글자를 조건으로 거는 문법)를 쓰지 않는다. iOS 16.4 미만 Safari 는 그
// 문법이 든 정규식 리터럴이 있으면 JS 묶음 전체를 읽지 못해 빈 화면이 된다(이 파일은 travelContext.ts 를 거쳐
// 여러 화면에 실린다). 앞 글자 검사는 정규식 밖에서 하거나 앞 글자를 묶음으로 잡는다 — restDate.test.ts 가 막는다.
//
// 휴무일 원문(operating_hours.closed · features.rest_date_raw — TourAPI restdate 계열):
//  · 요일 글자: 바로 뒤에 '요일' 이 붙으면 요일(매주월요일 · 휴무월요일). 앞이 숫자면 아니다(1월 · 15일).
//    앞이 한글이면 휴무를 말하는 앞말(매주·격주·휴무·휴관…)일 때만 요일(매주화,수). '당일'·'공휴일'·'매월'·
//    '1주일' 의 글자는 아니다. 한글 뒤에 붙은 '일' 은 '요일' 이 붙지 않으면 앞말과 상관없이 '날' 이다(휴관일 : 매주
//    월요일 · 휴무일 없음 · 매주일). '요일' 없는 낱글자는 뒤도 한글·숫자에 붙지 않아야 한다('월 2회' 의 '월' = 달).
//    구분 기호 없이 붙여 쓴 묶음('토일 휴무' · '금토일' · '토일요일')은 요일 순서대로 이어지고 앞뒤가 한글이 아니거나
//    휴무를 말하는 말일 때만 목록이다 — '화목한'·'수목원'·'생년월일'·'금일(오늘)' 은 아니다(주말 휴무 가게를 주말에
//    추천하지 않게 — 못 읽으면 영업으로 떨어진다).
//  · 입력은 먼저 NFKC 로 맞추고(전각 숫자·물결 → 반각 — JS 의 '\d'·'\s' 와 파이썬의 것이 보는 글자가 달라서),
//    앞 300자만 읽는다(실제 문구는 100자 안팎 — 긴 입력이 정규식 되돌아보기로 화면을 붙잡지 않게).
//    예전 식은 '요일'·'1월 1일'·'당일' 의 '일' 을 일요일로 읽어, 일요일마다 '매주 월요일' 가게를 닫았다(2026-10-31).
//  · '연중무휴' / '무휴'                                  → 휴무 없음
//  · '매월 첫째/둘째·넷째/마지막 주 월요일' · '1st and 3rd Sundays' → 그날이 이 달의 몇 번째 그 요일인지 계산
//  · '격주 월요일' · '매월 1회 월요일' · 'every other Monday'      → 그 요일은 모름(uncertain)
//  · '월요일이 공휴일이면 화요일' 같은 대체 휴무            → 버린다(공휴일 달력이 없다 — 매주 화요일을 닫지 않는다)
//  · 그 외(명절·설날·비정형 문구 포함)                     → 규칙 없음(null)

/** 휴무일 원문이 그날에 대해 말하는 것 — closed=휴무, uncertain=그 요일을 말하지만 그날인지 모름,
 *  open=규칙을 읽었고 그날은 해당 없음(연중무휴 포함). 읽을 규칙이 없으면 null. */
export type ClosedDayStatus = "closed" | "uncertain" | "open";

const WEEKDAY_CHARS = "월화수목금토일"; // 인덱스: 월=0 … 일=6 (서버 datetime.weekday() 와 같은 순서)
const DAY = "[월화수목금토일]";
const DAY_LIST = `${DAY}(?:\\s*[·,/、~\\-–]\\s*${DAY})*`;
// 구분 기호 없이 붙여 쓴 요일 묶음('토일 휴무' · '금토일' · '월화요일'). 요일 순서대로(월<화<…<일) 이어질 때만
// 요일 목록이다 — '화목한'·'수목원'·'일월' 은 낱말이고, '금일' 은 '오늘' 이라 묶음으로 읽지 않는다(compactDaysOk).
const COMPACT_RUN = "[월화수목금토일]{2,}";
// 아래 셋은 '이 자리부터 찾기'(execAt)로만 쓴다 — 전역 정규식의 lastIndex 를 matchAll 과 섞지 않는다.
const DAY_RUN_RE = new RegExp(`(${COMPACT_RUN}|${DAY_LIST})(\\s*요일)?`, "g");
// 요일 글자에 붙여 써도 요일로 읽는 앞말(두 글자) — '매주화,수'·'휴무월,화요일'.
const GLUE_BEFORE_DAY_RE = /(?:매주|격주|격월|매월|매달|휴무|휴관|휴업|휴점)$/;
// 붙여 쓴 묶음의 앞뒤: 앞이 한글이면 휴무 앞말('매주토일'·'휴무일토일'), 뒤가 한글이면 휴무·공휴일·이음말·조사
// ('토일공휴일 휴무'·'토일은 휴무')일 때만 요일 묶음이다.
const COMPACT_LEFT_GLUE_RE = /(?:매주|매월|매달|격주|격월|휴무|휴관|휴업|휴점|휴무일|휴관일)$/;
const COMPACT_RIGHT_RE = /^(?:휴무|휴관|휴업|휴점|휴일|정기|공휴일|법정|및|과|와|은|는|에|엔)/;
const KO_WEEKEND_RE = /주말/g;
const DIGITS = "0123456789";
const HANGUL_RE = /^[가-힣]$/;

const EN_DAY_INDEX: Record<string, number> = {};
[
  ["monday", "mon"], ["tuesday", "tues", "tue"], ["wednesday", "wed"],
  ["thursday", "thurs", "thur", "thu"], ["friday", "fri"], ["saturday", "sat"], ["sunday", "sun"],
].forEach((names, index) => names.forEach((name) => { EN_DAY_INDEX[name] = index; }));
const EN_DAY_NAMES = Object.keys(EN_DAY_INDEX)
  .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
  .join("|");
// 영어 낱말 경계는 앞 글자를 1번 묶음으로 잡아 본다. 낱말의 시작 = 일치 시작 + 1번 묶음 길이.
const EN_DAY_SOURCE = `(^|[^a-z])(${EN_DAY_NAMES})s?(?![a-z])`;
const EN_DAY_RE = new RegExp(EN_DAY_SOURCE, "g");
const EN_DAY_FIRST_RE = new RegExp(EN_DAY_SOURCE);
const EN_WEEKEND_RE = /(^|[^a-z])weekends?(?![a-z])/g;
const EN_OPEN_RE = /(?:^|[^a-z])open(?![a-z])/;
const EN_ORDINAL = "(?:first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)";
const EN_ORDINAL_VALUE: Record<string, number> = {
  first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5,
};
// 서수 사이 이음은 서로 겹치지 않는 세 갈래다(구두점 / and·or / 공백) — 공백을 나눠 갖는 방법이 곱으로 늘지 않게.
const EN_ORDINAL_SEP = "(?:\\s*[,&/]\\s*|\\s+(?:and|or)\\s+|\\s+)";
const EN_MONTHLY_RE = new RegExp(
  `(^|[^a-z])(${EN_ORDINAL}(?:${EN_ORDINAL_SEP}(?:the\\s+)?${EN_ORDINAL})*)\\s+(${EN_DAY_NAMES})s?(?![a-z])`,
  "g",
);

const OPEN_ALL_YEAR_RE = /무휴|(?:^|[^a-z])open\s+(?:daily|every\s*day|all\s+year)/;

// 공휴일 대체 휴무 조건 — 공휴일 낱말과 조건 낱말이 **함께** 있는 괄호·절만 조건으로 본다.
// '정기휴일 매주 월요일' 의 '휴일' 은 공휴일이 아니다(앞이 한글이면 홀로 선 '휴일' 로 치지 않는다).
const HOLIDAY_WORD = "(?:법정\\s*)?(?:공휴일|국경일|명절|연휴|대체\\s*휴일)|(?:^|[^가-힣])휴일|(?:^|[^a-z])holidays?(?![a-z])";
const HOLIDAY_RE = new RegExp(HOLIDAY_WORD);
const CONDITION_RE = /경우|이면|이라면|일\s*때|인\s*때|겹치|겹칠|다음\s*날|익일|이튿날|(?:^|[^a-z])(?:if|when|following|next\s+day)(?![a-z])/;
// 조건절이 시작되는 자리 — '월요일이 공휴일…' 의 주어, 또는 공휴일 낱말. 여기서 절 끝까지 버린다.
const CONDITION_START_RE = new RegExp(`${DAY}\\s*요일\\s*(?:이|가|은|는)\\s*(?:${HOLIDAY_WORD})|${HOLIDAY_WORD}`);

// 서수 안의 선택 조각은 모두 '공백 + 반드시 있는 글자'(번·째·주) 꼴 — 공백만 홀로 선택되는 자리가 없게.
// '주' 는 뒤에 '일' 이 오면 서수의 일부로 읽지 않는다('1주일' = 일주일) — 그 '일' 이 '일요일' 일 때만 예외('첫째주일요일').
const ORDINAL = "(?:첫(?:\\s*번)?(?:\\s*째)?|둘\\s*째|두\\s*번\\s*째|셋\\s*째|세\\s*번\\s*째|넷\\s*째|네\\s*번\\s*째"
  + "|다섯(?:\\s*번)?\\s*째|마지막|[1-5](?:\\s*번)?(?:\\s*째)?)(?:\\s*(?:주차|주(?!일(?!요일))))?";
// 서수 사이 이음 — 구두점 / 및·과·와 / 공백, 서로 겹치지 않는 세 갈래.
const ORDINAL_SEP = "(?:\\s*[·,/、&]\\s*|\\s*(?:및|과|와)\\s*|\\s+)";
// 앞이 숫자인 서수('12월' 의 '2')는 정규식 밖에서 거른다.
const MONTHLY_RE = new RegExp(
  `(?:(?:매월|매달)\\s*)?(${ORDINAL}(?:${ORDINAL_SEP}${ORDINAL})*)`
  + `\\s*(?:의\\s*)?(${COMPACT_RUN}|${DAY_LIST})(\\s*요일)?`,
  "g",
);
// 숫자만 있는 서수('1월'·'15일')는 날짜일 수 있어 서수로 보지 않는다.
const ORDINAL_MARK_RE = /[째주번]|첫|둘|셋|넷|다섯|마지막/;
const ORDINAL_TOKEN_RE = /첫|둘|두|셋|세|넷|네|다섯|마지막|[1-5]/g;
const ORDINAL_VALUE: Record<string, number> = {
  첫: 1, 1: 1, 둘: 2, 두: 2, 2: 2, 셋: 3, 세: 3, 3: 3, 넷: 4, 네: 4, 4: 4, 다섯: 5, 5: 5,
};
const KO_UNCERTAIN_MARKER_RE = /격주|격월|매월|매달/g;
const EN_UNCERTAIN_RE = /(^|[^a-z])(?:every\s+other|alternate|alternating|bi-?weekly)(?![a-z])/g;
// 요일 뒤에 붙으면 휴무 요일이 아닌 것: 영업시간(화~일 11:00), 영업 요일(일요일 영업 — '영업 안 함' 은 제외).
const TIME_AFTER_RE = /^\s*(?::\s*)?[0-9]{1,2}\s*(?::|시)/;
const OPEN_AFTER_RE = /^(?:\s*(?:에는|엔|에|은|는))?\s*(?:영업|운영|개방|오픈|정상|open)(?!\s*(?:안|않|하지\s*않|중지|중단|x(?![a-z])))/;
const PARTIAL_DAY_AFTER_RE = /^\s*(?:오전|오후|점심|저녁|야간)/;
const DIGIT_AFTER_RE = /^\s*[0-9]/;
const HANGUL_OR_DIGIT_RE = /^[가-힣0-9]/;
// 조건절은 조건 낱말 뒤 첫 이음말까지만 — '공휴일 다음날 휴무 및 매주 월요일 휴무' 의 뒤 절은 매주 규칙이다.
// 아래 둘은 '이 자리부터 찾기'(execAt)로만 쓴다.
const CLAUSE_JOIN_RE = /및|과|와|\//g;
const CONDITION_FROM_RE = new RegExp(CONDITION_RE.source, "g");
const MAX_CLOSED_TEXT = 300;

interface ClosedDayRules {
  openAllYear: boolean;
  weekly: Set<number>;
  monthly: { ordinals: Set<number>; last: boolean; days: Set<number> }[];
  uncertain: Set<number>;
}

/** 전역 정규식을 `pos` 자리부터 한 번 찾는다(파이썬 pattern.search(text, pos) 와 같은 뜻). */
function execAt(re: RegExp, text: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(text);
}

/** '월·화' → {0,1}, '월~수' → {0,1,2}(범위는 요일 순서로, '금~월' 처럼 주를 넘겨도 된다). */
function expandDayList(text: string): Set<number> {
  const days = new Set<number>();
  let previous: number | null = null;
  let pendingRange = false;
  for (const token of text.match(/[월화수목금토일]|[~\-–]/g) ?? []) {
    if ("~-–".includes(token)) {
      pendingRange = previous !== null;
      continue;
    }
    const index = WEEKDAY_CHARS.indexOf(token);
    if (pendingRange && previous !== null) {
      let step: number = previous;
      while (step !== index) {
        step = (step + 1) % 7;
        days.add(step);
      }
    }
    days.add(index);
    previous = index;
    pendingRange = false;
  }
  return days;
}

/** 읽은 자리를 같은 길이의 공백으로 지운다(다음 단계가 같은 글자를 두 번 읽지 않게, 위치는 그대로). */
function blank(text: string, start: number, end: number): string {
  return text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
}

function dropHolidayConditions(text: string): string {
  const unwrapped = text.replace(/\(([^()]*)\)/g, (_match, inner: string) =>
    HOLIDAY_RE.test(inner) && CONDITION_RE.test(inner) ? " " : ` ${inner} `);
  return unwrapped.split(/([,\n;])/).map(dropConditionClause).join("");
}

/** 절 안의 조건절만 지운다 — 시작(공휴일·'월요일이 공휴일…')부터 조건 낱말 뒤 첫 이음말(및·과·와·/) 앞까지.
 *  이음말 뒤는 계속 읽는다. 이음말이 없으면 종전처럼 절 끝까지 버린다. */
function dropConditionClause(piece: string): string {
  let kept = "";
  let rest = piece;
  while (HOLIDAY_RE.test(rest) && CONDITION_RE.test(rest)) {
    const start = CONDITION_START_RE.exec(rest);
    if (!start) return kept;
    const condition = execAt(CONDITION_FROM_RE, rest, start.index);
    const join = condition ? execAt(CLAUSE_JOIN_RE, rest, condition.index + condition[0].length) : null;
    if (!join) return kept + rest.slice(0, start.index);
    kept += `${rest.slice(0, start.index)} `;
    rest = rest.slice(join.index);
  }
  return kept + rest;
}

/** 원문의 앞 `max` 글자(코드 포인트 기준 — 파이썬 슬라이스와 같은 뜻). */
function capChars(text: string, max: number): string {
  return text.length <= max ? text : Array.from(text).slice(0, max).join("");
}

/** '요일' 이 붙지 않은 낱글자는 뒤가 한글·숫자면 요일이 아니다('월 2회' 의 '월' = 달). */
function bareDayEndOk(text: string, end: number): boolean {
  const rest = text.slice(end);
  if (HANGUL_OR_DIGIT_RE.test(rest)) return false;
  return !DIGIT_AFTER_RE.test(rest);
}

const isCompactRun = (daysText: string) => daysText.length >= 2 && [...daysText].every((char) => WEEKDAY_CHARS.includes(char));

/** 붙여 쓴 묶음은 요일 순서대로(월<화<…<일)일 때만 목록이다. '금일' 은 '오늘'(금일 휴무)이라 읽지 않는다. */
function compactDaysOk(daysText: string): boolean {
  if (daysText === "금일") return false;
  const indexes = [...daysText].map((char) => WEEKDAY_CHARS.indexOf(char));
  return indexes.every((index, i) => i === 0 || index > indexes[i - 1]);
}

/** 붙여 쓴 묶음 바로 뒤가 한글이면 휴무·공휴일·이음말·조사여야 한다('토일휴무' 는 되고 '화목한' 은 아니다). */
function compactRightOk(text: string, end: number): boolean {
  const following = text.slice(end, end + 1);
  return !(following && HANGUL_RE.test(following)) || COMPACT_RIGHT_RE.test(text.slice(end));
}

function acceptCompactRun(text: string, match: RegExpExecArray): boolean {
  const start = match.index;
  const previous = start ? text[start - 1] : "";
  if (!compactDaysOk(match[1])) return false;
  if (previous && DIGITS.includes(previous)) return false;
  if (previous && HANGUL_RE.test(previous) && !COMPACT_LEFT_GLUE_RE.test(text.slice(Math.max(0, start - 3), start))) {
    return false;
  }
  return Boolean(match[2]) || compactRightOk(text, start + match[0].length);
}

/** 요일 글자 묶음이 정말 요일인지 — 앞 글자 규칙은 파일 머리 주석 참조. */
function acceptDayRun(text: string, match: RegExpExecArray): boolean {
  if (isCompactRun(match[1])) return acceptCompactRun(text, match);
  const start = match.index;
  const previous = start ? text[start - 1] : "";
  if (previous && DIGITS.includes(previous)) return false;
  if (previous && HANGUL_RE.test(previous)) {
    const attached = text.startsWith("요일", start + 1);
    // 한글 뒤에 붙은 '일' 은 '요일' 이 붙지 않으면 '날' 이다(휴관일·휴무일·매주일) — 앞말과 상관없이 거른다.
    if (!attached && (text[start] === "일" || !GLUE_BEFORE_DAY_RE.test(text.slice(Math.max(0, start - 2), start)))) {
      return false;
    }
  }
  return Boolean(match[2]) || bareDayEndOk(text, start + match[0].length);
}

/** 요일 묶음을 앞에서부터. 요일이 아닌 자리('당일, 월요일' 의 '일')면 한 글자 뒤에서 다시 찾는다. */
function dayRuns(text: string, pos = 0, latestStart = Number.POSITIVE_INFINITY): RegExpExecArray[] {
  const runs: RegExpExecArray[] = [];
  let at = pos;
  for (;;) {
    const match = execAt(DAY_RUN_RE, text, at);
    if (!match || match.index > latestStart) return runs;
    if (acceptDayRun(text, match)) {
      runs.push(match);
      at = match.index + match[0].length;
    } else {
      at = match.index + 1;
    }
  }
}

const closedRulesCache = new Map<string, ClosedDayRules | null>();

function parseClosedDays(raw: string): ClosedDayRules | null {
  const cached = closedRulesCache.get(raw);
  if (cached !== undefined) return cached;
  let text = capChars(raw.normalize("NFKC"), MAX_CLOSED_TEXT)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[（［【〔[]/g, "(")
    .replace(/[）］】〕\]]/g, ")")
    .toLowerCase();
  let rules: ClosedDayRules | null = null;
  if (text.trim()) {
    rules = { openAllYear: false, weekly: new Set(), monthly: [], uncertain: new Set() };
    if (OPEN_ALL_YEAR_RE.test(text)) {
      rules.openAllYear = true;
    } else {
      const parsed = rules;
      text = dropHolidayConditions(text);

      // 1) 매월 n번째 요일(한국어). 거른 자리에서는 한 글자 뒤부터 다시 찾는다('12월 둘째 일요일').
      for (let pos = 0, match = execAt(MONTHLY_RE, text, 0); match; match = execAt(MONTHLY_RE, text, pos)) {
        const start = match.index;
        const end = start + match[0].length;
        const group = match[1];
        const daysText = match[2];
        const prefixed = match[0].startsWith("매월") || match[0].startsWith("매달");
        const compact = isCompactRun(daysText);
        if (
          (!prefixed && start && DIGITS.includes(text[start - 1]))
          || !ORDINAL_MARK_RE.test(group)
          || (compact && !compactDaysOk(daysText))
          || !(match[3] || (compact ? compactRightOk(text, end) : bareDayEndOk(text, end)))
        ) {
          pos = start + 1;
          continue;
        }
        const tokens: string[] = group.match(ORDINAL_TOKEN_RE) ?? [];
        parsed.monthly.push({
          ordinals: new Set(tokens.filter((token) => token !== "마지막").map((token) => ORDINAL_VALUE[token])),
          last: group.includes("마지막"),
          days: expandDayList(match[2]),
        });
        text = blank(text, start, end);
        pos = end;
      }

      // 2) 매월 n번째 요일(영어) — '1st and 3rd Sundays' 는 '매달 1, 3번째 일요일' 과 같은 규칙이다.
      for (let pos = 0, match = execAt(EN_MONTHLY_RE, text, 0); match; match = execAt(EN_MONTHLY_RE, text, pos)) {
        const wordStart = match.index + match[1].length;
        const end = match.index + match[0].length;
        pos = end;
        if (EN_OPEN_RE.test(text.slice(0, wordStart).split(/[,;\n]/).pop() ?? "")) continue; // 'Open the first Monday'
        const tokens: string[] = match[2].match(new RegExp(EN_ORDINAL, "g")) ?? [];
        parsed.monthly.push({
          ordinals: new Set(tokens.filter((token) => token !== "last").map((token) => EN_ORDINAL_VALUE[token])),
          last: tokens.includes("last"),
          days: new Set([EN_DAY_INDEX[match[3]]]),
        });
        text = blank(text, wordStart, end);
      }

      // 3) 서수 없는 매월·격주 — 그 요일은 모름. 표시(격주·매월) 뒤 12글자 안에서 시작하는 요일 묶음.
      for (const marker of [...text.matchAll(KO_UNCERTAIN_MARKER_RE)]) {
        const markerEnd = marker.index! + marker[0].length;
        if (text.slice(marker.index!, markerEnd) !== marker[0]) continue; // 앞 단계가 이미 읽어 지운 자리
        const run = dayRuns(text, markerEnd, markerEnd + 12)[0];
        if (!run) continue;
        const gap = text.slice(markerEnd, run.index);
        if (gap.includes("매주") || gap.includes("\n") || gap.includes(";")) continue;
        expandDayList(run[1]).forEach((day) => parsed.uncertain.add(day));
        text = blank(text, marker.index!, run.index + run[0].length);
      }

      for (const marker of [...text.matchAll(EN_UNCERTAIN_RE)]) {
        const wordStart = marker.index! + marker[1].length;
        const markerEnd = marker.index! + marker[0].length;
        if (text.slice(wordStart, markerEnd) !== marker[0].slice(marker[1].length)) continue;
        const window = text.slice(markerEnd, markerEnd + 30).split(/[,;\n]/)[0];
        const day = EN_DAY_FIRST_RE.exec(window);
        if (day) {
          parsed.uncertain.add(EN_DAY_INDEX[day[2]]);
          text = blank(text, wordStart, markerEnd + day.index + day[0].length);
        }
      }

      // 4) 매주 요일
      const finalText = text;
      const addDays = (days: Set<number>, end: number) => {
        const rest = finalText.slice(end);
        if (TIME_AFTER_RE.test(rest) || OPEN_AFTER_RE.test(rest)) return;
        // '토요일 오후 휴무' — 하루 전체가 닫힌 것은 아니다.
        const target = PARTIAL_DAY_AFTER_RE.test(rest) ? parsed.uncertain : parsed.weekly;
        days.forEach((day) => target.add(day));
      };
      for (const run of dayRuns(finalText)) addDays(expandDayList(run[1]), run.index + run[0].length);
      for (const match of finalText.matchAll(KO_WEEKEND_RE)) addDays(new Set([5, 6]), match.index! + match[0].length);
      for (const match of finalText.matchAll(EN_DAY_RE)) {
        const wordStart = match.index! + match[1].length;
        if (EN_OPEN_RE.test(finalText.slice(0, wordStart).split(/[,;\n]/).pop() ?? "")) continue; // 'Open Mon-Sat'
        addDays(new Set([EN_DAY_INDEX[match[2]]]), match.index! + match[0].length);
      }
      for (const match of finalText.matchAll(EN_WEEKEND_RE)) addDays(new Set([5, 6]), match.index! + match[0].length);
      parsed.weekly.forEach((day) => parsed.uncertain.delete(day));
    }
  }
  closedRulesCache.set(raw, rules);
  return rules;
}

/** 휴무일 원문이 `at`(한국 날짜)에 대해 말하는 것. 서버 closed_day_status 와 같은 판정. */
export function closedDayStatus(restRaw: unknown, at: Date): ClosedDayStatus | null {
  const rules = parseClosedDays(String(restRaw || ""));
  if (!rules) return null;
  if (rules.openAllYear) return "open";
  const { weekday: sundayFirst, year, month, day } = kstParts(at);
  const weekday = (sundayFirst + 6) % 7;
  if (rules.weekly.has(weekday)) return "closed";
  if (rules.monthly.length) {
    const nth = Math.floor((day - 1) / 7) + 1;
    const isLast = day + 7 > new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (const rule of rules.monthly) {
      if (rule.days.has(weekday) && (rule.ordinals.has(nth) || (rule.last && isLast))) return "closed";
    }
  }
  if (rules.uncertain.has(weekday)) return "uncertain";
  return rules.weekly.size || rules.monthly.length || rules.uncertain.size ? "open" : null;
}

/** 오늘(한국 날짜) 기준 휴무 여부 — true=휴무 확정, false=영업 확정, null=판정 불가. */
export function isClosedToday(restRaw: string | null | undefined, now: Date = new Date()): boolean | null {
  const status = closedDayStatus(restRaw, now);
  if (status === "closed") return true;
  if (status === "open") return false;
  return null;
}

/** TourAPI '가능/불가능' 류 텍스트 필드의 보수 판정 — true/false/null(모름).
 *  서버 tourapi.transform.parse_availability_text 와 같은 식(유모차 조건이 이것으로 갈린다). */
export function parseAvailability(value: string | null | undefined): boolean | null {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (/불가|없음|무료?없/.test(v)) return false;
  if (/가능|있음|허용/.test(v)) return true;
  return null;
}

export type ArrivalOpenStatus = "open_expected" | "closing_soon" | "closed_confirmed" | "needs_confirmation";
export type ArrivalOpenDisplayStatus = ArrivalOpenStatus | "likely_closed_unknown";

type OperatingHours = Record<string, unknown> | null | undefined;

// 하루 종일 열려 있는 곳 — '상시 개방'·'상시개방'·'24시간'·'연중 개방'(경주 계림·월성·황룡사지·석빙고 같은
// 야외 유적, 도심 관광지 33곳 중 14곳). 시각 범위가 없어 '영업시간 미확인' 으로 떨어지던 문구다.
// 문자열 **전체**가 이 말일 때만 인정한다 — '점포 별로 상이함'·'시설별로 상이함' 같은 문장은 그대로 미확인.
const ALWAYS_OPEN = /^(상시\s*(개방|운영)?|24\s*시간(\s*(개방|운영|영업))?|연중\s*(무휴\s*)?개방)$/;
const CLOCK = "(?:[01]?[0-9]|2[0-3]):[0-5][0-9]";
// 닫는 시각 24:00(자정)도 받는다 — '10:00~24:00' 은 자정까지 영업이다(분으로 1440).
const TIME_RANGE_RE = new RegExp(`(${CLOCK})\\s*(?:~|-|–|—)\\s*(${CLOCK}|24:00)`, "g");
// 쉬는 시간 말 — '브레이크타임 없음'·'no break' 는 쉬는 시간이 아니다.
const BREAK_WORD_RE = /브레이크|break|휴게|쉬는\s*시간|준비\s*시간|휴식/gi;
// 선택 조각은 '공백 + 반드시 있는 글자' 꼴로만 둔다(공백만 홀로 선택되면 되돌아보기가 곱으로 는다).
const BREAK_NEGATED_RE = /^(?:\s*(?:타임|time|시간))?(?:\s*:)?\s*(?:없|무(?![가-힣])|x(?![a-z])|none)/i;
const NO_BEFORE_RE = /(?:^|[^a-z])no\s*$/i;
// 입장 마감 — 말 다음 시각('입장 마감 17:00' · 'L.O 20:30'), 또는 시각 다음 말('17:00까지 입장').
// 입장이 끝난 뒤 도착하면 들어갈 수 없으므로 그 구간의 실제 닫는 시각이다.
const LAST_ENTRY_LABEL = "입장\\s*마감|마지막\\s*입장|최종\\s*입장|매표\\s*마감|발권\\s*마감|라스트\\s*오더"
  + "|last\\s*(?:entry|admission|order)|l\\.\\s*o\\.?";
const LAST_ENTRY_RE = new RegExp(
  `(?:${LAST_ENTRY_LABEL})(?:\\s*(?:시간|시각))?(?:\\s*(?:은|는))?(?:\\s*:)?\\s*(?:~\\s*)?(${CLOCK})`,
  "gi",
);
const ENTRY_UNTIL_RE = new RegExp(`(${CLOCK})\\s*(?:까지\\s*입장|입장\\s*마감)`, "g");
const DAY_MINUTES = 24 * 60;
// 영업시간 원문은 철·문·요일마다 줄이 늘어 휴무 문구보다 길다(실적재 수십~200자대) — 넉넉히 500자까지만 읽는다.
const MAX_HOURS_TEXT = 500;

type Interval = [number, number];
interface LocatedInterval { start: number; end: number; interval: Interval }

function hasBreakWord(segment: string): boolean {
  for (const match of segment.matchAll(BREAK_WORD_RE)) {
    if (BREAK_NEGATED_RE.test(segment.slice(match.index! + match[0].length))) continue;
    if (NO_BEFORE_RE.test(segment.slice(0, match.index!))) continue;
    return true;
  }
  return false;
}

const clockMinutes = (text: string) => Number(text.slice(0, text.indexOf(":"))) * 60 + Number(text.slice(text.indexOf(":") + 1));
const isFullDay = ([start, end]: Interval) => start === 0 && (end === 0 || end === DAY_MINUTES); // 00:00~24:00 · 00:00~00:00

function intervalContains(interval: Interval, minute: number): boolean {
  const [start, end] = interval;
  if (isFullDay(interval)) return true;
  if (end > start) return minute >= start && minute < end;
  return minute >= start || minute < end; // 자정을 넘는 구간
}

const minutesUntilClose = ([start, end]: Interval, minute: number) =>
  end > start ? end - minute : (((end - minute) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;

function strictlyInside(inner: Interval, outer: Interval): boolean {
  const start = outer[0];
  const end = outer[1] <= start ? outer[1] + DAY_MINUTES : outer[1];
  let [innerStart, innerEnd] = inner;
  if (innerStart < start) innerStart += DAY_MINUTES;
  if (innerEnd <= innerStart) innerEnd += DAY_MINUTES;
  return start < innerStart && innerEnd < end;
}

/** 입장 마감 시각이 구간 안이면 그 시각을 닫는 시각으로(자정을 넘는 구간 포함). 밖이면 그대로. */
function capClose(interval: Interval, minute: number): Interval {
  const [start, end] = interval;
  const endUnwrapped = end > start ? end : end + DAY_MINUTES;
  const minuteUnwrapped = minute > start ? minute : minute + DAY_MINUTES;
  return start < minuteUnwrapped && minuteUnwrapped < endUnwrapped ? [start, minuteUnwrapped % DAY_MINUTES] : interval;
}

/** 입장 마감을 같은 줄의 가장 가까운 앞 구간(없으면 뒤 구간, 구간이 하나뿐이면 그 구간)의 닫는 시각으로.
 *  범위의 끝('09:00~17:00 입장마감' 의 17:00)은 입장 마감으로 읽지 않는다 — 그건 이미 닫는 시각이다. */
function applyLastEntry(text: string, opens: LocatedInterval[]): LocatedInterval[] {
  const entries = [...text.matchAll(LAST_ENTRY_RE)].map((m) => ({
    start: m.index!, end: m.index! + m[0].length, minute: clockMinutes(m[1]),
  }));
  for (const m of text.matchAll(ENTRY_UNTIL_RE)) {
    if (/[~\-–—]$/.test(text.slice(0, m.index!).trimEnd())) continue;
    entries.push({ start: m.index!, end: m.index! + m[0].length, minute: clockMinutes(m[1]) });
  }
  const capped = opens.map((located) => ({ ...located }));
  for (const entry of entries) {
    const lineStart = text.lastIndexOf("\n", entry.start - 1) + 1;
    const newline = text.indexOf("\n", entry.end);
    const lineEnd = newline === -1 ? text.length : newline;
    const sameLine = capped.map((_, i) => i).filter((i) => lineStart <= capped[i].start && capped[i].end <= lineEnd);
    const before = sameLine.filter((i) => capped[i].end <= entry.start);
    const after = sameLine.filter((i) => capped[i].start >= entry.end);
    let target: number;
    if (before.length) target = before.reduce((best, i) => (capped[i].end > capped[best].end ? i : best));
    else if (after.length) target = after.reduce((best, i) => (capped[i].start < capped[best].start ? i : best));
    else if (capped.length === 1) target = 0;
    else continue;
    capped[target].interval = capClose(capped[target].interval, entry.minute);
  }
  return capped;
}

interface ParsedHours { alwaysOpen: boolean; opens: Interval[]; breaks: Interval[] }
const hoursCache = new Map<string, ParsedHours>();

/** 영업 구간과 쉬는 시간 구간. 쉬는 시간 = 영업 구간 안쪽의 괄호 범위('11:00~21:00 (15:00~17:00)') 또는
 *  쉬는 시간 말이 붙은 범위('브레이크타임 15:00~17:00'). 다른 말이 붙은 괄호 범위('동절기 09:00~21:00')는 영업 구간.
 *  입장 마감은 그 구간의 닫는 시각이 된다(applyLastEntry). */
function parseOpeningHours(original: string): ParsedHours {
  const cached = hoursCache.get(original);
  if (cached) return cached;
  const raw = capChars(original.normalize("NFKC"), MAX_HOURS_TEXT); // 전각 '０９:００～' → 반각(서버와 같은 입력)
  let parsed: ParsedHours;
  if (ALWAYS_OPEN.test(raw.replace(/<br\s*\/?>/gi, " ").trim())) {
    parsed = { alwaysOpen: true, opens: [], breaks: [] };
  } else {
    const text = raw.replace(/<br\s*\/?>/gi, "\n");
    const parens = [...text.matchAll(/\(([^()]*)\)/g)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, inner: m[1] }));
    const matches = [...text.matchAll(TIME_RANGE_RE)];
    const opens: LocatedInterval[] = [];
    const breaks: Interval[] = [];
    const bare: LocatedInterval[] = [];
    matches.forEach((match, index) => {
      const start = match.index!;
      const end = start + match[0].length;
      const located: LocatedInterval = { start, end, interval: [clockMinutes(match[1]), clockMinutes(match[2])] };
      const paren = parens.find((p) => p.start < start && end < p.end);
      if (paren) {
        if (hasBreakWord(paren.inner)) breaks.push(located.interval);
        else if (paren.inner.trim() === match[0].trim()) bare.push(located);
        else opens.push(located);
        return;
      }
      // 괄호 밖: 같은 절(줄·쉼표)에서 범위 바로 앞의 말, 또는 절 끝까지 다른 범위가 없을 때 뒤의 말을 본다.
      const clauseStart = Math.max(...["\n", ",", ";"].map((d) => text.lastIndexOf(d, start - 1))) + 1;
      const previousEnd = index ? matches[index - 1].index! + matches[index - 1][0].length : 0;
      const before = text.slice(Math.max(clauseStart, previousEnd), start);
      const clauseEnds = ["\n", ",", ";"].map((d) => text.indexOf(d, end)).filter((pos) => pos !== -1);
      const clauseEnd = clauseEnds.length ? Math.min(...clauseEnds) : text.length;
      const nextStart = index + 1 < matches.length ? matches[index + 1].index! : text.length;
      const after = nextStart >= clauseEnd ? text.slice(end, clauseEnd) : "";
      if (hasBreakWord(before) || hasBreakWord(after)) breaks.push(located.interval);
      else opens.push(located);
    });
    bare.forEach((located) => {
      if (opens.some((outer) => strictlyInside(located.interval, outer.interval))) breaks.push(located.interval);
      else opens.push(located);
    });
    parsed = { alwaysOpen: false, opens: applyLastEntry(text, opens).map((located) => located.interval), breaks };
  }
  hoursCache.set(original, parsed);
  return parsed;
}

function statusFromIntervals(opens: Interval[], breaks: Interval[], minute: number): ArrivalOpenStatus {
  const containing = opens.filter((interval) => intervalContains(interval, minute));
  if (containing.length === 0 || breaks.some((interval) => intervalContains(interval, minute))) return "closed_confirmed";
  // 겹치는 구간이 여럿이면 가장 늦게 닫는 구간을 쓴다('11:00~15:00, 09:00~22:00' 의 14:45 는 영업 중이다).
  let remaining: number | null = containing.some(isFullDay)
    ? null
    : Math.max(...containing.map((interval) => minutesUntilClose(interval, minute)));
  for (const [start] of breaks) {
    const untilBreak = (((start - minute) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
    if (untilBreak && (remaining === null || untilBreak < remaining)) remaining = untilBreak; // 곧 쉬는 시간
  }
  return remaining !== null && remaining <= 30 ? "closing_soon" : "open_expected";
}

function kstParts(at: Date): { weekday: number; minutes: number; year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    weekday: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const value = (kind: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === kind)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(value("weekday"));
  return {
    weekday,
    minutes: Number(value("hour")) * 60 + Number(value("minute")),
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
  };
}

/** 영업시간이 없는 음식점·카페의 심야(22:00~05:59) 표시는 더 강한 확인 경고를 쓴다. */
export function getArrivalOpenDisplayStatus(
  status: ArrivalOpenStatus,
  facilityType: string | null | undefined,
  arrival: Date,
): ArrivalOpenDisplayStatus {
  const { minutes } = kstParts(arrival);
  const isLateNight = minutes >= 22 * 60 || minutes < 6 * 60;
  return status === "needs_confirmation"
    && (facilityType === "cafe" || facilityType === "restaurant")
    && isLateNight
    ? "likely_closed_unknown"
    : status;
}

/** 한국 현지 도착시각 기준 영업 상태. 파싱할 근거가 없으면 needs_confirmation. */
export function getArrivalOpenStatus(hours: OperatingHours, arrival: Date = new Date()): ArrivalOpenStatus {
  const source = hours && typeof hours === "object" ? hours : {};
  const closed = closedDayStatus(source.closed, arrival);
  if (closed === "closed") return "closed_confirmed";
  // 격주·서수 없는 매월 휴무의 그 요일 — 시각 범위가 있어도 그날 연다고 말할 수 없다.
  if (closed === "uncertain") return "needs_confirmation";
  const { weekday, minutes } = kstParts(arrival);
  const dayKey = weekday >= 1 && weekday <= 5 ? "weekday" : "weekend";
  // 빈 문자열도 다음 칸으로 넘긴다(서버 `or` 와 같다).
  const { alwaysOpen, opens, breaks } = parseOpeningHours(String(source[dayKey] || source.open || ""));
  if (alwaysOpen) return "open_expected";
  if (opens.length === 0) return "needs_confirmation";
  return statusFromIntervals(opens, breaks, minutes);
}

/** 즉시/장애 폴백 추천은 도착 후 30분 넘게 영업할 근거가 있는 장소만 허용한다. */
export function isRecommendationOpen(
  facilityType: string,
  hours: OperatingHours,
  arrival: Date = new Date(),
): boolean {
  const status = getArrivalOpenStatus(hours, arrival);
  if (status === "closed_confirmed" || status === "closing_soon") return false;
  return status === "open_expected" || !["cafe", "restaurant"].includes(facilityType);
}
