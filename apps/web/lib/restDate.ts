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
// 대소문자 무시(i 깃발)도 쓰지 않는다 — 글을 소문자로 맞춘 뒤 읽는다(파이썬 re.I 는 터키어 점 없는 i(U+0131)·점 있는
// I(U+0130)를 [a-z] 로 받지만 JS 는 아니어서 같은 원문에 두 쪽 답이 갈린다).
//
// 입력은 먼저 다듬는다(cleanSource — 서버 _clean_source 와 같은 순서): 폭 없는 글자(U+200B~U+200D · U+2060 ·
// U+FEFF)를 지우고, 파이썬만 공백으로 보는 제어 글자를 공백으로, NFKC(전각 숫자·물결·괄호 → 반각), BMP 밖 글자
// (이모지)는 대체 문자 하나로, 소문자로, 태그·주소(URL · 'instagram.com/…' 같은 도메인)를 걷어 낸 **뒤에** 휴무 칸은
// 앞 600자·영업시간 칸은 500자만 읽는다. 잘렸으면 무엇도 단정하지 않는다(휴무 칸은 모든 날 uncertain, 영업시간 칸은
// needs_confirmation).
//
// 휴무일 원문(operating_hours.closed · features.rest_date_raw — TourAPI restdate 계열):
//  · 요일 글자 덩어리: 앞이 숫자면 아니다(1월 · 15일). 앞이 한글이면 휴무 앞말(매주·격주·휴무·휴관…)이 붙어 있거나
//    바로 뒤에 '요일'('욜') 이 붙을 때만 요일이다. 한글 뒤에 붙은 '일' 은 '요일' 이 붙지 않으면 '날' 이다(휴관일).
//  · 그리고 요일이라는 근거가 하나 있어야 한다 — '요일' 이 붙었거나, 구분 기호로 이은 목록이거나(월,화 · (월) (화)),
//    뒤에(뒤이은 요일·조사·괄호를 건너) 휴무 낱말이 오거나(토일 휴무 · 월 휴무 · 토 일 휴무), 휴무 앞말이 바로 앞에
//    있거나(휴무: 월 · 매주 토일 · 정기휴무 (수) · 쉬는 날 - 일), 칸 전체가 요일뿐이거나(토일). 근거 없는 낱글자·덩어리는
//    요일이 아니다 — '변동될 수 있음' 의 '수', '일 년에', '월 중 하루', '휴관 일정', '토일은 예약제', '수목 정비', '수일 내'.
//  · 붙여 쓴 덩어리는 요일 순서여야 한다(월<화<…<일 — 휴무 낱말·앞말이 붙으면 '일월'·'토일월' 처럼 주를 한 번 넘어도
//    된다). '금일'(오늘)·'수일'(며칠)은 덩어리로 읽지 않는다. 일곱 요일이 다 나오는데 휴무 낱말이 없으면 규칙이 아니다.
//  · 읽은 요일이 지금의 휴무가 아닌 경우: 뒤에(조사 '에·은·도·만·까지' 를 건너) 영업시간·영업 말이 오거나(일요일에도
//    영업 · 토요일은 10:00~15:00), 같은 절에 영업 말만 있고 휴무 말이 없거나(…21시까지 연장 운영), 앞에 영업 앞말이
//    있거나(영업: 월~금), 휴무를 부정하거나(휴무 없음 · 휴무 아님 · 주말 무휴), 지난 일이거나(휴무였으나 · 월요일에서
//    화요일로 · 월요일 → 화요일), 다른 날을 가리킬 때(일요일 다음날 휴무). '영업 안 함' '영업을 쉽니다' '영업 없음'
//    '영업휴무' '영업 불가' '미운영' 은 휴무다. '토요일 오후 휴무' 와 '토(격주)' 는 그 요일 모름(uncertain).
//  · '연중무휴' / '무휴'                                  → 다른 휴무 규칙이 하나도 없을 때만 휴무 없음
//  · '매월 첫째/둘째·넷째/마지막 주 월요일' · '둘,넷째 주' · '제1·3 화요일' · '끝주 화요일' · '1st and 3rd Sundays'
//                                                         → 그날이 이 달의 몇 번째 그 요일인지 계산
//  · '격주 월요일' · '매월 1회 월요일' · 'every other Monday'      → 그 요일은 모름(uncertain)
//  · '월요일이 공휴일이면 화요일' · '공휴일 다음날(월요일과 겹치면 화요일)' · '(일요일인 경우 월요일)' 같은 대체 휴무
//    → 버린다(공휴일 달력이 없다). 조건절은 결과 절까지, 새 규칙 표지(매주·매월·격주·정기)로 시작하는 뒤 절은 남긴다.
//  · 영어 요일 이름은 같은 절에 휴무 말(closed · holiday · day off · 휴무)이 있거나 절이 요일뿐일 때만 휴무다.
//  · 그 외(명절·설날·비정형 문구 포함)                     → 규칙 없음(null)

/** 휴무일 원문이 그날에 대해 말하는 것 — closed=휴무, uncertain=그 요일을 말하지만 그날인지 모름,
 *  open=규칙을 읽었고 그날은 해당 없음(연중무휴 포함). 읽을 규칙이 없으면 null. */
export type ClosedDayStatus = "closed" | "uncertain" | "open";

const WEEKDAY_CHARS = "월화수목금토일"; // 인덱스: 월=0 … 일=6 (서버 datetime.weekday() 와 같은 순서)
const DAY = "[월화수목금토일]";
const YOIL = "(?:요일|욜)";
// 요일 글자 덩어리(한 글자 이상)를 구분 기호(· , / 、 ~ - 〜)로 이은 목록. '(월) (화)' 처럼 괄호마다 쓴 목록도 잇는다.
const DAY_SEP = "\\s*(?:[·,/、~\\-–〜∼]|\\)\\s*\\()\\s*";
// 덩어리는 일곱 글자까지만(요일 순서로 한 바퀴) — 더 긴 요일 글자 줄('월화월화…')을 자리마다 끝까지 되읽지 않게.
const DAY_RUN = "[월화수목금토일]{1,7}(?![월화수목금토일])";
const DAY_LIST = `${DAY_RUN}(?:${DAY_SEP}${DAY_RUN})*`;
// 'g' 가 붙은 정규식은 '이 자리부터 찾기'(execAt)나 matchAll·replace 로만 쓴다 — 한 정규식에 두 방식을 섞지 않는다.
const DAY_RUN_RE = new RegExp(`(${DAY_LIST})(\\s*${YOIL})?`, "g");
const DAY_SEP_RE = new RegExp(DAY_SEP);
// 요일처럼 생겼지만 요일이 아닌 두 글자 — '금일'(오늘) · '수일'(며칠).
const NOT_DAY_RUNS = new Set(["금일", "수일"]);
// 휴무를 말하는 앞말 — 요일 바로 앞에 오면(붙여 써도, 사이에 쌍점·괄호·줄표가 있어도) 요일이다.
const CLOSURE_PREFIX_RE = /(?:매주|격주|격월|매월|매달|휴무일?|휴관일?|휴업일?|휴점일?|정기\s*휴[무관업점일]일?|쉬는\s*날)(?:\s*[:()\-–~〜\/·])*\s*$/;
// 요일 앞에 오면 영업 요일이라는 앞말('영업: 월~금' · '운영일 : 화~일').
const OPEN_PREFIX_RE = /(?:영업|운영|개방|오픈|개장)\s*(?:일|시간|요일)?\s*:\s*$/;
// 요일 뒤에(조사·이음말·괄호를 건너) 바로 오면 휴무 요일이라는 말.
const CLOSURE_WORD = "휴무|휴관|휴업|휴점|휴장|휴일|정기|쉼|쉽|쉬|공휴일|법정|closed";
const CLOSURE_AFTER_RE = new RegExp(`^(?:\\s*(?:은|는|에|엔|도|및|과|와|[,·/()]))*\\s*(?:${CLOSURE_WORD})`);
// 휴무를 말하는 낱말이 하나라도 있는지 — 일곱 요일이 다 나온 문구를 휴무로 읽을지, 절이 영업만 말하는지 가른다.
const CLOSURE_ANY_RE = /휴무|휴관|휴업|휴점|휴장|쉼|쉽|쉬|정기|매주|closed/;
// 칸 전체가 요일·구분 기호·괄호·'요일'·공백뿐인지('토일' · '월, 화' · '월요일' · '(월) (화)').
const ONLY_DAYS_RE = /^(?:[월화수목금토일·,\/、~\-–〜∼()\s]|요일|욜)+$/;
// '변동될 수 있음' 의 '수'.
const SU_ITTDA_RE = /^\s*(?:있|없)/;
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
// 숫자·밑줄·@·# 에 붙은 이름('sunday_bakery' · '@mon_cafe')은 요일이 아니다.
const EN_DAY_SOURCE = `(^|[^a-z0-9_@#])(${EN_DAY_NAMES})s?(?![a-z0-9_])`;
const EN_DAY_RE = new RegExp(EN_DAY_SOURCE, "g");
const EN_DAY_FIRST_RE = new RegExp(EN_DAY_SOURCE);
const EN_WEEKEND_RE = /(^|[^a-z0-9_@#])weekends?(?![a-z0-9_])/g;
const EN_OPEN_RE = /(?:^|[^a-z])open(?![a-z])/;
const EN_CLOSED_BEFORE_RE = /(?:^|[^a-z])closed?(?![a-z])/;
// 영어 요일 이름이 휴무라는 근거 — 같은 절(, ; / 줄)의 휴무 말, 또는 절 전체가 요일뿐('Mondays' · 'Every Monday').
const EN_CLOSURE_CONTEXT_RE = /(?:^|[^a-z])(?:closed?|closing|holidays?|days?\s*off)(?![a-z])|휴무|휴관|휴업|휴점|휴장|정기|쉬는\s*날/;
const EN_DAY_WORD = `(?:(?:every|each|on)\\s+)?(?:${EN_DAY_NAMES}|weekend)s?\\.?`;
const EN_ONLY_DAYS_RE = new RegExp(
  `^[\\s:().\\-–]*${EN_DAY_WORD}(?:(?:\\s*(?:[,&\\-–~]|and|or)\\s*|\\s+)${EN_DAY_WORD})*[\\s:().]*$`,
);
// 'Tue-Sun: 10am-6pm' — 영업 여부는 뒤이은 요일들까지 건너 마지막에 붙은 말로 본다.
const EN_MORE_DAYS_RE = new RegExp(`^(?:\\s*(?:[-–~〜,/&]|and|to|through|thru)\\s*(?:${EN_DAY_NAMES})s?(?![a-z0-9_])){0,6}`);
const EN_CLAUSE_DELIMITERS = [",", ";", "\n", "/"];
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

// 공휴일 대체 휴무 조건. 공휴일 낱말·'월요일이 공휴일'·'월요일과 겹치면'·'일요일인 경우' 에서 시작하는 절만 조건절로
// 본다(공휴일 낱말이 원문 어디에도 없으면 조건절을 찾지 않는다 — dropHolidayConditions).
// '정기휴일 매주 월요일' 의 '휴일' 은 공휴일이 아니다(앞이 한글이면 홀로 선 '휴일' 로 치지 않는다).
const HOLIDAY_WORD = "(?:법정\\s*)?(?:공휴일|국경일|명절|연휴|대체\\s*휴일)|(?:^|[^가-힣])휴일|(?:^|[^a-z])holidays?(?![a-z])";
const HOLIDAY_RE = new RegExp(HOLIDAY_WORD);
// 참 조건(결과 절을 가진다)과 '다음날' 류(공휴일 다음날 휴무 — 결과 절이 없다).
const TRUE_CONDITION = "경우|이면|이라면|일\\s*때|인\\s*때|겹치|겹칠|(?:^|[^a-z])(?:if|when)(?![a-z])";
const RELATIVE_DAY = "다음\\s*날|익일|이튿날|(?:^|[^a-z])(?:following|next\\s+day)(?![a-z])";
const TRUE_CONDITION_RE = new RegExp(TRUE_CONDITION);
const RELATIVE_DAY_RE = new RegExp(RELATIVE_DAY);
const CONDITION_RE = new RegExp(`${TRUE_CONDITION}|${RELATIVE_DAY}`);
// 조건절이 시작되는 자리 — '월요일이 공휴일…' · '월요일과 겹치면…' · '일요일인 경우…' · '월요일이 설날 연휴와
// 겹치는 경우…' 의 주어, 또는 공휴일 낱말(matchAll 로만 쓴다).
const CONDITION_START_RE = new RegExp(
  `${DAY}\\s*요일(?:이|가|은|는)\\s*(?:${HOLIDAY_WORD})`
  + `|${DAY}\\s*요일(?:인|이|일|가|은|는|과|와)\\s*(?=경우|때|면|라면|겹)`
  + `|${DAY}\\s*요일(?:이|가|은|는)\\s(?=[^,\\n;]{0,20}?(?:겹|경우|이면|라면))`
  + `|${HOLIDAY_WORD}`,
  "g",
);
// 조건절 끝을 찾는 이음말(execAt 로만 쓴다). '…과 겹치면' 의 '과' 는 이음말이 아니라 '겹치다' 의 짝이다.
const JOIN_RE = /및|과|와|\//g;
const OVERLAP_AFTER_RE = /^\s*겹/;
// 참 조건의 결과('화요일 및 수요일 휴관')는 새 규칙의 표지가 요일보다 먼저 나오는 이음말에서 끝난다.
const RULE_MARKER_RE = /매주|매월|매달|격주|정기/;
const DAY_CHAR_RE = /[월화수목금토일]/;

// 서수 안의 선택 조각은 모두 '공백 + 반드시 있는 글자'(번·째·주) 꼴 — 공백만 홀로 선택되는 자리가 없게.
// '주' 는 뒤에 '일' 이 오면 서수의 일부로 읽지 않는다('1주일' = 일주일) — 그 '일' 이 '일요일' 일 때만 예외('첫째주일요일').
// '끝(주)' 는 마지막 주다.
const ORDINAL = "(?:첫(?:\\s*번)?(?:\\s*째)?|둘\\s*째|두\\s*번\\s*째|셋\\s*째|세\\s*번\\s*째|넷\\s*째|네\\s*번\\s*째"
  + "|다섯(?:\\s*번)?\\s*째|마지막|끝|[1-5](?:\\s*번)?(?:\\s*째)?)(?:\\s*(?:주차|주(?!일(?!요일))))?";
// 서수 사이 이음 — 구두점 / 및·과·와 / 공백, 서로 겹치지 않는 세 갈래.
const ORDINAL_SEP = "(?:\\s*[·,/、&]\\s*|\\s*(?:및|과|와)\\s*|\\s+)";
// '둘째넷째' 처럼 붙여 쓴 서수는 읽기 전에 사이를 띄운다('째' 다음에 서수가 오는 자리).
const GLUED_ORDINAL_RE = /째(?=첫|둘|두|셋|세|넷|네|다섯|마지막|[1-5])/g;
// '둘,넷째 주' 처럼 '째' 를 한 번만 쓴 서수 목록은 앞 서수에도 '째' 를 붙인다.
const ELLIPSIS_ORDINAL_RE = /(둘|셋|넷)(?=\s*(?:[,·\/、&]|및|와|과)\s*(?:첫|둘|셋|넷|다섯)\s*째)/g;
// 앞이 숫자인 서수('12월' 의 '2')는 정규식 밖에서 거른다. '제1·3 화요일' 의 '제' 는 서수 표지다.
const MONTHLY_RE = new RegExp(
  `(?:(?:매월|매달)\\s*)?((?:제\\s*)?${ORDINAL}(?:${ORDINAL_SEP}${ORDINAL}){0,4})\\s*(?:의\\s*)?(${DAY_LIST})(\\s*${YOIL})?`,
  "g",
);
// 숫자만 있는 서수('1월'·'15일')는 날짜일 수 있어 서수로 보지 않는다.
const ORDINAL_MARK_RE = /[째주번제]|첫|둘|셋|넷|다섯|마지막|끝/;
const ORDINAL_TOKEN_RE = /첫|둘|두|셋|세|넷|네|다섯|마지막|끝|[1-5]/g;
const LAST_ORDINALS = ["마지막", "끝"];
const ORDINAL_VALUE: Record<string, number> = {
  첫: 1, 1: 1, 둘: 2, 두: 2, 2: 2, 셋: 3, 세: 3, 3: 3, 넷: 4, 네: 4, 4: 4, 다섯: 5, 5: 5,
};
const KO_UNCERTAIN_MARKER_RE = /격주|격월|매월|매달/g;
const EN_UNCERTAIN_RE = /(^|[^a-z])(?:every\s+other|alternate|alternating|bi-?weekly)(?![a-z])/g;
// '토(격주), 일' · '토요일(격주 휴무)' — 괄호로 격주를 단 요일은 그날 모름이다(목록은 그대로 잇는다).
const ANNOTATED_UNCERTAIN_RE = new RegExp(`(${DAY})(\\s*${YOIL})?\\s*\\(\\s*(?:격주|격월)[^()]{0,8}\\)`, "g");
// 요일 뒤 조사('일요일에도'·'토요일은'·'일요일만'·'일요일까지')는 건너뛴다 — 서로 겹치지 않는 갈래라 되돌아보기가
// 늘지 않는다.
const AFTER_PARTICLES = "(?:\\s*(?:에|엔|은|는|도|만|까지))*";
// 영업 말 뒤의 부정('영업 안 함' · '운영하지 않음' · '영업을 쉽니다' · '영업 없음' · '영업휴무' · '영업 불가').
const OPEN_NEGATION = "\\s*(?:을|를|은|는)?\\s*(?:안|않|하지\\s*않|중지|중단|정지|불가|없|쉼|쉽|쉬|휴무|휴업|종료|x(?![a-z]))";
const TIME_AFTER_RE = new RegExp(`^${AFTER_PARTICLES}\\s*(?::\\s*)?[0-9]{1,2}\\s*(?::|시|am|pm|a\\.m|p\\.m)`);
const OPEN_AFTER_RE = new RegExp(`^${AFTER_PARTICLES}\\s*(?:영업|운영|개방|오픈|개장|정상|open)(?!${OPEN_NEGATION})`);
const PARTIAL_DAY_AFTER_RE = new RegExp(`^${AFTER_PARTICLES}\\s*(?:오전|오후|점심|저녁|야간)`);
// 지금의 휴무가 아니라는 말 — 다른 날('일요일 다음날'), 휴무 부정('휴무 없음' · '휴무 아님'), 무휴('주말 무휴'),
// 지난 규칙('휴무였으나'), 바뀌기 전 요일('월요일에서 화요일로' · '월요일 → 화요일').
const NOT_CLOSURE_AFTER_RE = new RegExp(
  "^(?:(?:\\s*의)?\\s*(?:다음\\s*날|익일|이튿날|전\\s*날)"
  + `|${AFTER_PARTICLES}[\\s)]*(?:휴무|휴관|휴업|휴점|휴장|쉬는\\s*날)(?:일)?\\s*(?:은|는|이|가)?\\s*(?:없|아님|아니|x(?![a-z]))`
  + `|${AFTER_PARTICLES}\\s*(?:연중\\s*)?무휴`
  + `|${AFTER_PARTICLES}\\s*(?:휴무|휴관|휴업|휴점|휴장)(?:일)?(?:이)?\\s*(?:였|었)`
  + `|\\s*에서\\s*${DAY}\\s*${YOIL}?\\s*(?:으로|로)(?![가-힣])`
  + `|${AFTER_PARTICLES}\\s*(?:휴무|휴관|휴업|휴점|휴장)?(?:일)?\\s*(?:→|->|=>|⇒))`,
);
// 같은 절에 영업 말만 있고 휴무 말이 없으면('수요일 … 21시까지 연장 운영') 그 요일은 휴무가 아니다.
// 절 끝 — 줄·쉼표·쌍반점·빗금과 글머리표(※ ▷ ▶ • ◆ ◇ ■ □ ○ ● |).
const CLAUSE_END_RE = /[\n,;\/※▷▶•◆◇■□○●|]/;
const OPEN_WORD_RE = /영업|운영|개방|오픈|개장/;
const OPEN_NEGATION_RE = new RegExp(`^${OPEN_NEGATION}`);
// '월요일을 제외하고 매일 영업' — 제외한 요일은 휴무다.
const EXCEPT_RE = /제외|빼고|말고|외에는|외엔|이외/;
// 요일과 영업 말 사이에 조건이 끼면('매주 화요일(공휴일 영업)' · '(단체 예약 시 영업)') 그 영업은 예외 안내다 — 요일은 휴무.
const OPEN_CONDITION_RE = /공휴일|명절|연휴|휴일|예약|경우|당일|단체|때|성수기|비수기|방학|행사|이면|(?:^|[^가-힣])시(?![가-힣])/;
const DIGIT_AFTER_RE = /^\s*[0-9]/;
const HANGUL_OR_DIGIT_RE = /^[가-힣0-9]/;
// '토요일, 일요일도 영업' — 영업 여부는 뒤이은 요일들까지 건너 마지막에 붙은 말로 본다(구분 갈래는 서로 겹치지 않게).
const MORE_DAYS_RE = new RegExp(`^(?:(?:\\s*[,·/]\\s*|\\s*(?:및|과|와)\\s*|\\s+)${DAY_RUN}(?:\\s*${YOIL})?){0,6}`);
// 입력 다듬기 — 폭 없는 글자 · 파이썬만 공백으로 보는 제어 글자 · BMP 밖 글자 · 태그 · 주소(URL · 도메인).
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
const ODD_SPACE_RE = /[\x1C-\x1F\x85]/g;
const ASTRAL_RE = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
const REPLACEMENT_CHAR = "\uFFFD";
const BR_RE = /<br\s*\/?>/g;
// 태그 안에 '<' 는 없다 — '<<<…' 같은 입력에서 태그 찾기가 끝까지 되읽지 않게 막는다.
const TAG_RE = /<[^<>]+>/g;
// 도메인은 낱말 머리에서만 찾고(1번 묶음 = 앞 글자, 지우지 않고 남긴다) 뒤 이름표는 셋까지만 — 'xxxx…' ·
// '.a.a.a…' 같은 입력에서 되돌아보기가 길이의 제곱으로 늘지 않게.
const URL_RE = /(?:https?:\/\/|www\.)\S+|(^|[^a-z0-9_-])[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+){0,3}\.(?:com|net|org|kr|io|me|info|biz|jp|cn|us)(?![a-z0-9])(?:\/\S*)?/g;
const PAREN_RE = /\(([^()]*)\)/g;
// 다듬기 전 원문 상한 — 실제 문구는 태그를 넣어도 1,000자 안팎이다. 넘으면 잘린 원문으로 본다.
const MAX_RAW_TEXT = 4000;
// 태그·주소를 걷은 뒤 600자 — 단체 관람 안내처럼 긴 문구 뒤의 정기 휴관일까지 읽는다.
const MAX_CLOSED_TEXT = 600;

interface ClosedDayRules {
  openAllYear: boolean;
  weekly: Set<number>;
  monthly: { ordinals: Set<number>; last: boolean; days: Set<number> }[];
  uncertain: Set<number>;
  truncated: boolean;
}

/** 전역 정규식을 `pos` 자리부터 한 번 찾는다(파이썬 pattern.search(text, pos) 와 같은 뜻). */
function execAt(re: RegExp, text: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(text);
}

/** 글이 코드 포인트로 `max` 글자보다 긴지(파이썬 len 과 같은 뜻 — 긴 글을 통째로 펼치지 않는다). */
function longerThan(text: string, max: number): boolean {
  if (text.length <= max) return false;
  let count = 0;
  for (const _char of text) {
    count += 1;
    if (count > max) return true;
  }
  return false;
}

/** 원문의 앞 `max` 글자(코드 포인트 기준 — 파이썬 슬라이스와 같은 뜻). */
function capChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let count = 0;
  let end = 0;
  for (const char of text) {
    if (count === max) break;
    count += 1;
    end += char.length;
  }
  return text.slice(0, end);
}

function cleanText(raw: string): string {
  return raw
    .replace(ZERO_WIDTH_RE, "")
    .replace(ODD_SPACE_RE, " ")
    .normalize("NFKC")
    .replace(ASTRAL_RE, REPLACEMENT_CHAR)
    .toLowerCase()
    .replace(BR_RE, "\n")
    .replace(TAG_RE, " ")
    .replace(URL_RE, (_url, before: string | undefined) => `${before ?? ""} `);
}

/** 두 파서가 함께 쓰는 입력 다듬기 — 서버 _clean_source 와 같은 순서. [다듬은 글(앞 `cap` 글자), 잘렸는지]. */
function cleanSource(raw: string, cap: number): [string, boolean] {
  const cleaned = cleanText(capChars(raw, MAX_RAW_TEXT));
  return [capChars(cleaned, cap), longerThan(raw, MAX_RAW_TEXT) || longerThan(cleaned, cap)];
}

/** '월·화' → {0,1}, '월~수' → {0,1,2}(범위는 요일 순서로, '금~월' 처럼 주를 넘겨도 된다). */
function expandDayList(text: string): Set<number> {
  const days = new Set<number>();
  let previous: number | null = null;
  let pendingRange = false;
  for (const token of text.match(/[월화수목금토일]|[~\-–〜∼]/g) ?? []) {
    if ("~-–〜∼".includes(token)) {
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
  if (!HOLIDAY_RE.test(text)) return text; // 공휴일 낱말이 없으면 대체 휴무 조건도 없다
  const unwrapped = text.replace(PAREN_RE, (_match, inner: string) => {
    const kept = inner.split(/([,\n;])/).map((piece) => dropConditionClause(piece)).join("");
    // 괄호 안을 다듬고도 공휴일·조건 낱말이 함께 남으면 괄호 전체가 대체 휴무 안내다.
    return HOLIDAY_RE.test(kept) && CONDITION_RE.test(kept) ? " " : ` ${kept} `;
  });
  return unwrapped.split(/([,\n;])/).map((piece) => dropConditionClause(piece)).join("");
}

/** 조건 낱말 앞의 조건절 시작. 가장 가까운 시작에서 앞쪽 시작으로 이어 가되, 그 사이에 휴무 말·규칙 표지가 끼면
 *  멈춘다(서버 _condition_start 와 같은 식). */
function conditionStart(piece: string, anchorStart: number): number | null {
  const starts = [...piece.matchAll(CONDITION_START_RE)].filter((match) => match.index! < anchorStart);
  if (!starts.length) return null;
  let start = starts[starts.length - 1];
  for (let i = starts.length - 2; i >= 0; i -= 1) {
    const earlier = starts[i];
    if (CLOSURE_ANY_RE.test(piece.slice(earlier.index! + earlier[0].length, start.index!))) break;
    start = earlier;
  }
  return start.index!;
}

/** 조건절이 끝나는 자리 — '다음날' 류는 첫 이음말에서, 참 조건은 새 규칙 표지(매주·매월·격주·정기)가 요일보다
 *  먼저 나오는 이음말에서 끝난다. '…과 겹치면' 의 '과' 는 이음말이 아니다. 끝을 못 찾으면 절 끝. */
function conditionEnd(piece: string, pos: number, conditional: boolean): number {
  for (let join = execAt(JOIN_RE, piece, pos); join; join = execAt(JOIN_RE, piece, join.index + join[0].length)) {
    const joinEnd = join.index + join[0].length;
    if (OVERLAP_AFTER_RE.test(piece.slice(joinEnd))) continue;
    if (!conditional) return join.index;
    const following = execAt(JOIN_RE, piece, joinEnd);
    const segment = piece.slice(joinEnd, following ? following.index : piece.length);
    const marker = RULE_MARKER_RE.exec(segment);
    const weekday = DAY_CHAR_RE.exec(segment);
    if (marker && (!weekday || marker.index < weekday.index)) return join.index;
  }
  return piece.length;
}

/** 절 안의 조건절만 지운다 — 첫 조건 낱말 앞의 조건절 시작(conditionStart)부터 그 조건절이 끝나는 자리까지
 *  (conditionEnd). 끝 뒤는 계속 읽는다('공휴일 다음날 휴무 및 매주 월요일 휴무' 의 월요일 규칙은 남는다). */
function dropConditionClause(piece: string): string {
  let kept = "";
  let rest = piece;
  for (;;) {
    const trueMatch = TRUE_CONDITION_RE.exec(rest);
    const relativeMatch = RELATIVE_DAY_RE.exec(rest);
    if (!trueMatch && !relativeMatch) return kept + rest;
    const conditional = Boolean(trueMatch && (!relativeMatch || trueMatch.index <= relativeMatch.index));
    const anchor = (conditional ? trueMatch : relativeMatch) as RegExpExecArray;
    const start = conditionStart(rest, anchor.index);
    if (start === null) return kept + rest; // 조건 낱말은 있지만 공휴일·주어가 앞에 없다 — 조건절이 아니다
    const end = conditionEnd(rest, anchor.index + anchor[0].length, conditional);
    kept += `${rest.slice(0, start)} `;
    if (end >= rest.length) return kept;
    rest = rest.slice(end);
  }
}

/** '요일' 이 붙지 않은 낱글자는 뒤가 한글·숫자면 요일이 아니다('월 2회' 의 '월' = 달). */
function bareDayEndOk(text: string, end: number): boolean {
  const rest = text.slice(end);
  if (HANGUL_OR_DIGIT_RE.test(rest)) return false;
  return !DIGIT_AFTER_RE.test(rest);
}

const dayIndexes = (run: string) => [...run].map((char) => WEEKDAY_CHARS.indexOf(char));

function strictOrder(run: string): boolean {
  const indexes = dayIndexes(run);
  return indexes.every((index, i) => i === 0 || index > indexes[i - 1]);
}

/** 요일 순서로 한 바퀴 안('일월' · '토일월' 처럼 주를 한 번 넘는 것까지). 같은 글자 반복·두 바퀴는 아니다. */
function cyclicOrder(run: string): boolean {
  const indexes = dayIndexes(run);
  let span = 0;
  for (let i = 1; i < indexes.length; i += 1) span += (((indexes[i] - indexes[i - 1]) % 7) + 7) % 7;
  return new Set(indexes).size === indexes.length && span < 7;
}

const badRun = (element: string) => element.length > 1 && (NOT_DAY_RUNS.has(element) || !cyclicOrder(element));

/** 요일 글자 덩어리가 정말 휴무 요일 목록인지 — 규칙은 파일 머리 주석 참조. */
function acceptDayRun(text: string, match: RegExpExecArray, onlyDays: boolean): boolean {
  const start = match.index;
  const end = start + match[0].length;
  const elements = match[1].split(DAY_SEP_RE);
  if (elements.some(badRun)) return false;
  const previous = start ? text[start - 1] : "";
  if (previous && DIGITS.includes(previous)) return false;
  const hasYoil = Boolean(match[2]);
  const prefixed = CLOSURE_PREFIX_RE.test(text.slice(Math.max(0, start - 12), start));
  if (previous && HANGUL_RE.test(previous)) {
    const attached = elements[0].length === 1 && (text.startsWith("요일", start + 1) || text.startsWith("욜", start + 1));
    if (elements[0] === "일" && !attached) return false; // 한글 뒤 '일' = 날(휴관일 · 매주일)
    if (!attached && !prefixed) return false;
  }
  if (hasYoil) return true;
  if (match[1] === "수" && SU_ITTDA_RE.test(text.slice(end))) return false; // '수 있음' · '수 없음'
  // 뒤이은 요일('토 일 휴무' 의 ' 일')과 조사·이음말을 건너 휴무 낱말이 오면 휴무 요일이다.
  const skipped = (MORE_DAYS_RE.exec(text.slice(end)) as RegExpExecArray)[0].length;
  if (CLOSURE_AFTER_RE.test(text.slice(end + skipped))) return true;
  if (!bareDayEndOk(text, end)) return false; // 낱말의 일부('휴관 일정' · '월간' · '월 2회')
  if (prefixed) return true;
  if (elements.some((element) => element.length > 1 && !strictOrder(element))) return false; // '일월' 은 휴무 말이 있어야
  return elements.length > 1 || onlyDays;
}

/** 요일 덩어리를 앞에서부터. 요일이 아닌 자리('당일, 월요일' 의 '일')면 한 글자 뒤에서 다시 찾는다. */
function dayRuns(text: string, onlyDays: boolean, pos = 0, latestStart = Number.POSITIVE_INFINITY): RegExpExecArray[] {
  const runs: RegExpExecArray[] = [];
  let at = pos;
  for (;;) {
    const match = execAt(DAY_RUN_RE, text, at);
    if (!match || match.index > latestStart) return runs;
    if (acceptDayRun(text, match, onlyDays)) {
      runs.push(match);
      at = match.index + match[0].length;
    } else {
      at = match.index + 1;
    }
  }
}

function monthlyDaysOk(text: string, match: RegExpExecArray): boolean {
  if (match[2].split(DAY_SEP_RE).some(badRun)) return false;
  const end = match.index + match[0].length;
  return Boolean(match[3]) || CLOSURE_AFTER_RE.test(text.slice(end)) || bareDayEndOk(text, end);
}

/** 요일 언급(start~end)이 지금의 휴무를 말하는지 — "closed" · "partial"(하루 전체는 아님) · null(휴무 아님). */
function closureMeaning(text: string, start: number, end: number, moreDays: RegExp): "closed" | "partial" | null {
  const before = text.slice(Math.max(0, start - 12), start);
  if (OPEN_PREFIX_RE.test(before)) return null; // '영업: 월~금'
  const skipped = (moreDays.exec(text.slice(end)) as RegExpExecArray)[0].length;
  const rest = text.slice(end + skipped);
  if (TIME_AFTER_RE.test(rest) || OPEN_AFTER_RE.test(rest) || NOT_CLOSURE_AFTER_RE.test(rest)) return null;
  if (PARTIAL_DAY_AFTER_RE.test(rest)) return "partial"; // '토요일 오후 휴무' — 하루 전체가 닫힌 것은 아니다.
  const clauseEnd = CLAUSE_END_RE.exec(rest);
  const clause = clauseEnd ? rest.slice(0, clauseEnd.index) : rest;
  const firstOpen = OPEN_WORD_RE.exec(clause);
  if (
    firstOpen
    && !["미", "비"].includes(firstOpen.index ? clause[firstOpen.index - 1] : "") // '미운영' · '비개방'
    && !OPEN_NEGATION_RE.test(clause.slice(firstOpen.index + firstOpen[0].length))
    && !CLOSURE_ANY_RE.test(clause)
    && !EXCEPT_RE.test(clause.slice(0, firstOpen.index))
    && !OPEN_CONDITION_RE.test(clause.slice(0, firstOpen.index))
    && !CLOSURE_PREFIX_RE.test(before) // '휴무일: 매주 월요일 (공휴일 정상영업)' — 휴무 앞말이 이긴다
  ) {
    return null; // '… 21시까지 연장 운영' — 이 절이 처음 말하는 것이 영업이다
  }
  return "closed";
}

/** 영어 요일 이름이 든 절(, ; / 줄로 나눈 것)과 그 절에서 이름 앞부분. */
function clauseAround(text: string, start: number, end: number): [string, string] {
  const clauseStart = Math.max(...EN_CLAUSE_DELIMITERS.map((d) => (start ? text.lastIndexOf(d, start - 1) : -1))) + 1;
  const ends = EN_CLAUSE_DELIMITERS.map((d) => text.indexOf(d, end)).filter((pos) => pos !== -1);
  return [text.slice(clauseStart, ends.length ? Math.min(...ends) : text.length), text.slice(clauseStart, start)];
}

const closedRulesCache = new Map<string, ClosedDayRules | null>();

function parseClosedDays(raw: string): ClosedDayRules | null {
  const cached = closedRulesCache.get(raw);
  if (cached !== undefined) return cached;
  const [cleaned, truncated] = cleanSource(raw, MAX_CLOSED_TEXT);
  let text = cleaned.replace(/[（［【〔[]/g, "(").replace(/[）］】〕\]]/g, ")");
  let rules: ClosedDayRules | null = null;
  if (text.trim()) {
    const openAllYear = OPEN_ALL_YEAR_RE.test(text);
    const onlyDays = ONLY_DAYS_RE.test(text);
    const closureWords = CLOSURE_ANY_RE.test(text);

    // 0) '토(격주)' — 괄호로 격주를 단 요일은 모름이다. 괄호만 지우고 요일은 남겨 목록을 잇는다.
    const annotated = new Set<number>();
    for (const match of [...text.matchAll(ANNOTATED_UNCERTAIN_RE)]) {
      const start = match.index!;
      const previous = start ? text[start - 1] : "";
      if (previous && HANGUL_OR_DIGIT_RE.test(previous) && !match[2]) continue; // '매월(격주)' 의 '월' 은 요일이 아니다
      annotated.add(WEEKDAY_CHARS.indexOf(match[1]));
      text = blank(text, start + match[0].indexOf("("), start + match[0].length);
    }

    text = dropHolidayConditions(text).replace(ELLIPSIS_ORDINAL_RE, "$1째").replace(GLUED_ORDINAL_RE, "째 ");
    const weekly = new Set<number>();
    const uncertain = new Set<number>();
    const monthly: ClosedDayRules["monthly"] = [];

    // 1) 매월 n번째 요일(한국어). 거른 자리에서는 한 글자 뒤부터 다시 찾는다('12월 둘째 일요일').
    for (let pos = 0, match = execAt(MONTHLY_RE, text, 0); match; match = execAt(MONTHLY_RE, text, pos)) {
      const start = match.index;
      const end = start + match[0].length;
      const group = match[1];
      const prefixed = match[0].startsWith("매월") || match[0].startsWith("매달");
      if (
        (!prefixed && start && DIGITS.includes(text[start - 1]))
        || !ORDINAL_MARK_RE.test(group)
        || !monthlyDaysOk(text, match)
      ) {
        pos = start + 1;
        continue;
      }
      if (closureMeaning(text, start, end, MORE_DAYS_RE) === "closed") {
        const tokens: string[] = group.match(ORDINAL_TOKEN_RE) ?? [];
        monthly.push({
          ordinals: new Set(tokens.filter((token) => !LAST_ORDINALS.includes(token)).map((token) => ORDINAL_VALUE[token])),
          last: tokens.some((token) => LAST_ORDINALS.includes(token)),
          days: expandDayList(match[2]),
        });
      }
      text = blank(text, start, end); // 휴무가 아닌 매월 언급('마지막 수요일 … 연장 운영')도 읽은 것으로
      pos = end;
    }

    // 2) 매월 n번째 요일(영어) — '1st and 3rd Sundays' 는 '매달 1, 3번째 일요일' 과 같은 규칙이다.
    for (let pos = 0, match = execAt(EN_MONTHLY_RE, text, 0); match; match = execAt(EN_MONTHLY_RE, text, pos)) {
      const wordStart = match.index + match[1].length;
      const end = match.index + match[0].length;
      pos = end;
      if (EN_OPEN_RE.test(text.slice(0, wordStart).split(/[,;\n]/).pop() ?? "")) continue; // 'Open the first Monday'
      const tokens: string[] = match[2].match(new RegExp(EN_ORDINAL, "g")) ?? [];
      monthly.push({
        ordinals: new Set(tokens.filter((token) => token !== "last").map((token) => EN_ORDINAL_VALUE[token])),
        last: tokens.includes("last"),
        days: new Set([EN_DAY_INDEX[match[3]]]),
      });
      text = blank(text, wordStart, end);
    }

    // 3) 서수 없는 매월·격주 — 그 요일은 모름. 표시(격주·매월) 뒤 12글자 안에서 시작하는 요일 덩어리.
    for (const marker of [...text.matchAll(KO_UNCERTAIN_MARKER_RE)]) {
      const markerEnd = marker.index! + marker[0].length;
      if (text.slice(marker.index!, markerEnd) !== marker[0]) continue; // 앞 단계가 이미 읽어 지운 자리
      const run = dayRuns(text, onlyDays, markerEnd, markerEnd + 12)[0];
      if (!run) continue;
      const gap = text.slice(markerEnd, run.index);
      if (gap.includes("매주") || gap.includes("\n") || gap.includes(";")) continue;
      expandDayList(run[1]).forEach((day) => uncertain.add(day));
      text = blank(text, marker.index!, run.index + run[0].length);
    }

    for (const marker of [...text.matchAll(EN_UNCERTAIN_RE)]) {
      const wordStart = marker.index! + marker[1].length;
      const markerEnd = marker.index! + marker[0].length;
      if (text.slice(wordStart, markerEnd) !== marker[0].slice(marker[1].length)) continue;
      const window = text.slice(markerEnd, markerEnd + 30).split(/[,;\n]/)[0];
      const day = EN_DAY_FIRST_RE.exec(window);
      if (day) {
        uncertain.add(EN_DAY_INDEX[day[2]]);
        text = blank(text, wordStart, markerEnd + day.index + day[0].length);
      }
    }

    // 4) 매주 요일
    const finalText = text;
    const addDays = (days: Set<number>, start: number, end: number, moreDays: RegExp = MORE_DAYS_RE) => {
      const meaning = closureMeaning(finalText, start, end, moreDays);
      if (meaning === "closed") days.forEach((day) => weekly.add(day));
      else if (meaning === "partial") days.forEach((day) => uncertain.add(day));
    };
    for (const run of dayRuns(finalText, onlyDays)) addDays(expandDayList(run[1]), run.index, run.index + run[0].length);
    for (const match of finalText.matchAll(KO_WEEKEND_RE)) {
      addDays(new Set([5, 6]), match.index!, match.index! + match[0].length);
    }
    const englishSources: [RegExp, (match: RegExpMatchArray) => Set<number>][] = [
      [EN_DAY_RE, (match) => new Set([EN_DAY_INDEX[match[2]]])],
      [EN_WEEKEND_RE, () => new Set([5, 6])],
    ];
    for (const [regex, daysOf] of englishSources) {
      for (const match of finalText.matchAll(regex)) {
        const wordStart = match.index! + match[1].length;
        const end = match.index! + match[0].length;
        const [clause, before] = clauseAround(finalText, wordStart, end);
        if (EN_OPEN_RE.test(before)) continue; // 'Open Mon-Sat, closed Sundays' 의 영업 요일
        if (EN_CLOSED_BEFORE_RE.test(before)) {
          daysOf(match).forEach((day) => weekly.add(day)); // 'Closed Wednesdays (open on public holidays)'
        } else if (EN_CLOSURE_CONTEXT_RE.test(clause) || EN_ONLY_DAYS_RE.test(clause)) {
          addDays(daysOf(match), wordStart, end, EN_MORE_DAYS_RE);
        }
      }
    }

    if (weekly.size === 7 && !closureWords) weekly.clear(); // '월화수목금토일' · '월~일' — 휴무 낱말 없이 일곱 요일
    annotated.forEach((day) => weekly.delete(day));
    annotated.forEach((day) => uncertain.add(day));
    weekly.forEach((day) => uncertain.delete(day));
    // 명시한 매주·매월 규칙이 하나도 없을 때만 '무휴' 가 연중무휴다('매주 월요일 휴관 (7~8월 무휴)').
    const hasRules = weekly.size > 0 || monthly.length > 0 || uncertain.size > 0;
    rules = { openAllYear: !hasRules && openAllYear, weekly, monthly, uncertain, truncated };
  }
  closedRulesCache.set(raw, rules);
  return rules;
}

/** 휴무일 원문이 `at`(한국 날짜)에 대해 말하는 것. 서버 closed_day_status 와 같은 판정. */
export function closedDayStatus(restRaw: unknown, at: Date): ClosedDayStatus | null {
  const rules = parseClosedDays(String(restRaw || ""));
  if (!rules) return null;
  if (rules.truncated) return "uncertain"; // 600자를 넘겨 잘린 원문 — 뒤쪽을 못 읽었으니 단정하지 않는다
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

// 영업시간 원문: 시각 범위('09:00~18:00')를 영업 구간으로 읽는다. 쉬는 시간은 닫힌 구간이다 — 쉬는 시간 말이 범위
// **바로 앞**에 있을 때('브레이크타임 15:00~17:00' · '(브레이크타임 15시~17시)' · '(break 3-5pm)' — '15시~17시'·
// '3-5pm' 꼴은 이 경우에만 읽는다). 쉬는 시간 말이 범위 **뒤**에 붙었거나('15:00~17:00 브레이크타임' ·
// '(15:00~16:00 브레이크)') 말 없는 괄호 범위('11:00~21:00 (15:00~17:00)')가 다른 영업 구간 안쪽에 짧게 들어 있으면
// '쉬는 시간일 수도' — 그 시간에는 needs_confirmation 이다. 모르는 것을 closed_confirmed 로 만들지 않는다. 시각 없는
// 쉬는 시간 말('(휴게시간 있음)')은 어느 범위도 쉬는 시간으로 만들지 않는다. '휴게'·'휴식' 은 바로 뒤에 '시간' 이나
// 시각이 올 때만 쉬는 시간 말이다('휴게소'·'휴게음식점'·'휴식 공간' 은 아니다 · 'Breakfast' 도 아니다).

// 하루 종일 열려 있는 곳 — '상시 개방'·'상시개방'·'24시간'·'연중 개방'(경주 계림·월성·황룡사지·석빙고 같은
// 야외 유적, 도심 관광지 33곳 중 14곳). 시각 범위가 없어 '영업시간 미확인' 으로 떨어지던 문구다.
// 문자열 **전체**가 이 말일 때만 인정한다 — '점포 별로 상이함'·'시설별로 상이함' 같은 문장은 그대로 미확인.
const ALWAYS_OPEN = /^(?:연중\s*무휴\s*)?(?:상시\s*(?:개방|운영)?|24\s*시(?:간)?(?:\s*(?:개방|운영|영업))?|연중\s*(?:무휴\s*)?(?:상시\s*)?개방)$/;
// 하루 종일 연다는 말로 **시작**하고 시각 범위가 뒤따르면('24시간 (단, 03:00~05:00 청소시간)') 하루 종일 영업 + 그
// 범위는 닫힐 수도 있는 구간이다 — 범위만 영업으로 읽어 낮에 닫힘으로 빼지 않는다.
const ALWAYS_OPEN_LEAD_RE = /^(?:연중\s*(?:무휴\s*)?)?(?:상시\s*(?:개방|운영)|24\s*시간)/;
const CLOCK = "(?:[01]?[0-9]|2[0-3]):[0-5][0-9]";
const RANGE_DASH = "[~\\-–—〜∼]";
// 닫는 시각 24:00(자정)도 받는다 — '10:00~24:00' 은 자정까지 영업이다(분으로 1440). 닫는 시각 앞의 '익일'·'새벽'
// ('11:00~익일 01:00')은 자정을 넘는다는 말일 뿐이다.
const TIME_RANGE_RE = new RegExp(`(${CLOCK})\\s*${RANGE_DASH}\\s*(?:(?:익일|다음\\s*날|새벽)\\s*)?(${CLOCK}|24:00)`, "g");
// 쉬는 시간 시각의 다른 꼴 — '15시~17시' · '15~17시' · '15:30~17시', '3-5pm' · '2:30-5pm'(쉬는 시간 말이 바로 앞일 때만).
const SI_RANGE_RE = new RegExp(
  `([0-9]{1,2})(?::([0-5][0-9]))?(?:\\s*시)?\\s*${RANGE_DASH}\\s*([0-9]{1,2})(?::([0-5][0-9]))?\\s*시`,
  "g",
);
const AMPM_RANGE_RE = new RegExp(
  `([0-9]{1,2})(?::([0-5][0-9]))?(?:\\s*(am|pm))?\\s*${RANGE_DASH}\\s*([0-9]{1,2})(?::([0-5][0-9]))?\\s*(am|pm)`,
  "g",
);
// 쉬는 시간 범위 바로 뒤에 목록 이음만 두고 이어진 범위('휴게시간 12:00~13:00, 18:00~19:00')도 쉬는 시간 후보다.
const LIST_GAP_RE = /^\s*(?:[,·\/&]|및|와|과)\s*$/;
// 쉬는 시간 말 — '휴게'·'휴식' 은 '시간' 이나 시각이 바로 뒤에 올 때만('휴게소'·'휴게음식점'·'휴식 공간' 은 아니다).
const BREAK_WORD_RE = /브레이크|break(?!fast)|쉬는\s*시간|준비\s*시간|(?:휴게|휴식)(?:\s*시간|(?=\s*(?::\s*)?[0-9]))/g;
// 선택 조각은 '공백 + 반드시 있는 글자' 꼴로만 둔다(공백만 홀로 선택되면 되돌아보기가 곱으로 는다).
const BREAK_NEGATED_RE = /^(?:\s*(?:타임|time|시간))?(?:\s*:)?\s*(?:없|무(?![가-힣])|x(?![a-z])|none)/;
const NO_BEFORE_RE = /(?:^|[^a-z])no\s*$/;
// 입장 마감 — 말 다음 시각('입장 마감 17:00' · 'L.O 20:30'), 또는 시각 다음 말('17:00까지 입장').
// 입장이 끝난 뒤 도착하면 들어갈 수 없으므로 그 구간의 실제 닫는 시각이다.
const LAST_ENTRY_LABEL = "입장\\s*마감|마지막\\s*입장|최종\\s*입장|매표\\s*마감|발권\\s*마감|라스트\\s*오더"
  + "|last\\s*(?:entry|admission|order)|l\\.\\s*o\\.?";
const LAST_ENTRY_RE = new RegExp(
  `(?:${LAST_ENTRY_LABEL})(?:\\s*(?:시간|시각))?(?:\\s*(?:은|는))?(?:\\s*:)?\\s*(?:~\\s*)?(${CLOCK})`,
  "g",
);
const ENTRY_UNTIL_RE = new RegExp(`(${CLOCK})\\s*(?:까지\\s*입장|입장\\s*마감)`, "g");
const DAY_MINUTES = 24 * 60;
// 영업시간 원문은 철·문·요일마다 줄이 늘어 휴무 문구보다 길다(실적재 수십~200자대) — 다듬은 뒤 500자까지만 읽는다.
const MAX_HOURS_TEXT = 500;
// 말 없는 괄호 범위를 '쉬는 시간일 수도' 로 볼 길이 — 3시간 이하이면서 바깥 구간의 절반보다 짧을 때만.
const MAX_BARE_BREAK_MINUTES = 180;

type Interval = [number, number];
interface LocatedInterval { start: number; end: number; interval: Interval }
interface Paren { start: number; end: number; inner: string }

const mod = (value: number) => ((value % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;

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

function hourMinutes(hour: string, minute: string | undefined): number | null {
  const value = Number(hour) * 60 + Number(minute ?? 0);
  return value <= DAY_MINUTES ? value : null;
}

function ampmMinutes(hour: string, minute: string | undefined, suffix: string): number | null {
  const value = Number(hour);
  if (value < 1 || value > 12) return null;
  return ((value % 12) + (suffix === "pm" ? 12 : 0)) * 60 + Number(minute ?? 0);
}

/** '15시~17시' · '3-5pm' 꼴 쉬는 시간을 분 구간으로. 읽을 수 없으면 null. */
function alternateBreakInterval(match: RegExpMatchArray, kind: "si" | "ampm"): Interval | null {
  let start: number | null;
  let end: number | null;
  if (kind === "si") {
    start = hourMinutes(match[1], match[2]);
    end = hourMinutes(match[3], match[4]);
  } else {
    const endSuffix = match[6];
    const startSuffix = match[3] ?? endSuffix;
    end = ampmMinutes(match[4], match[5], endSuffix);
    start = ampmMinutes(match[1], match[2], startSuffix);
    if (match[3] === undefined && start !== null && end !== null && start > end) {
      start = ampmMinutes(match[1], match[2], endSuffix === "pm" ? "am" : "pm");
    }
  }
  if (start === null || end === null || start === end) return null;
  return [start, end === DAY_MINUTES ? 0 : end];
}

function intervalContains(interval: Interval, minute: number): boolean {
  const [start, end] = interval;
  if (isFullDay(interval)) return true;
  if (end > start) return minute >= start && minute < end;
  return minute >= start || minute < end; // 자정을 넘는 구간
}

const intervalLength = (interval: Interval) => (isFullDay(interval) ? DAY_MINUTES : mod(interval[1] - interval[0]));

const minutesUntilClose = ([start, end]: Interval, minute: number) => (end > start ? end - minute : mod(end - minute));

function strictlyInside(inner: Interval, outer: Interval): boolean {
  const start = outer[0];
  const end = outer[1] <= start ? outer[1] + DAY_MINUTES : outer[1];
  let [innerStart, innerEnd] = inner;
  if (innerStart < start) innerStart += DAY_MINUTES;
  if (innerEnd <= innerStart) innerEnd += DAY_MINUTES;
  return start < innerStart && innerEnd < end;
}

/** 쉬는 시간은 영업 구간 안에 있다 — 오전 시각('브레이크타임 3시~5시')이 어느 영업 구간 안에도 없고 12시간
 *  뒤(15시~17시)가 안에 있으면 오후로 읽는다. */
function afternoonBreak(interval: Interval, opens: Interval[]): Interval {
  const [start, end] = interval;
  if (start >= 12 * 60 || end > 12 * 60 || opens.some((outer) => strictlyInside(interval, outer))) return interval;
  const shifted: Interval = [start + 12 * 60, end + 12 * 60];
  return opens.some((outer) => strictlyInside(shifted, outer)) ? shifted : interval;
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

/** 범위와 그 바로 앞의 말 — 같은 절(줄·쉼표·쌍반점), 같은 괄호, 앞 범위 뒤에서부터 범위 끝까지
 *  (범위까지 넣어야 '휴게 15:00' 처럼 시각이 바로 뒤에 와야 쉬는 시간 말이 되는 낱말을 가린다). 그 사이의 닫힌
 *  괄호 글('(브레이크타임 있음) 11:30~21:00')은 그 범위의 말이 아니라 지운다. */
function leadIn(text: string, start: number, end: number, floor: number, parens: Paren[]): string {
  const clauseStart = Math.max(...["\n", ",", ";"].map((d) => (start ? text.lastIndexOf(d, start - 1) : -1))) + 1;
  const paren = parens.find((p) => p.start < start && start < p.end);
  const segment = text.slice(Math.max(clauseStart, paren ? paren.start + 1 : 0, floor), end);
  return segment.replace(PAREN_RE, (whole) => " ".repeat(whole.length));
}

interface ParsedHours {
  alwaysOpen: boolean;
  opens: Interval[];
  breaks: Interval[];
  possible: Interval[]; // 쉬는 시간일 수도 있는 구간 — 그 시간에는 needs_confirmation
  truncated: boolean;
}
const hoursCache = new Map<string, ParsedHours>();

/** 영업 구간 · 쉬는 시간 · 쉬는 시간일 수도 있는 구간. 서버 _parse_opening_hours 와 같은 판정. */
function parseOpeningHours(original: string): ParsedHours {
  const cached = hoursCache.get(original);
  if (cached) return cached;
  const [text, truncated] = cleanSource(original, MAX_HOURS_TEXT);
  const collapsed = text.split(/\s+/).filter(Boolean).join(" ");
  let parsed: ParsedHours;
  const matches = [...text.matchAll(TIME_RANGE_RE)];
  if (ALWAYS_OPEN.test(collapsed)) {
    parsed = { alwaysOpen: true, opens: [], breaks: [], possible: [], truncated };
  } else if (matches.length && ALWAYS_OPEN_LEAD_RE.test(collapsed)) {
    // '24시간 (단, 03:00~05:00 청소시간)' — 하루 종일 영업이고, 범위는 닫힐 수도 있는 구간이다.
    const possible = matches.map((match) => [clockMinutes(match[1]), clockMinutes(match[2])] as Interval);
    parsed = { alwaysOpen: false, opens: [[0, DAY_MINUTES]], breaks: [], possible, truncated };
  } else {
    const parens: Paren[] = [...text.matchAll(PAREN_RE)].map((m) => ({
      start: m.index!, end: m.index! + m[0].length, inner: m[1],
    }));
    const opens: LocatedInterval[] = [];
    let breaks: Interval[] = [];
    const bare: LocatedInterval[] = [];
    const labelledAfter: LocatedInterval[] = [];
    const listed: LocatedInterval[] = [];
    let previousBreak = false;
    matches.forEach((match, index) => {
      const start = match.index!;
      const end = start + match[0].length;
      const located: LocatedInterval = { start, end, interval: [clockMinutes(match[1]), clockMinutes(match[2])] };
      const previousEnd = index ? matches[index - 1].index! + matches[index - 1][0].length : 0;
      if (hasBreakWord(leadIn(text, start, end, previousEnd, parens))) {
        breaks.push(located.interval); // 쉬는 시간 말이 바로 앞(같은 절·같은 괄호)
        previousBreak = true;
        return;
      }
      if (previousBreak && LIST_GAP_RE.test(text.slice(previousEnd, start))) {
        listed.push(located); // '휴게시간 12:00~13:00, 18:00~19:00' 의 둘째 범위
        return;
      }
      previousBreak = false;
      const paren = parens.find((p) => p.start < start && end < p.end);
      if (paren) {
        if (paren.inner.trim() === match[0].trim()) bare.push(located);
        else if (hasBreakWord(paren.inner)) labelledAfter.push(located); // '(15:00~16:00 브레이크)'
        else opens.push(located);
        return;
      }
      // 괄호 밖 범위 뒤에(같은 절, 다음 범위·괄호 전까지) 쉬는 시간 말이 붙었으면 '쉬는 시간일 수도'.
      const clauseEnds = ["\n", ",", ";"].map((d) => text.indexOf(d, end)).filter((pos) => pos !== -1);
      const clauseEnd = clauseEnds.length ? Math.min(...clauseEnds) : text.length;
      const nextStart = index + 1 < matches.length ? matches[index + 1].index! : text.length;
      const after = text.slice(end, Math.min(clauseEnd, nextStart)).split("(")[0];
      (hasBreakWord(after) ? labelledAfter : opens).push(located);
    });
    // '15시~17시' · '3-5pm' 꼴 쉬는 시간 — 쉬는 시간 말이 바로 앞에 있을 때만.
    const standardSpans = matches.map((m) => [m.index!, m.index! + m[0].length] as const);
    const alternates = [
      ...[...text.matchAll(SI_RANGE_RE)].map((match) => ({ match, kind: "si" as const })),
      ...[...text.matchAll(AMPM_RANGE_RE)].map((match) => ({ match, kind: "ampm" as const })),
    ];
    for (const { match, kind } of alternates) {
      const start = match.index!;
      const end = start + match[0].length;
      if (standardSpans.some(([spanStart, spanEnd]) => spanStart < end && start < spanEnd)) continue;
      const floor = Math.max(0, ...standardSpans.filter(([, spanEnd]) => spanEnd <= start).map(([, spanEnd]) => spanEnd));
      const interval = alternateBreakInterval(match, kind);
      if (interval && hasBreakWord(leadIn(text, start, end, floor, parens))) breaks.push(interval);
    }
    const openIntervals = opens.map((located) => located.interval);
    // 목록으로 이어진 쉬는 시간 후보는 다른 영업 구간 안쪽일 때만 쉬는 시간이다.
    for (const located of listed) {
      if (openIntervals.some((outer) => strictlyInside(located.interval, outer))) breaks.push(located.interval);
      else opens.push(located);
    }
    breaks = breaks.map((interval) => afternoonBreak(interval, openIntervals));
    const possible: Interval[] = [];
    // 뒤에 쉬는 시간 말이 붙은 범위: 다른 영업 구간 안쪽이면 쉬는 시간일 수도. 다른 영업 구간이 하나도 없으면 짧은
    // 범위('15:00~17:00 브레이크타임')는 그 자체가 쉬는 시간일 수 있고, 긴 범위('11:00~21:00 브레이크타임 있음')는 영업 구간이다.
    for (const located of labelledAfter) {
      const inside = openIntervals.some((outer) => strictlyInside(located.interval, outer));
      if (inside || (openIntervals.length === 0 && intervalLength(located.interval) <= MAX_BARE_BREAK_MINUTES)) {
        possible.push(located.interval);
      } else {
        opens.push(located);
      }
    }
    for (const located of bare) {
      const outer = openIntervals.find((candidate) => strictlyInside(located.interval, candidate));
      const length = intervalLength(located.interval);
      if (outer && length <= MAX_BARE_BREAK_MINUTES && length * 2 < intervalLength(outer)) possible.push(located.interval);
      else opens.push(located);
    }
    parsed = {
      alwaysOpen: false,
      opens: applyLastEntry(text, opens).map((located) => located.interval),
      breaks,
      possible,
      truncated,
    };
  }
  hoursCache.set(original, parsed);
  return parsed;
}

function statusFromIntervals(opens: Interval[], breaks: Interval[], possible: Interval[], minute: number): ArrivalOpenStatus {
  const containing = opens.filter((interval) => intervalContains(interval, minute));
  if (containing.length === 0 || breaks.some((interval) => intervalContains(interval, minute))) return "closed_confirmed";
  // 쉬는 시간일 수도 — 단정하지 않는다.
  if (possible.some((interval) => intervalContains(interval, minute))) return "needs_confirmation";
  // 겹치는 구간이 여럿이면 가장 늦게 닫는 구간을 쓴다('11:00~15:00, 09:00~22:00' 의 14:45 는 영업 중이다).
  let remaining: number | null = containing.some(isFullDay)
    ? null
    : Math.max(...containing.map((interval) => minutesUntilClose(interval, minute)));
  for (const [start] of breaks) {
    const untilBreak = mod(start - minute);
    if (untilBreak && (remaining === null || untilBreak < remaining)) remaining = untilBreak; // 곧 쉬는 시간
  }
  if (remaining !== null && remaining <= 30) return "closing_soon";
  // 곧 쉬는 시간일 수도.
  if (possible.some(([start]) => mod(start - minute) > 0 && mod(start - minute) <= 30)) return "needs_confirmation";
  return "open_expected";
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
  const { alwaysOpen, opens, breaks, possible, truncated } = parseOpeningHours(String(source[dayKey] || source.open || ""));
  if (alwaysOpen) return "open_expected";
  // 500자를 넘겨 잘린 원문은 읽지 못한 뒤쪽에 다른 시각·쉬는 시간이 있을 수 있다 — 무엇도 단정하지 않는다.
  if (truncated || opens.length === 0) return "needs_confirmation";
  return statusFromIntervals(opens, breaks, possible, minutes);
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
