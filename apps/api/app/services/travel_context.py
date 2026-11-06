"""Deterministic eligibility and arrival-status rules for recommendations."""
import calendar
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import lru_cache
import re
from typing import Callable, Literal
import unicodedata

from pydantic import BaseModel, Field

from app.services.availability_service import is_effective_availability_evidence
from app.services.spot.travel import WALKING_SPEED_M_PER_MIN
from app.services.tourapi.transform import (
    INDOOR_CULTURE_CAT3,
    INDOOR_CULTURE_EVIDENCE,
    parse_availability_text,
)

KST = timezone(timedelta(hours=9))
VALID_CATEGORIES = {"restaurant", "cafe", "attraction", "culture"}
VALID_ATTRIBUTES = {"indoor", "accessible", "stroller"}
DEFAULT_INDOOR_TYPES = {"restaurant", "cafe"}
FOOD_TYPES = {"restaurant", "cafe"}
LATE_NIGHT_START_MINUTE = 22 * 60
LATE_NIGHT_END_MINUTE = 6 * 60

# 후보 자격은 SPOT 점수보다 먼저 적용한다. 숫자가 작을수록 영업 근거가 강하다.
# 기본은 가장 강한 비어 있지 않은 등급만 쓴다. 요청이 채움을 청하면(fill_weaker_tiers — 등급 순으로 그리는
# 새 웹 번들만 보낸다) 가장 강한 등급이 요청한 개수(limit)보다 적을 때 다음 등급에서 채운다
# (select_eligibility_tiers). 정렬은 언제나 등급이 먼저이고 같은 등급 안에서만 SPOT 점수로 겨룬다 —
# 영업 확인된 곳이 미확인 곳 뒤로 밀리는 일은 없고, 채운 카드는 자기 등급(미확인)을 그대로 단다.
RECOMMENDATION_ELIGIBILITY_LABELS = {
    0: "verified_open_route",
    1: "verified_open_estimated_route",
    2: "hours_confirmation_required_route",
    3: "hours_and_route_confirmation_required",
}

# 확인 등급이 limit 보다 적을 때 다음 등급에서 SPOT 채점까지 데려오는 후보 수 = 모자란 개수 × 이 배수.
# 영업시간이 빈 카카오·LocalData 행은 도보 20분 반경에도 수백 곳이라, 전부 채점하면 확인 등급이 많던
# 평소 요청보다 채점이 수십 배로 는다(후보마다 주변 수요·혼잡 근거 조회). 가까운 순으로 이만큼만 채점해
# 그 안에서 점수 순으로 고른다 — 거리는 SPOT 시간비용의 큰 항이라 상위 후보를 거의 놓치지 않는다.
TIER_FILL_POOL_FACTOR = 4


class TravelContext(BaseModel):
    categories: list[Literal["restaurant", "cafe", "attraction", "culture"]] = Field(default_factory=list)
    max_walk_minutes: Literal[5, 10, 20] | None = None
    available_minutes: Literal[30, 60, 120] | None = None
    # stroller = 유모차(TourAPI 유모차 대여 정보). 휠체어 접근(accessible)과 다른 조건이다.
    required_attributes: list[Literal["indoor", "accessible", "stroller"]] = Field(default_factory=list)
    exclude_visited: bool = False
    visited_facility_ids: list[str] = Field(default_factory=list, max_length=200)

    @property
    def max_distance_m(self) -> float | None:
        return self.max_walk_minutes * WALKING_SPEED_M_PER_MIN if self.max_walk_minutes else None


def facility_indoor_evidence(facility: dict) -> str | None:
    """실내(비 피하기) 자격의 근거 이름. 근거가 없거나 야외로 확인됐으면 None.

    순서가 곧 우선순위다: 사람이 확인한 False 가 무엇보다 먼저이고, 그다음 시설에 적힌 True, 음식점·카페
    기본값, TourAPI 문화시설 분류(박물관·미술관 등 — INDOOR_CULTURE_CAT3) 순이다. 관광지와 분류가 없는
    문화시설은 근거가 없는 것으로 둔다 — 비 오는 날 야외 유적을 '실내' 로 보내는 쪽이 빼는 쪽보다 해롭다.
    """
    features = facility.get("features") or {}
    if features.get("indoor") is False or features.get("indoor_verified") is False:
        return None
    if features.get("indoor") is True or features.get("indoor_verified") is True:
        evidence = features.get("indoor_evidence")
        return evidence if isinstance(evidence, str) and evidence else "facility_feature"
    if facility.get("type") in DEFAULT_INDOOR_TYPES:
        return "food_establishment_default"
    # 밤 적재(tourapi.transform)는 같은 분류에 features.indoor 를 적는다. 그 전에 적재된 행도 이미 cat3 를
    # 갖고 있어 여기서 같은 규칙으로 읽는다 — 적재를 기다리지 않고, 두 곳의 분류 목록은 하나(INDOOR_CULTURE_CAT3)다.
    if facility.get("type") == "culture" and features.get("cat3") in INDOOR_CULTURE_CAT3:
        return INDOOR_CULTURE_EVIDENCE
    return None


def facility_is_indoor_eligible(facility: dict) -> bool:
    """Return rain-safe indoor eligibility without claiming inferred evidence is verified."""
    return facility_indoor_evidence(facility) is not None


def facility_is_stroller_friendly(facility: dict) -> bool:
    """유모차 조건 — TourAPI 유모차 대여 정보가 '가능' 이라고 말한 곳만(fail-closed).

    features.stroller 가 참·거짓이면 그 값을 따른다(밤 적재는 '가능' 일 때 True 만 적고, False 는 사람이 고친
    값뿐이다). 없거나 null 이면 원문 chk_babycarriage 를 같은 규칙(parse_availability_text)으로 읽는다 — 원문은
    이미 적재돼 있어 다음 밤 적재 전에도 판정이 같다. 휠체어 접근 근거(barrier_free)는 여기 섞지 않는다:
    '휠체어·엘리베이터' 낱말 휴리스틱이라 유모차 대여 정보와 뜻이 다르다.
    """
    features = facility.get("features") or {}
    stroller = features.get("stroller")
    if isinstance(stroller, bool):
        return stroller
    return parse_availability_text(features.get("chk_babycarriage")) is True


def facility_matches_context(facility: dict, context: TravelContext | None) -> bool:
    if context is None:
        return True
    if context.categories and facility.get("type") not in context.categories:
        return False
    if context.exclude_visited and facility.get("id") in set(context.visited_facility_ids):
        return False
    features = facility.get("features") or {}
    for attr in context.required_attributes:
        # Accessibility is fail-closed: a generic `accessible` claim is not verification.
        if attr == "accessible":
            matches = facility.get("barrier_free") is True or features.get("accessible_verified") is True
        elif attr == "stroller":
            matches = facility_is_stroller_friendly(facility)
        else:
            matches = facility_is_indoor_eligible(facility)
        if not matches:
            return False
    return True


# ── 휴무일 원문 해석 ───────────────────────────────────────────────────────────────────────
#
# 휴무일 칸(operating_hours.closed — TourAPI restdate · 경주시 음식점 '휴무일' 원문)은 자유 글이다. 예전 판정
# `(?:매주|매월|요일|휴무)[^\n]{0,12}{요일 글자}` 는 요일 글자 '일' 이 '요일'·'1월 1일'·'당일' 의 '일' 에도 걸려,
# **일요일마다** '매주 월요일' 가게를 전부 닫힌 곳으로 봤다(2026-10-31 재현). 이제 요일 글자 덩어리는 이렇게 읽는다:
#   · 앞이 숫자면 요일이 아니다(1월 · 15일 — 날짜).
#   · 앞이 한글이면 휴무를 말하는 앞말(매주·격주·휴무·휴관…)이 붙어 있거나 바로 뒤에 '요일' 이 붙을 때만 요일이다.
#     한글 뒤에 붙은 '일' 은 '요일' 이 붙지 않으면 '날' 이다(휴관일 · 휴무일 없음 · 매주일).
#   · 그리고 요일이라는 근거가 하나 있어야 한다 — '요일'('욜') 이 붙었거나, 구분 기호로 이은 목록이거나(월,화 ·
#     (월) (화)), 뒤에(뒤이은 요일·조사·괄호를 건너) 휴무 낱말이 오거나(토일 휴무 · 월 휴무 · 토 일 휴무), 휴무 앞말이
#     바로 앞에 있거나(휴무: 월 · 매주 토일 · 정기휴무 (수) · 쉬는 날 - 일), 칸 전체가 요일뿐이거나(토일). 근거 없는
#     낱글자·덩어리는 요일이 아니다 — '변동될 수 있음' 의 '수', '일 년에', '월 중 하루', '휴관 일정', '토일은 예약제',
#     '수목 정비', '수일 내' 는 휴무 요일이 아니다(없는 휴무를 만들면 후보에서 통째로 빠진다).
#   · 붙여 쓴 덩어리는 요일 순서여야 한다(월<화<…<일, 휴무 낱말·앞말이 붙으면 '일월'·'토일월' 처럼 주를 한 번 넘어도
#     된다). '금일'(오늘)·'수일'(며칠)은 덩어리로 읽지 않는다.
#   · 일곱 요일이 다 나오는데 휴무 낱말이 없으면('월화수목금토일' · '월~일') 휴무 규칙이 아니다.
#   · 읽은 요일이 지금의 휴무가 아닌 경우: 뒤에(조사 '에·은·도·만·까지' 를 건너) 영업시간·영업 말이 오거나('일요일에도
#     영업' · '토요일은 10:00~15:00'), 같은 절에 영업 말만 있고 휴무 말이 없거나('…문화가 있는 날 21시까지 연장 운영'),
#     앞에 영업 앞말이 있거나('영업: 월~금'), 휴무를 부정하거나('휴무 없음' · '휴무 아님' · '주말 무휴'), 지난 일이거나
#     ('월요일 휴무였으나' · '월요일에서 화요일로' · '월요일 → 화요일'), 다른 날을 가리킬 때('일요일 다음날 휴무').
#     '영업 없음'·'영업을 쉽니다'·'영업휴무'·'영업 불가' 는 휴무다. '토(격주)' 처럼 괄호로 격주를 단 요일은 모름이다.
#
# 입력은 먼저 다듬는다: 폭 없는 글자(U+200B~U+200D · U+2060 · U+FEFF)를 지우고 NFKC 로 맞추고(전각 숫자·물결·괄호 →
# 반각 — 파이썬과 JS 의 '\d'·'\s' 가 보는 글자가 달라 같은 원문에 두 쪽이 다른 답을 내지 않게), 태그·주소(URL ·
# 'instagram.com/…' 같은 도메인)를 걷어 낸 **뒤에** 앞 600자만 읽는다(실제 문구는 100자 안팎 — 긴 입력이 정규식
# 되돌아보기로 이벤트 루프를 붙잡지 않게). 600자를 넘겨 잘렸으면 무엇도 단정하지 않는다(모든 날 uncertain).
#
# 웹 lib/restDate.ts 의 closedDayStatus 와 **같은 규칙·같은 식**이다. 웹은 iOS 16.4 미만 Safari 가 읽지 못하는
# 정규식 '뒤쪽 보기' 를 쓸 수 없어서 앞 글자 검사를 정규식 밖에서 하고, 여기서도 똑같이 한다. 두 테스트가 같은
# 사례 파일(tests/fixtures/opening_hours_parity.json)을 읽으므로 한쪽만 고치면 그 쪽 테스트가 깨진다.
#
# 매월 n번째 요일('매월 둘째·넷째 일요일' · '둘,넷째 주' · '제1·3 화요일' · '끝주 화요일' · '1st and 3rd Sundays')은
# 그 날짜가 이 달의 몇 번째 그 요일인지(1~7일 = 첫째) 계산해 그날만 닫는다 — 모든 일요일을 닫지 않는다. 서수를 읽지
# 못한 매월·격주 규칙('매월 1회 월요일'·'격주 월요일'·'every other Monday')은 그 요일을 '모름(uncertain)' 으로 둔다:
# 닫혔다고도(후보에서 빠짐), 열었다고도(영업 확인) 하지 않고 영업 확인 필요로 내린다. 공휴일에 따른 대체 휴무
# ('월요일이 공휴일이면 화요일' · '공휴일 다음날 휴관(월요일과 겹치면 화요일)' · '(일요일인 경우 월요일)')는 매주 규칙이
# 아니라 버린다 — 공휴일 달력이 없어 그날을 가려낼 수 없고, 매주 화요일을 닫는 것보다 그 하루를 놓치는 편이 덜
# 틀린다. 조건절은 결과 절('화요일 및 수요일 휴관')까지이고, 새 규칙 표지(매주·매월·격주·정기)로 시작하는 이음 뒤
# 절은 남긴다. '무휴' 는 다른 휴무 규칙이 하나도 없을 때만 연중무휴다('매주 월요일 휴관 (7~8월 무휴)' 의 무휴는
# 기간 한정이다 — 명시한 매주·매월 규칙이 이긴다). 영어 요일 이름은 같은 절에 휴무 말(closed · holiday · day off ·
# 휴무)이 있거나 절이 요일뿐일 때만 휴무다('Sunday brunch only' · 'Mon-Fri 09:00-18:00' 은 아니다).

_WEEKDAY_CHARS = "월화수목금토일"  # 인덱스 = datetime.weekday() (월=0 … 일=6)
_DAY = "[월화수목금토일]"
_YOIL = r"(?:요일|욜)"
# 요일 글자 덩어리(한 글자 이상)를 구분 기호(· , / 、 ~ - 〜)로 이은 목록. '(월) (화)' 처럼 괄호마다 쓴 목록도 잇는다.
# 덩어리가 두 글자 이상이면 붙여 쓴 묶음이다.
_DAY_SEP = r"\s*(?:[·,/、~\-–〜∼]|\)\s*\()\s*"
# 덩어리는 일곱 글자까지만(요일 순서로 한 바퀴) — 더 긴 요일 글자 줄('월화월화…')을 자리마다 끝까지 되읽지 않게.
_DAY_RUN = r"[월화수목금토일]{1,7}(?![월화수목금토일])"
_DAY_LIST = rf"{_DAY_RUN}(?:{_DAY_SEP}{_DAY_RUN})*"
_DAY_RUN_RE = re.compile(rf"({_DAY_LIST})(\s*{_YOIL})?")
_DAY_SEP_RE = re.compile(_DAY_SEP)
# 요일처럼 생겼지만 요일이 아닌 두 글자 — '금일'(오늘) · '수일'(며칠).
_NOT_DAY_RUNS = frozenset({"금일", "수일"})
# 휴무를 말하는 앞말 — 요일 바로 앞에 오면(붙여 써도, 사이에 쌍점·괄호·줄표가 있어도) 요일이다
# ('휴무: 월' · '매주화,수' · '매주 토일월' · '정기휴무 (수)' · '쉬는 날 - 일').
_CLOSURE_PREFIX_RE = re.compile(
    r"(?:매주|격주|격월|매월|매달|휴무일?|휴관일?|휴업일?|휴점일?|정기\s*휴[무관업점일]일?|쉬는\s*날)"
    r"(?:\s*[:()\-–~〜/·])*\s*$"
)
# 요일 앞에 오면 영업 요일이라는 앞말('영업: 월~금' · '운영일 : 화~일').
_OPEN_PREFIX_RE = re.compile(r"(?:영업|운영|개방|오픈|개장)\s*(?:일|시간|요일)?\s*:\s*$")
# 요일 뒤에(조사·이음말·괄호를 건너) 바로 오면 휴무 요일이라는 말.
_CLOSURE_WORD = r"휴무|휴관|휴업|휴점|휴장|휴일|정기|쉼|쉽|쉬|공휴일|법정|closed"
_CLOSURE_AFTER_RE = re.compile(rf"(?:\s*(?:은|는|에|엔|도|및|과|와|[,·/()]))*\s*(?:{_CLOSURE_WORD})")
# 휴무를 말하는 낱말이 하나라도 있는지 — 일곱 요일이 다 나온 문구를 휴무로 읽을지, 절이 영업만 말하는지 가른다.
_CLOSURE_ANY_RE = re.compile(r"휴무|휴관|휴업|휴점|휴장|쉼|쉽|쉬|정기|매주|closed")
# 칸 전체가 요일·구분 기호·괄호·'요일'·공백뿐인지('토일' · '월, 화' · '월요일' · '(월) (화)').
_ONLY_DAYS_RE = re.compile(r"(?:[월화수목금토일·,/、~\-–〜∼()\s]|요일|욜)+")
# '변동될 수 있음' 의 '수'.
_SU_ITTDA_RE = re.compile(r"\s*(?:있|없)")
_KO_WEEKEND_RE = re.compile(r"주말")
_DIGITS = "0123456789"
_HANGUL_RE = re.compile(r"[가-힣]")

_EN_DAY_INDEX = {
    name: index
    for index, names in enumerate((
        ("monday", "mon"), ("tuesday", "tues", "tue"), ("wednesday", "wed"),
        ("thursday", "thurs", "thur", "thu"), ("friday", "fri"), ("saturday", "sat"), ("sunday", "sun"),
    ))
    for name in names
}
_EN_DAY_NAMES = "|".join(sorted(_EN_DAY_INDEX, key=lambda name: (-len(name), name)))
# 영어 낱말 경계는 앞 글자를 1번 묶음으로 잡아 본다(웹과 같은 식). 낱말의 시작 = 일치 시작 + 1번 묶음 길이.
# 숫자·밑줄·@·# 에 붙은 이름('sunday_bakery' · '@mon_cafe')은 요일이 아니다.
_EN_DAY_RE = re.compile(rf"(^|[^a-z0-9_@#])({_EN_DAY_NAMES})s?(?![a-z0-9_])")
_EN_WEEKEND_RE = re.compile(r"(^|[^a-z0-9_@#])weekends?(?![a-z0-9_])")
_EN_OPEN_RE = re.compile(r"(?:^|[^a-z])open(?![a-z])")
_EN_CLOSED_BEFORE_RE = re.compile(r"(?:^|[^a-z])closed?(?![a-z])")
# 영어 요일 이름이 휴무라는 근거 — 같은 절(, ; / 줄)의 휴무 말, 또는 절 전체가 요일뿐('Mondays' · 'Every Monday').
_EN_CLOSURE_CONTEXT_RE = re.compile(
    r"(?:^|[^a-z])(?:closed?|closing|holidays?|days?\s*off)(?![a-z])|휴무|휴관|휴업|휴점|휴장|정기|쉬는\s*날"
)
_EN_DAY_WORD = rf"(?:(?:every|each|on)\s+)?(?:{_EN_DAY_NAMES}|weekend)s?\.?"
_EN_ONLY_DAYS_RE = re.compile(
    rf"[\s:().\-–]*{_EN_DAY_WORD}(?:(?:\s*(?:[,&\-–~]|and|or)\s*|\s+){_EN_DAY_WORD})*[\s:().]*"
)
# 'Tue-Sun: 10am-6pm' — 영업 여부는 뒤이은 요일들까지 건너 마지막에 붙은 말로 본다.
_EN_MORE_DAYS_RE = re.compile(
    rf"(?:\s*(?:[-–~〜,/&]|and|to|through|thru)\s*(?:{_EN_DAY_NAMES})s?(?![a-z0-9_])){{0,6}}"
)
_EN_CLAUSE_DELIMITERS = ",;\n/"
_EN_ORDINAL = r"(?:first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)"
_EN_ORDINAL_VALUE = {
    "first": 1, "1st": 1, "second": 2, "2nd": 2, "third": 3, "3rd": 3, "fourth": 4, "4th": 4, "fifth": 5, "5th": 5,
}
# 서수 사이 이음은 서로 겹치지 않는 세 갈래다(구두점 / and·or / 공백). 예전 '\s*(?:…)?\s*' 꼴은 공백을 나눠 갖는
# 방법이 서수 개수만큼 곱으로 늘어, '1st 1st … x' 같은 입력에서 정규식이 수 초씩 되돌아봤다.
_EN_ORDINAL_SEP = r"(?:\s*[,&/]\s*|\s+(?:and|or)\s+|\s+)"
_EN_MONTHLY_RE = re.compile(
    rf"(^|[^a-z])({_EN_ORDINAL}(?:{_EN_ORDINAL_SEP}(?:the\s+)?{_EN_ORDINAL})*)\s+({_EN_DAY_NAMES})s?(?![a-z])"
)

_OPEN_ALL_YEAR_RE = re.compile(r"무휴|(?:^|[^a-z])open\s+(?:daily|every\s*day|all\s+year)")

# 공휴일 대체 휴무 조건. 공휴일 낱말·'월요일이 공휴일'·'월요일과 겹치면'·'일요일인 경우' 에서 시작하는 절만 조건절로
# 본다(공휴일 낱말이 원문 어디에도 없으면 조건절을 찾지 않는다 — _drop_holiday_conditions).
# '정기휴일 매주 월요일' 의 '휴일' 은 공휴일이 아니다(앞이 한글이면 홀로 선 '휴일' 로 치지 않는다).
_HOLIDAY_WORD = r"(?:법정\s*)?(?:공휴일|국경일|명절|연휴|대체\s*휴일)|(?:^|[^가-힣])휴일|(?:^|[^a-z])holidays?(?![a-z])"
_HOLIDAY_RE = re.compile(_HOLIDAY_WORD)
# 참 조건(결과 절을 가진다)과 '다음날' 류(공휴일 다음날 휴무 — 결과 절이 없다).
_TRUE_CONDITION_RE = re.compile(r"경우|이면|이라면|일\s*때|인\s*때|겹치|겹칠|(?:^|[^a-z])(?:if|when)(?![a-z])")
_RELATIVE_DAY_RE = re.compile(r"다음\s*날|익일|이튿날|(?:^|[^a-z])(?:following|next\s+day)(?![a-z])")
_CONDITION_RE = re.compile(rf"{_TRUE_CONDITION_RE.pattern}|{_RELATIVE_DAY_RE.pattern}")
# 조건절이 시작되는 자리 — '월요일이 공휴일…' · '월요일과 겹치면…' · '일요일인 경우…' · '월요일이 설날 연휴와
# 겹치는 경우…' 의 주어, 또는 공휴일 낱말.
_CONDITION_START_RE = re.compile(
    rf"{_DAY}\s*요일(?:이|가|은|는)\s*(?:{_HOLIDAY_WORD})"
    rf"|{_DAY}\s*요일(?:인|이|일|가|은|는|과|와)\s*(?=경우|때|면|라면|겹)"
    rf"|{_DAY}\s*요일(?:이|가|은|는)\s(?=[^,\n;]{{0,20}}?(?:겹|경우|이면|라면))"
    rf"|{_HOLIDAY_WORD}"
)
# 조건절 끝을 찾는 이음말. '…과 겹치면' 의 '과' 는 이음말이 아니라 '겹치다' 의 짝이다(_OVERLAP_AFTER_RE).
_JOIN_RE = re.compile(r"및|과|와|/")
_OVERLAP_AFTER_RE = re.compile(r"\s*겹")
# 참 조건의 결과('화요일 및 수요일 휴관')는 새 규칙의 표지가 요일보다 먼저 나오는 이음말에서 끝난다.
_RULE_MARKER_RE = re.compile(r"매주|매월|매달|격주|정기")

# 서수 안의 선택 조각은 모두 '공백 + 반드시 있는 글자'(번·째·주) 꼴이다 — 공백만 홀로 선택되는 자리가 없어야
# 정규식이 공백을 나누는 방법을 곱으로 늘리지 않는다(예전 꼴은 '1 1 1 … x' 12개에 4.5초가 걸렸다).
# '주' 는 뒤에 '일' 이 오면 서수의 일부로 읽지 않는다('1주일' = 일주일) — 그 '일' 이 '일요일' 일 때만 예외다
# ('첫째주일요일' = 첫째 주 일요일). '끝(주)' 는 마지막 주다.
_ORDINAL = (
    r"(?:첫(?:\s*번)?(?:\s*째)?|둘\s*째|두\s*번\s*째|셋\s*째|세\s*번\s*째|넷\s*째|네\s*번\s*째"
    r"|다섯(?:\s*번)?\s*째|마지막|끝|[1-5](?:\s*번)?(?:\s*째)?)(?:\s*(?:주차|주(?!일(?!요일))))?"
)
# 서수 사이 이음 — 구두점 / 및·과·와 / 공백, 서로 겹치지 않는 세 갈래.
_ORDINAL_SEP = r"(?:\s*[·,/、&]\s*|\s*(?:및|과|와)\s*|\s+)"
# '둘째넷째' 처럼 붙여 쓴 서수는 읽기 전에 사이를 띄운다('째' 다음에 서수가 오는 자리).
_GLUED_ORDINAL_RE = re.compile(r"째(?=첫|둘|두|셋|세|넷|네|다섯|마지막|[1-5])")
# '둘,넷째 주' 처럼 '째' 를 한 번만 쓴 서수 목록은 앞 서수에도 '째' 를 붙인다.
_ELLIPSIS_ORDINAL_RE = re.compile(r"(둘|셋|넷)(?=\s*(?:[,·/、&]|및|와|과)\s*(?:첫|둘|셋|넷|다섯)\s*째)")
# 앞이 숫자인 서수('12월' 의 '2')는 정규식 밖에서 거른다(웹과 같은 식). '제1·3 화요일' 의 '제' 는 서수 표지다.
_MONTHLY_RE = re.compile(
    rf"(?:(?:매월|매달)\s*)?((?:제\s*)?{_ORDINAL}(?:{_ORDINAL_SEP}{_ORDINAL}){{0,4}})"
    rf"\s*(?:의\s*)?({_DAY_LIST})(\s*{_YOIL})?"
)
# 숫자만 있는 서수('1월'·'15일')는 날짜일 수 있어 서수로 보지 않는다 — '째'·'주'·'번'·'제' 나 낱말 서수가 있어야 한다.
_ORDINAL_MARK_RE = re.compile(r"[째주번제]|첫|둘|셋|넷|다섯|마지막|끝")
_ORDINAL_TOKEN_RE = re.compile(r"첫|둘|두|셋|세|넷|네|다섯|마지막|끝|[1-5]")
_LAST_ORDINALS = ("마지막", "끝")
_ORDINAL_VALUE = {
    "첫": 1, "1": 1, "둘": 2, "두": 2, "2": 2, "셋": 3, "세": 3, "3": 3,
    "넷": 4, "네": 4, "4": 4, "다섯": 5, "5": 5,
}
_KO_UNCERTAIN_MARKER_RE = re.compile(r"격주|격월|매월|매달")
_EN_UNCERTAIN_RE = re.compile(r"(^|[^a-z])(?:every\s+other|alternate|alternating|bi-?weekly)(?![a-z])")
# '토(격주), 일' · '토요일(격주 휴무)' — 괄호로 격주를 단 요일은 그날 모름이다(목록은 그대로 잇는다).
_ANNOTATED_UNCERTAIN_RE = re.compile(rf"({_DAY})(\s*{_YOIL})?\s*\(\s*(?:격주|격월)[^()]{{0,8}}\)")
# 요일 뒤 조사('일요일에도'·'토요일은'·'일요일만'·'일요일까지')는 건너뛴다 — 서로 겹치지 않는 갈래라 되돌아보기가
# 늘지 않는다. 숫자는 '[0-9]' 로 적는다 — 파이썬 '\d' 는 다른 문자권 숫자도 받지만 JS 는 아니다(웹과 같은 답을 내려고).
_AFTER_PARTICLES = r"(?:\s*(?:에|엔|은|는|도|만|까지))*"
# 영업 말 뒤의 부정('영업 안 함' · '운영하지 않음' · '영업을 쉽니다' · '영업 없음' · '영업휴무' · '영업 불가').
_OPEN_NEGATION = r"\s*(?:을|를|은|는)?\s*(?:안|않|하지\s*않|중지|중단|정지|불가|없|쉼|쉽|쉬|휴무|휴업|종료|x(?![a-z]))"
_NEGATED_OPEN = rf"(?!{_OPEN_NEGATION})"
_TIME_AFTER_RE = re.compile(rf"{_AFTER_PARTICLES}\s*(?::\s*)?[0-9]{{1,2}}\s*(?::|시|am|pm|a\.m|p\.m)")
_OPEN_AFTER_RE = re.compile(rf"{_AFTER_PARTICLES}\s*(?:영업|운영|개방|오픈|개장|정상|open){_NEGATED_OPEN}")
_PARTIAL_DAY_AFTER_RE = re.compile(rf"{_AFTER_PARTICLES}\s*(?:오전|오후|점심|저녁|야간)")
# 지금의 휴무가 아니라는 말 — 다른 날('일요일 다음날'), 휴무 부정('휴무 없음' · '휴무 아님'), 무휴('주말 무휴'),
# 지난 규칙('휴무였으나'), 바뀌기 전 요일('월요일에서 화요일로' · '월요일 → 화요일').
_NOT_CLOSURE_AFTER_RE = re.compile(
    r"(?:\s*의)?\s*(?:다음\s*날|익일|이튿날|전\s*날)"
    rf"|{_AFTER_PARTICLES}[\s)]*(?:휴무|휴관|휴업|휴점|휴장|쉬는\s*날)(?:일)?\s*(?:은|는|이|가)?\s*(?:없|아님|아니|x(?![a-z]))"
    rf"|{_AFTER_PARTICLES}\s*(?:연중\s*)?무휴"
    rf"|{_AFTER_PARTICLES}\s*(?:휴무|휴관|휴업|휴점|휴장)(?:일)?(?:이)?\s*(?:였|었)"
    rf"|\s*에서\s*{_DAY}\s*{_YOIL}?\s*(?:으로|로)(?![가-힣])"
    rf"|{_AFTER_PARTICLES}\s*(?:휴무|휴관|휴업|휴점|휴장)?(?:일)?\s*(?:→|->|=>|⇒)"
)
# 같은 절에 영업 말만 있고 휴무 말이 없으면('수요일 … 21시까지 연장 운영') 그 요일은 휴무가 아니다.
# 절 끝 — 줄·쉼표·쌍반점·빗금과 글머리표(※ ▷ ▶ • ◆ ◇ ■ □ ○ ● |).
_CLAUSE_END_RE = re.compile(r"[\n,;/※▷▶•◆◇■□○●|]")
_OPEN_WORD_RE = re.compile(r"영업|운영|개방|오픈|개장")
_OPEN_NEGATION_RE = re.compile(_OPEN_NEGATION)
# '월요일을 제외하고 매일 영업' — 제외한 요일은 휴무다.
_EXCEPT_RE = re.compile(r"제외|빼고|말고|외에는|외엔|이외")
# 요일과 영업 말 사이에 조건이 끼면('매주 화요일(공휴일 영업)' · '(단체 예약 시 영업)') 그 영업은 예외 안내다 — 요일은 휴무.
_OPEN_CONDITION_RE = re.compile(r"공휴일|명절|연휴|휴일|예약|경우|당일|단체|때|성수기|비수기|방학|행사|이면|(?:^|[^가-힣])시(?![가-힣])")
_DIGIT_AFTER_RE = re.compile(r"\s*[0-9]")
_HANGUL_OR_DIGIT_RE = re.compile(r"[가-힣0-9]")
# '토요일, 일요일도 영업' — 영업 여부는 뒤이은 요일들까지 건너 마지막에 붙은 말로 본다(구분 갈래는 서로 겹치지 않게).
_MORE_DAYS_RE = re.compile(rf"(?:(?:\s*[,·/]\s*|\s*(?:및|과|와)\s*|\s+){_DAY_RUN}(?:\s*{_YOIL})?){{0,6}}")
# 입력 다듬기 — 폭 없는 글자 · 태그 · 주소(URL · 'instagram.com/…' 같은 도메인).
_ZERO_WIDTH_RE = re.compile("[\u200b-\u200d\u2060\ufeff]")
# 파이썬 '\s' 만 공백으로 보는 제어 글자(U+001C~U+001F · U+0085)는 공백으로 — JS '\s' 와 같은 글자를 보게.
_ODD_SPACE_RE = re.compile("[\x1c-\x1f\x85]")
# BMP 밖 글자(이모지 등)는 대체 문자 하나로 — JS 는 이 글자를 두 칸(UTF-16)으로 세어 글자 수 창이 어긋난다.
_ASTRAL_RE = re.compile("[\U00010000-\U0010ffff]")
_BR_RE = re.compile(r"<br\s*/?>")
# 태그 안에 '<' 는 없다 — '<<<…' 같은 입력에서 태그 찾기가 끝까지 되읽지 않게 막는다.
_TAG_RE = re.compile(r"<[^<>]+>")
# 도메인은 낱말 머리에서만 찾고(1번 묶음 = 앞 글자, 지우지 않고 남긴다) 뒤 이름표는 셋까지만 — 'xxxx…' ·
# '.a.a.a…' 같은 입력에서 되돌아보기가 길이의 제곱으로 늘지 않게.
_URL_RE = re.compile(
    r"(?:https?://|www\.)\S+"
    r"|(^|[^a-z0-9_-])[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+){0,3}\.(?:com|net|org|kr|io|me|info|biz|jp|cn|us)"
    r"(?![a-z0-9])(?:/\S*)?"
)
_PAREN_RE = re.compile(r"\(([^()]*)\)")
# 다듬기 전 원문 상한 — 실제 문구는 태그를 넣어도 1,000자 안팎이다. 넘으면 잘린 원문으로 본다.
_MAX_RAW_TEXT = 4000
# 태그·주소를 걷은 뒤 600자 — 단체 관람 안내처럼 긴 문구 뒤의 정기 휴관일까지 읽는다.
_MAX_CLOSED_TEXT = 600


def _clean_source(raw: str, cap: int) -> tuple[str, bool]:
    """두 파서가 함께 쓰는 입력 다듬기 — 폭 없는 글자 제거 → 제어 공백 → NFKC → BMP 밖 글자 → 줄바꿈 태그는
    줄바꿈 → 태그·주소 제거 → 앞 ``cap`` 글자. 웹 cleanSource 와 같은 순서다. (다듬은 글, 잘렸는지)."""
    cleaned = _clean_text(raw[:_MAX_RAW_TEXT])
    return cleaned[:cap], len(raw) > _MAX_RAW_TEXT or len(cleaned) > cap


def _clean_text(raw: str) -> str:
    # 소문자로 맞춘 뒤 읽는다 — 대소문자 무시(re.I)를 쓰지 않아야 파이썬과 JS 가 터키어 점 없는 i(U+0131)·점 있는 I(U+0130) 같은 글자를 똑같이 본다.
    text = unicodedata.normalize("NFKC", _ODD_SPACE_RE.sub(" ", _ZERO_WIDTH_RE.sub("", raw)))
    text = _ASTRAL_RE.sub("\ufffd", text).lower()
    return _URL_RE.sub(lambda url: (url.group(1) or "") + " ", _TAG_RE.sub(" ", _BR_RE.sub("\n", text)))


@dataclass(frozen=True)
class _ClosedDayRules:
    open_all_year: bool = False
    weekly: frozenset[int] = frozenset()
    # (서수 집합, 마지막 주 여부, 요일 집합)
    monthly: tuple[tuple[frozenset[int], bool, frozenset[int]], ...] = ()
    uncertain: frozenset[int] = frozenset()
    truncated: bool = False

    @property
    def has_rules(self) -> bool:
        return bool(self.weekly or self.monthly or self.uncertain)


def _expand_day_list(text: str) -> set[int]:
    """'월·화' → {0, 1}, '월~수' → {0, 1, 2}(범위는 요일 순서로, '금~월' 처럼 주를 넘겨도 된다)."""
    days: set[int] = set()
    previous: int | None = None
    pending_range = False
    for token in re.findall(r"[월화수목금토일]|[~\-–〜∼]", text):
        if token in "~-–〜∼":
            pending_range = previous is not None
            continue
        index = _WEEKDAY_CHARS.index(token)
        if pending_range and previous is not None:
            step = previous
            while step != index:
                step = (step + 1) % 7
                days.add(step)
        days.add(index)
        previous = index
        pending_range = False
    return days


def _blank(text: str, start: int, end: int) -> str:
    """읽은 자리를 같은 길이의 공백으로 지운다(다음 단계가 같은 글자를 두 번 읽지 않게, 위치는 그대로)."""
    return text[:start] + " " * (end - start) + text[end:]


def _drop_holiday_conditions(text: str) -> str:
    if not _HOLIDAY_RE.search(text):
        return text  # 공휴일 낱말이 없으면 대체 휴무 조건도 없다

    def paren(match: re.Match) -> str:
        inner = "".join(_drop_condition_clause(piece) for piece in re.split(r"([,\n;])", match.group(1)))
        # 괄호 안을 다듬고도 공휴일·조건 낱말이 함께 남으면('or the following day if Monday is a holiday')
        # 괄호 전체가 대체 휴무 안내다.
        if _HOLIDAY_RE.search(inner) and _CONDITION_RE.search(inner):
            return " "
        return f" {inner} "

    text = _PAREN_RE.sub(paren, text)
    return "".join(_drop_condition_clause(piece) for piece in re.split(r"([,\n;])", text))


def _condition_start(piece: str, anchor_start: int) -> int | None:
    """조건 낱말 앞의 조건절 시작. 가장 가까운 시작에서 앞쪽 시작으로 이어 가되, 그 사이에 휴무 말·규칙 표지가
    끼면 멈춘다 — '월요일이 공휴일 또는 연휴와 겹치는 경우' 는 '월요일이' 부터, '공휴일 및 매주 월요일 휴무이며
    월요일이 공휴일인 경우' 는 뒤의 '월요일이' 부터다."""
    starts = [m for m in _CONDITION_START_RE.finditer(piece) if m.start() < anchor_start]
    if not starts:
        return None
    start = starts[-1]
    for earlier in reversed(starts[:-1]):
        if _CLOSURE_ANY_RE.search(piece[earlier.end():start.start()]):
            break
        start = earlier
    return start.start()


def _condition_end(piece: str, pos: int, conditional: bool) -> int:
    """조건절이 끝나는 자리. '다음날' 류는 결과 절이 없어 첫 이음말에서, 참 조건('경우'·'이면'·'겹치면')은 결과
    ('화요일 및 수요일 휴관')를 지나 새 규칙 표지(매주·매월·격주·정기)가 요일보다 먼저 나오는 이음말에서 끝난다.
    '…과 겹치면' 의 '과' 는 이음말이 아니다. 끝을 못 찾으면 절 끝."""
    for join in _JOIN_RE.finditer(piece, pos):
        if _OVERLAP_AFTER_RE.match(piece, join.end()):
            continue
        if not conditional:
            return join.start()
        following = _JOIN_RE.search(piece, join.end())
        segment = piece[join.end():following.start() if following else len(piece)]
        marker = _RULE_MARKER_RE.search(segment)
        weekday = re.search(_DAY, segment)
        if marker and (weekday is None or marker.start() < weekday.start()):
            return join.start()
    return len(piece)


def _drop_condition_clause(piece: str) -> str:
    """절 안의 조건절만 지운다 — 첫 조건 낱말 앞의 조건절 시작(_condition_start)부터 그 조건절이 끝나는 자리까지
    (_condition_end). 끝 뒤는 계속 읽는다: '공휴일 다음날 휴무 및 매주 월요일 휴무' 에서 앞 절만 버리고 월요일
    규칙은 남는다."""
    kept = ""
    while True:
        anchors = [m for m in (_TRUE_CONDITION_RE.search(piece), _RELATIVE_DAY_RE.search(piece)) if m]
        if not anchors:
            return kept + piece
        anchor = min(anchors, key=lambda m: m.start())
        start = _condition_start(piece, anchor.start())
        if start is None:
            return kept + piece  # 조건 낱말은 있지만 공휴일·주어가 앞에 없다 — 조건절이 아니다
        end = _condition_end(piece, anchor.end(), conditional=anchor.re is _TRUE_CONDITION_RE)
        kept += piece[:start] + " "
        if end >= len(piece):
            return kept
        piece = piece[end:]


def _bare_day_end_ok(text: str, end: int) -> bool:
    """'요일' 이 붙지 않은 낱글자는 뒤가 한글·숫자면 요일이 아니다('월 2회' 의 '월' = 달)."""
    following = text[end:end + 1]
    if following and _HANGUL_OR_DIGIT_RE.match(following):
        return False
    return not _DIGIT_AFTER_RE.match(text, end)


def _day_order_indexes(run: str) -> list[int]:
    return [_WEEKDAY_CHARS.index(char) for char in run]


def _strict_order(run: str) -> bool:
    indexes = _day_order_indexes(run)
    return all(later > earlier for earlier, later in zip(indexes, indexes[1:]))


def _cyclic_order(run: str) -> bool:
    """요일 순서로 한 바퀴 안('일월' · '토일월' 처럼 주를 한 번 넘는 것까지). 같은 글자 반복·두 바퀴는 아니다."""
    indexes = _day_order_indexes(run)
    span = sum((later - earlier) % 7 for earlier, later in zip(indexes, indexes[1:]))
    return len(set(indexes)) == len(indexes) and span < 7


def _bad_run(element: str) -> bool:
    return len(element) > 1 and (element in _NOT_DAY_RUNS or not _cyclic_order(element))


def _accept_day_run(text: str, match: re.Match, only_days: bool) -> bool:
    """요일 글자 덩어리가 정말 휴무 요일 목록인지 — 규칙은 이 절 머리 주석 참조."""
    start, end = match.start(), match.end()
    elements = _DAY_SEP_RE.split(match.group(1))
    if any(_bad_run(element) for element in elements):
        return False
    previous = text[start - 1] if start else ""
    if previous and previous in _DIGITS:
        return False
    has_yoil = bool(match.group(2))
    prefixed = bool(_CLOSURE_PREFIX_RE.search(text[max(0, start - 12):start]))
    if previous and _HANGUL_RE.match(previous):
        attached = len(elements[0]) == 1 and text.startswith(("요일", "욜"), start + 1)
        if elements[0] == "일" and not attached:
            return False  # 한글 뒤 '일' = 날(휴관일 · 매주일)
        if not attached and not prefixed:
            return False
    if has_yoil:
        return True
    if match.group(1) == "수" and _SU_ITTDA_RE.match(text, end):
        return False  # '수 있음' · '수 없음'
    # 뒤이은 요일('토 일 휴무' 의 ' 일')과 조사·이음말을 건너 휴무 낱말이 오면 휴무 요일이다.
    if _CLOSURE_AFTER_RE.match(text, _MORE_DAYS_RE.match(text, end).end()):
        return True
    if not _bare_day_end_ok(text, end):
        return False  # 낱말의 일부('휴관 일정' · '월간' · '월 2회')
    if prefixed:
        return True
    if any(len(element) > 1 and not _strict_order(element) for element in elements):
        return False  # '일월' 처럼 주를 넘는 덩어리는 휴무 낱말·앞말이 있어야 한다
    return len(elements) > 1 or only_days


def _day_runs(text: str, only_days: bool, pos: int = 0, latest_start: int | None = None) -> list[re.Match]:
    """요일 덩어리를 앞에서부터. 요일이 아닌 자리('당일, 월요일' 의 '일')면 한 글자 뒤에서 다시 찾는다 —
    그래야 같은 덩어리 안의 진짜 요일('월요일')을 놓치지 않는다."""
    runs: list[re.Match] = []
    while True:
        match = _DAY_RUN_RE.search(text, pos)
        if match is None or (latest_start is not None and match.start() > latest_start):
            return runs
        if _accept_day_run(text, match, only_days):
            runs.append(match)
            pos = match.end()
        else:
            pos = match.start() + 1


def _monthly_days_ok(text: str, match: re.Match) -> bool:
    if any(_bad_run(element) for element in _DAY_SEP_RE.split(match.group(2))):
        return False
    has_yoil = bool(match.group(3))
    return has_yoil or bool(_CLOSURE_AFTER_RE.match(text, match.end())) or _bare_day_end_ok(text, match.end())


def _closure_meaning(text: str, start: int, end: int, more_days: re.Pattern) -> str | None:
    """요일 언급(start~end)이 지금의 휴무를 말하는지 — 'closed' · 'partial'(하루 전체는 아님) · None(휴무 아님)."""
    before = text[max(0, start - 12):start]
    if _OPEN_PREFIX_RE.search(before):
        return None  # '영업: 월~금'
    rest = text[more_days.match(text, end).end():]
    if _TIME_AFTER_RE.match(rest) or _OPEN_AFTER_RE.match(rest) or _NOT_CLOSURE_AFTER_RE.match(rest):
        return None
    if _PARTIAL_DAY_AFTER_RE.match(rest):
        return "partial"  # '토요일 오후 휴무' — 하루 전체가 닫힌 것은 아니다.
    clause_end = _CLAUSE_END_RE.search(rest)
    clause = rest[:clause_end.start()] if clause_end else rest
    first_open = _OPEN_WORD_RE.search(clause)
    if (
        first_open
        and clause[first_open.start() - 1:first_open.start()] not in ("미", "비")  # '미운영' · '비개방'
        and not _OPEN_NEGATION_RE.match(clause, first_open.end())
        and not _CLOSURE_ANY_RE.search(clause)
        and not _EXCEPT_RE.search(clause, 0, first_open.start())
        and not _OPEN_CONDITION_RE.search(clause, 0, first_open.start())
        and not _CLOSURE_PREFIX_RE.search(before)  # '휴무일: 매주 월요일 (공휴일 정상영업)' — 휴무 앞말이 이긴다
    ):
        return None  # '… 21시까지 연장 운영' — 이 절이 처음 말하는 것이 영업이다
    return "closed"


def _clause_around(text: str, start: int, end: int) -> tuple[str, str]:
    """영어 요일 이름이 든 절(, ; / 줄로 나눈 것)과 그 절에서 이름 앞부분."""
    clause_start = max(text.rfind(delimiter, 0, start) for delimiter in _EN_CLAUSE_DELIMITERS) + 1
    ends = [pos for pos in (text.find(delimiter, end) for delimiter in _EN_CLAUSE_DELIMITERS) if pos != -1]
    return text[clause_start:min(ends, default=len(text))], text[clause_start:start]


@lru_cache(maxsize=4096)
def _parse_closed_days(raw: str) -> _ClosedDayRules | None:
    text, truncated = _clean_source(raw, _MAX_CLOSED_TEXT)
    text = text.translate(str.maketrans("（）［］【】〔〕[]", "()()()()()"))
    if not text.strip():
        return None
    open_all_year = bool(_OPEN_ALL_YEAR_RE.search(text))
    only_days = bool(_ONLY_DAYS_RE.fullmatch(text))
    closure_words = bool(_CLOSURE_ANY_RE.search(text))

    # 0) '토(격주)' — 괄호로 격주를 단 요일은 모름이다. 괄호만 지우고 요일은 남겨 목록을 잇는다.
    annotated: set[int] = set()
    for match in list(_ANNOTATED_UNCERTAIN_RE.finditer(text)):
        previous = text[match.start() - 1] if match.start() else ""
        if previous and _HANGUL_OR_DIGIT_RE.match(previous) and not match.group(2):
            continue  # '매월(격주)' 의 '월' 은 요일이 아니다
        annotated.add(_WEEKDAY_CHARS.index(match.group(1)))
        text = _blank(text, match.start() + match.group(0).index("("), match.end())

    text = _drop_holiday_conditions(text)
    text = _GLUED_ORDINAL_RE.sub("째 ", _ELLIPSIS_ORDINAL_RE.sub(r"\g<1>째", text))
    weekly: set[int] = set()
    uncertain: set[int] = set()
    monthly: list[tuple[frozenset[int], bool, frozenset[int]]] = []

    # 1) 매월 n번째 요일(한국어). 거른 자리에서는 한 글자 뒤부터 다시 찾는다('12월 둘째 일요일').
    pos = 0
    while (match := _MONTHLY_RE.search(text, pos)) is not None:
        start, group = match.start(), match.group(1)
        prefixed = match.group(0).startswith(("매월", "매달"))
        if (
            (not prefixed and start and text[start - 1] in _DIGITS)
            or not _ORDINAL_MARK_RE.search(group)
            or not _monthly_days_ok(text, match)
        ):
            pos = start + 1
            continue
        if _closure_meaning(text, start, match.end(), _MORE_DAYS_RE) == "closed":
            tokens = _ORDINAL_TOKEN_RE.findall(group)
            ordinals = {_ORDINAL_VALUE[token] for token in tokens if token not in _LAST_ORDINALS}
            last = any(token in _LAST_ORDINALS for token in tokens)
            monthly.append((frozenset(ordinals), last, frozenset(_expand_day_list(match.group(2)))))
        text = _blank(text, start, match.end())  # 휴무가 아닌 매월 언급('마지막 수요일 … 연장 운영')도 읽은 것으로
        pos = match.end()

    # 2) 매월 n번째 요일(영어) — '1st and 3rd Sundays' 는 '매달 1, 3번째 일요일' 과 같은 규칙이다.
    pos = 0
    while (match := _EN_MONTHLY_RE.search(text, pos)) is not None:
        word_start = match.start() + len(match.group(1))
        pos = match.end()
        if _EN_OPEN_RE.search(re.split(r"[,;\n]", text[:word_start])[-1]):
            continue  # 'Open the first Monday' 같은 영업 요일
        tokens = re.findall(_EN_ORDINAL, match.group(2))
        ordinals = frozenset(_EN_ORDINAL_VALUE[token] for token in tokens if token != "last")
        monthly.append((ordinals, "last" in tokens, frozenset({_EN_DAY_INDEX[match.group(3)]})))
        text = _blank(text, word_start, match.end())

    # 3) 서수 없는 매월·격주 — 그 요일은 모름. 표시(격주·매월) 뒤 12글자 안에서 시작하는 요일 덩어리.
    for marker in list(_KO_UNCERTAIN_MARKER_RE.finditer(text)):
        if text[marker.start():marker.end()] != marker.group(0):
            continue  # 앞 단계가 이미 읽어 지운 자리
        runs = _day_runs(text, only_days, marker.end(), marker.end() + 12)
        if not runs:
            continue
        gap = text[marker.end():runs[0].start()]
        if "매주" in gap or "\n" in gap or ";" in gap:
            continue
        uncertain |= _expand_day_list(runs[0].group(1))
        text = _blank(text, marker.start(), runs[0].end())

    for marker in list(_EN_UNCERTAIN_RE.finditer(text)):
        word_start = marker.start() + len(marker.group(1))
        if text[word_start:marker.end()] != marker.group(0)[len(marker.group(1)):]:
            continue
        window = re.split(r"[,;\n]", text[marker.end():marker.end() + 30], maxsplit=1)[0]
        day = _EN_DAY_RE.search(window)
        if day:
            uncertain.add(_EN_DAY_INDEX[day.group(2)])
            text = _blank(text, word_start, marker.end() + day.end())

    def add_days(days: set[int], start: int, end: int, more_days: re.Pattern = _MORE_DAYS_RE) -> None:
        meaning = _closure_meaning(text, start, end, more_days)
        if meaning == "closed":
            weekly.update(days)
        elif meaning == "partial":
            uncertain.update(days)

    # 4) 매주 요일
    for match in _day_runs(text, only_days):
        add_days(_expand_day_list(match.group(1)), match.start(), match.end())
    for match in _KO_WEEKEND_RE.finditer(text):
        add_days({5, 6}, match.start(), match.end())
    for regex, days_of in ((_EN_DAY_RE, lambda m: {_EN_DAY_INDEX[m.group(2)]}), (_EN_WEEKEND_RE, lambda m: {5, 6})):
        for match in regex.finditer(text):
            word_start = match.start() + len(match.group(1))
            clause, before = _clause_around(text, word_start, match.end())
            if _EN_OPEN_RE.search(before):
                continue  # 'Open Mon-Sat, closed Sundays' 의 영업 요일
            if _EN_CLOSED_BEFORE_RE.search(before):
                weekly.update(days_of(match))  # 'Closed Wednesdays (open on public holidays)'
            elif _EN_CLOSURE_CONTEXT_RE.search(clause) or _EN_ONLY_DAYS_RE.fullmatch(clause):
                add_days(days_of(match), word_start, match.end(), _EN_MORE_DAYS_RE)

    if len(weekly) == 7 and not closure_words:
        weekly = set()  # '월화수목금토일' · '월~일' — 휴무 낱말 없이 일곱 요일이면 휴무 규칙이 아니다
    weekly -= annotated
    uncertain = (uncertain | annotated) - weekly
    if not (weekly or monthly or uncertain):
        # 명시한 매주·매월 규칙이 하나도 없을 때만 '무휴' 가 연중무휴다.
        return _ClosedDayRules(open_all_year=open_all_year, truncated=truncated)
    return _ClosedDayRules(
        weekly=frozenset(weekly), monthly=tuple(monthly), uncertain=frozenset(uncertain), truncated=truncated,
    )


def closed_day_status(raw: object, at: datetime) -> Literal["closed", "uncertain", "open"] | None:
    """휴무일 원문이 ``at``(한국 날짜) 에 대해 말하는 것.

    closed = 그날 휴무, uncertain = 그날인지 알 수 없음(격주·서수 없는 매월 · 600자를 넘겨 잘린 원문),
    open = 휴무 규칙을 읽었고 그날은 해당하지 않음(연중무휴 포함), None = 읽을 수 있는 규칙이 없음.
    """
    rules = _parse_closed_days(str(raw or ""))
    if rules is None:
        return None
    if rules.truncated:
        return "uncertain"
    if rules.open_all_year:
        return "open"
    local = at.astimezone(KST)
    weekday = local.weekday()
    if weekday in rules.weekly:
        return "closed"
    if rules.monthly:
        nth = (local.day - 1) // 7 + 1
        is_last = local.day + 7 > calendar.monthrange(local.year, local.month)[1]
        for ordinals, last, days in rules.monthly:
            if weekday in days and (nth in ordinals or (last and is_last)):
                return "closed"
    if weekday in rules.uncertain:
        return "uncertain"
    return "open" if rules.has_rules else None


# ── 영업시간 원문 해석 ────────────────────────────────────────────────────────────────────
#
# 시각 범위('09:00~18:00')를 영업 구간으로 읽는다. 쉬는 시간은 닫힌 구간이다 — 쉬는 시간 말이 범위 **바로 앞**에
# 있을 때('브레이크타임 15:00~17:00' · '(브레이크타임 15시~17시)' · '(break 3-5pm)' — '15시~17시'·'3-5pm' 꼴은 이
# 경우에만 읽는다). 쉬는 시간 말이 범위 **뒤**에 붙었거나('15:00~17:00 브레이크타임') 말 없는 괄호 범위
# ('11:00~21:00 (15:00~17:00)')가 다른 영업 구간 안쪽에 짧게 들어 있으면 '쉬는 시간일 수도' 다 — 그 시간에는
# 영업 확인 필요로 둔다. 모르는 것을 closed_confirmed 로 만들지 않는다(그 시각 후보에서 통째로 빠진다).
# 쉬는 시간 말이 범위 뒤에 와도 그 범위가 다른 구간 안쪽이 아니면 영업 구간이다('11:00~21:00 브레이크타임 있음').
# 시각 없는 쉬는 시간 말('(휴게시간 있음)')은 어느 범위도 쉬는 시간으로 만들지 않는다. '휴게'·'휴식' 은 바로 뒤에
# '시간' 이나 시각이 올 때만 쉬는 시간 말이다('휴게소'·'휴게음식점'·'휴식 공간' 은 아니다 · 'Breakfast' 도 아니다).
# 닫는 시각 '24:00' 은 자정까지다. 입장 마감('입장 마감 17:00' · '마지막 입장' · 'last entry' · 라스트오더)은
# 그 구간의 실제 닫는 시각이다 — 입장이 끝난 뒤 도착하면 들어갈 수 없다(같은 줄의 가장 가까운 앞 구간에 건다).
# 입력은 휴무일 원문과 같이 다듬은 뒤(_clean_source) 500자까지만 읽고, 잘렸으면 무엇도 단정하지 않는다(확인 필요).
# 웹 lib/restDate.ts 의 getArrivalOpenStatus 와 같은 규칙이다(같은 사례 파일).

# 하루 종일 열려 있는 곳 — '상시 개방'·'24시간'·'연중 개방'(경주 계림·월성 같은 야외 유적). 문자열 **전체**가
# 이 말일 때만 인정한다 — '시설별로 상이함' 같은 문장은 그대로 미확인. 웹이 2026-10-06 먼저 넣었고(ALWAYS_OPEN),
# 서버는 순위가 바뀌는 변경이라 공모전 뒤로 미뤘던 것을 같은 식으로 맞춘다.
_ALWAYS_OPEN_RE = re.compile(
    r"(?:연중\s*무휴\s*)?(?:상시\s*(?:개방|운영)?|24\s*시(?:간)?(?:\s*(?:개방|운영|영업))?"
    r"|연중\s*(?:무휴\s*)?(?:상시\s*)?개방)"
)
# 하루 종일 연다는 말로 **시작**하고 시각 범위가 뒤따르면('24시간 (단, 03:00~05:00 청소시간)' · '상시 개방 (야간 출입
# 통제 22:00~06:00)') 하루 종일 영업 + 그 범위는 닫힐 수도 있는 구간이다 — 범위만 영업으로 읽어 낮에 닫힘으로 빼지 않는다.
_ALWAYS_OPEN_LEAD_RE = re.compile(r"(?:연중\s*(?:무휴\s*)?)?(?:상시\s*(?:개방|운영)|24\s*시간)")
_CLOCK = r"(?:[01]?[0-9]|2[0-3]):[0-5][0-9]"
_RANGE_DASH = r"[~\-–—〜∼]"
# 닫는 시각 앞의 '익일'·'새벽'('11:00~익일 01:00')은 자정을 넘는다는 말일 뿐이다.
_TIME_RANGE_RE = re.compile(rf"({_CLOCK})\s*{_RANGE_DASH}\s*(?:(?:익일|다음\s*날|새벽)\s*)?({_CLOCK}|24:00)")
# 쉬는 시간 시각의 다른 꼴 — '15시~17시' · '15~17시' · '15:30~17시', '3-5pm' · '2:30-5pm'. 쉬는 시간 말이 바로
# 앞에 있을 때만 쓴다(영업시간으로는 읽지 않는다).
_SI_RANGE_RE = re.compile(
    rf"([0-9]{{1,2}})(?::([0-5][0-9]))?(?:\s*시)?\s*{_RANGE_DASH}\s*([0-9]{{1,2}})(?::([0-5][0-9]))?\s*시"
)
_AMPM_RANGE_RE = re.compile(
    rf"([0-9]{{1,2}})(?::([0-5][0-9]))?(?:\s*(am|pm))?\s*{_RANGE_DASH}\s*([0-9]{{1,2}})(?::([0-5][0-9]))?\s*(am|pm)",
)
# 쉬는 시간 범위 바로 뒤에 목록 이음만 두고 이어진 범위('휴게시간 12:00~13:00, 18:00~19:00')도 쉬는 시간 후보다.
_LIST_GAP_RE = re.compile(r"\s*(?:[,·/&]|및|와|과)\s*")
# '휴게'·'휴식' 은 '시간' 이나 시각이 바로 뒤에 올 때만 쉬는 시간이다 — '휴게소'·'휴게음식점'·'휴식 공간' 은 아니다.
_BREAK_WORD_RE = re.compile(
    r"브레이크|break(?!fast)|쉬는\s*시간|준비\s*시간|(?:휴게|휴식)(?:\s*시간|(?=\s*(?::\s*)?[0-9]))"
)
# 선택 조각은 '공백 + 반드시 있는 글자' 꼴로만 둔다(공백만 홀로 선택되면 되돌아보기가 곱으로 는다 — 휴무일 절 참조).
_BREAK_NEGATED_RE = re.compile(
    r"(?:\s*(?:타임|time|시간))?(?:\s*:)?\s*(?:없|무(?![가-힣])|x(?![a-z])|none)"
)
_NO_BEFORE_RE = re.compile(r"(?:^|[^a-z])no\s*$")
# 입장 마감 — 말 다음 시각('입장 마감 17:00' · 'L.O 20:30'), 또는 시각 다음 말('17:00까지 입장').
_LAST_ENTRY_LABEL = (
    r"입장\s*마감|마지막\s*입장|최종\s*입장|매표\s*마감|발권\s*마감|라스트\s*오더"
    r"|last\s*(?:entry|admission|order)|l\.\s*o\.?"
)
_LAST_ENTRY_RE = re.compile(
    rf"(?:{_LAST_ENTRY_LABEL})(?:\s*(?:시간|시각))?(?:\s*(?:은|는))?(?:\s*:)?\s*(?:~\s*)?({_CLOCK})"
)
_ENTRY_UNTIL_RE = re.compile(rf"({_CLOCK})\s*(?:까지\s*입장|입장\s*마감)")
_DAY_MINUTES = 24 * 60
# 영업시간 원문은 철·문·요일마다 줄이 늘어 휴무 문구보다 길다(실적재 수십~200자대) — 다듬은 뒤 500자까지만 읽는다.
_MAX_HOURS_TEXT = 500
# 말 없는 괄호 범위를 '쉬는 시간일 수도' 로 볼 길이 — 3시간 이하이면서 바깥 구간의 절반보다 짧을 때만.
# '09:00~18:00 (10:00~17:00)' 같은 긴 괄호 범위는 다른 철·창구의 영업시간이다.
_MAX_BARE_BREAK_MINUTES = 180


def _has_break_word(segment: str) -> bool:
    """쉬는 시간 말이 있는지 — '브레이크타임 없음'·'no break' 는 쉬는 시간이 아니다."""
    for match in _BREAK_WORD_RE.finditer(segment):
        if _BREAK_NEGATED_RE.match(segment, match.end()):
            continue
        if _NO_BEFORE_RE.search(segment[:match.start()]):
            continue
        return True
    return False


def _clock_minutes(value: str) -> int:
    hour, minute = value.split(":")
    return int(hour) * 60 + int(minute)


def _hour_minutes(hour: str, minute: str | None) -> int | None:
    value = int(hour) * 60 + int(minute or 0)
    return value if value <= _DAY_MINUTES else None


def _ampm_minutes(hour: str, minute: str | None, suffix: str) -> int | None:
    hour_value = int(hour)
    if not 1 <= hour_value <= 12:
        return None
    hour_value = hour_value % 12 + (12 if suffix == "pm" else 0)
    return hour_value * 60 + int(minute or 0)


def _afternoon_break(interval: tuple[int, int], opens: list[tuple[int, int]]) -> tuple[int, int]:
    """쉬는 시간은 영업 구간 안에 있다 — 오전 시각('브레이크타임 3시~5시')이 어느 영업 구간 안에도 없고 12시간
    뒤(15시~17시)가 안에 있으면 오후로 읽는다."""
    start, end = interval
    if start >= 12 * 60 or end > 12 * 60 or any(_strictly_inside(interval, outer) for outer in opens):
        return interval
    shifted = (start + 12 * 60, end + 12 * 60)
    return shifted if any(_strictly_inside(shifted, outer) for outer in opens) else interval


def _alternate_break_interval(match: re.Match) -> tuple[int, int] | None:
    """'15시~17시' · '3-5pm' 꼴 쉬는 시간을 분 구간으로. 읽을 수 없으면 None."""
    if match.re is _SI_RANGE_RE:
        start, end = _hour_minutes(match.group(1), match.group(2)), _hour_minutes(match.group(3), match.group(4))
    else:
        end_suffix = match.group(6)
        start_suffix = match.group(3) or end_suffix
        end = _ampm_minutes(match.group(4), match.group(5), end_suffix)
        start = _ampm_minutes(match.group(1), match.group(2), start_suffix)
        if match.group(3) is None and start is not None and end is not None and start > end:
            start = _ampm_minutes(match.group(1), match.group(2), "am" if end_suffix == "pm" else "pm")
    if start is None or end is None or start == end:
        return None
    return (start, end % _DAY_MINUTES if end == _DAY_MINUTES else end)


def _is_full_day(interval: tuple[int, int]) -> bool:
    start, end = interval
    return start == 0 and end in (0, _DAY_MINUTES)  # '00:00~24:00' · '00:00~00:00'


def _interval_contains(interval: tuple[int, int], minute: int) -> bool:
    start, end = interval
    if _is_full_day(interval):
        return True
    if end > start:
        return start <= minute < end
    return minute >= start or minute < end  # 자정을 넘는 구간


def _interval_length(interval: tuple[int, int]) -> int:
    start, end = interval
    return _DAY_MINUTES if _is_full_day(interval) else (end - start) % _DAY_MINUTES


def _minutes_until_close(interval: tuple[int, int], minute: int) -> int:
    start, end = interval
    return end - minute if end > start else (end - minute) % _DAY_MINUTES


def _strictly_inside(inner: tuple[int, int], outer: tuple[int, int]) -> bool:
    start, end = outer
    if end <= start:
        end += _DAY_MINUTES
    inner_start, inner_end = inner
    if inner_start < start:
        inner_start += _DAY_MINUTES
    if inner_end <= inner_start:
        inner_end += _DAY_MINUTES
    return start < inner_start and inner_end < end


def _cap_close(interval: tuple[int, int], minute: int) -> tuple[int, int]:
    """입장 마감 시각이 구간 안이면 그 시각을 닫는 시각으로(자정을 넘는 구간 포함). 밖이면 그대로."""
    start, end = interval
    end_unwrapped = end if end > start else end + _DAY_MINUTES
    minute_unwrapped = minute if minute > start else minute + _DAY_MINUTES
    if start < minute_unwrapped < end_unwrapped:
        return (start, minute_unwrapped % _DAY_MINUTES)
    return interval


def _apply_last_entry(
    text: str, opens: list[tuple[int, int, tuple[int, int]]]
) -> list[tuple[int, int, tuple[int, int]]]:
    """입장 마감을 같은 줄의 가장 가까운 앞 구간(없으면 뒤 구간, 구간이 하나뿐이면 그 구간)의 닫는 시각으로.

    '평일 09:00~18:00 (입장마감 17:00), 주말 09:00~19:00 (입장마감 18:00)' 처럼 한 줄에 둘이어도 각자의 구간에
    건다. 범위의 끝('09:00~17:00 입장마감' 의 17:00)은 입장 마감으로 읽지 않는다 — 그건 이미 닫는 시각이다.
    """
    entries = [(m.start(), m.end(), _clock_minutes(m.group(1))) for m in _LAST_ENTRY_RE.finditer(text)]
    entries += [
        (m.start(), m.end(), _clock_minutes(m.group(1)))
        for m in _ENTRY_UNTIL_RE.finditer(text)
        if not text[:m.start()].rstrip().endswith(("~", "-", "–", "—"))
    ]
    capped = list(opens)
    for entry_start, entry_end, minute in entries:
        line_start = text.rfind("\n", 0, entry_start) + 1
        line_end = text.find("\n", entry_end)
        line_end = len(text) if line_end == -1 else line_end
        same_line = [i for i, (start, end, _) in enumerate(capped) if line_start <= start and end <= line_end]
        before = [i for i in same_line if capped[i][1] <= entry_start]
        after = [i for i in same_line if capped[i][0] >= entry_end]
        if before:
            target = max(before, key=lambda i: capped[i][1])
        elif after:
            target = min(after, key=lambda i: capped[i][0])
        elif len(capped) == 1:
            target = 0
        else:
            continue
        start, end, interval = capped[target]
        capped[target] = (start, end, _cap_close(interval, minute))
    return capped


def _lead_in(text: str, match: re.Match, floor: int, parens: list[tuple[int, int, str]]) -> str:
    """범위와 그 바로 앞의 말 — 같은 절(줄·쉼표·쌍반점), 같은 괄호, 앞 범위 뒤에서부터 범위 끝까지
    (범위까지 넣어야 '휴게 15:00' 처럼 시각이 바로 뒤에 와야 쉬는 시간 말이 되는 낱말을 가린다). 그 사이의 닫힌
    괄호 글('(브레이크타임 있음) 11:30~21:00')은 그 범위의 말이 아니라 지운다."""
    position = match.start()
    clause_start = max(text.rfind(delimiter, 0, position) for delimiter in "\n,;") + 1
    inside = next((start + 1 for start, end, _ in parens if start < position < end), 0)
    segment = text[max(clause_start, inside, floor):match.end()]
    return _PAREN_RE.sub(lambda paren: " " * len(paren.group(0)), segment)


@lru_cache(maxsize=4096)
def _parse_opening_hours(raw: str) -> tuple[
    bool, tuple[tuple[int, int], ...], tuple[tuple[int, int], ...], tuple[tuple[int, int], ...], bool
]:
    """(하루 종일 영업, 영업 구간들, 쉬는 시간 구간들, 쉬는 시간일 수도 있는 구간들, 원문이 잘렸는지).

    구간은 0시부터의 분(닫는 쪽 24:00 = 1440)."""
    text, truncated = _clean_source(raw, _MAX_HOURS_TEXT)
    collapsed = " ".join(text.split())
    if _ALWAYS_OPEN_RE.fullmatch(collapsed):
        return True, (), (), (), truncated
    parens = [(match.start(), match.end(), match.group(1)) for match in _PAREN_RE.finditer(text)]
    matches = list(_TIME_RANGE_RE.finditer(text))
    if matches and _ALWAYS_OPEN_LEAD_RE.match(collapsed):
        # '24시간 (단, 03:00~05:00 청소시간)' — 하루 종일 영업이고, 범위는 닫힐 수도 있는 구간이다.
        possible = tuple((_clock_minutes(match.group(1)), _clock_minutes(match.group(2))) for match in matches)
        return False, ((0, _DAY_MINUTES),), (), possible, truncated
    # 영업·괄호 범위는 글 위치를 함께 둔다 — 입장 마감을 같은 줄의 구간에 걸 때 쓴다(_apply_last_entry).
    opens: list[tuple[int, int, tuple[int, int]]] = []
    breaks: list[tuple[int, int]] = []
    bare: list[tuple[int, int, tuple[int, int]]] = []
    labelled_after: list[tuple[int, int, tuple[int, int]]] = []
    listed: list[tuple[int, int, tuple[int, int]]] = []
    previous_break = False
    for index, match in enumerate(matches):
        interval = (_clock_minutes(match.group(1)), _clock_minutes(match.group(2)))
        located = (match.start(), match.end(), interval)
        previous_end = matches[index - 1].end() if index else 0
        if _has_break_word(_lead_in(text, match, previous_end, parens)):
            breaks.append(interval)  # 쉬는 시간 말이 바로 앞(같은 절·같은 괄호)
            previous_break = True
            continue
        if previous_break and _LIST_GAP_RE.fullmatch(text[previous_end:match.start()]):
            listed.append(located)  # '휴게시간 12:00~13:00, 18:00~19:00' 의 둘째 범위
            continue
        previous_break = False
        inner = next((body for start, end, body in parens if start < match.start() and match.end() < end), None)
        if inner is not None:
            if inner.strip() == match.group(0).strip():
                bare.append(located)
            elif _has_break_word(inner):
                labelled_after.append(located)  # '(15:00~16:00 브레이크)' — 쉬는 시간 말이 범위 뒤
            else:
                opens.append(located)
            continue
        # 괄호 밖 범위 뒤에(같은 절, 다음 범위·괄호 전까지) 쉬는 시간 말이 붙었으면 '쉬는 시간일 수도'.
        clause_end = min(
            (pos for pos in (text.find(delimiter, match.end()) for delimiter in "\n,;") if pos != -1),
            default=len(text),
        )
        next_start = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        after = text[match.end():min(clause_end, next_start)].split("(")[0]
        (labelled_after if _has_break_word(after) else opens).append(located)
    # '15시~17시' · '3-5pm' 꼴 쉬는 시간 — 쉬는 시간 말이 바로 앞에 있을 때만.
    standard_spans = [(match.start(), match.end()) for match in matches]
    for match in [*_SI_RANGE_RE.finditer(text), *_AMPM_RANGE_RE.finditer(text)]:
        if any(start < match.end() and match.start() < end for start, end in standard_spans):
            continue
        floor = max((end for _, end in standard_spans if end <= match.start()), default=0)
        interval = _alternate_break_interval(match)
        if interval is not None and _has_break_word(_lead_in(text, match, floor, parens)):
            breaks.append(interval)
    open_intervals = [interval for _, _, interval in opens]
    for located in listed:
        # 목록으로 이어진 쉬는 시간 후보는 다른 영업 구간 안쪽일 때만 쉬는 시간이다('브레이크타임 15:00~17:00,
        # 11:00~21:00' 의 둘째 범위는 영업 구간).
        (breaks.append(located[2]) if any(_strictly_inside(located[2], outer) for outer in open_intervals)
         else opens.append(located))
    breaks = [_afternoon_break(interval, open_intervals) for interval in breaks]
    possible: list[tuple[int, int]] = []
    # 뒤에 쉬는 시간 말이 붙은 범위: 다른 영업 구간 안쪽이면 쉬는 시간일 수도. 다른 영업 구간이 하나도 없으면 짧은
    # 범위('15:00~17:00 브레이크타임')는 그 자체가 쉬는 시간일 수 있고, 긴 범위('11:00~21:00 브레이크타임 있음')는 영업 구간이다.
    for located in labelled_after:
        inside = any(_strictly_inside(located[2], outer) for outer in open_intervals)
        if inside or (not open_intervals and _interval_length(located[2]) <= _MAX_BARE_BREAK_MINUTES):
            possible.append(located[2])
        else:
            opens.append(located)
    for located in bare:
        outer = next((outer for outer in open_intervals if _strictly_inside(located[2], outer)), None)
        length = _interval_length(located[2])
        if outer is not None and length <= _MAX_BARE_BREAK_MINUTES and length * 2 < _interval_length(outer):
            possible.append(located[2])
        else:
            opens.append(located)
    opens = _apply_last_entry(text, opens)
    return False, tuple(interval for _, _, interval in opens), tuple(breaks), tuple(possible), truncated


def _status_from_intervals(
    opens: tuple[tuple[int, int], ...],
    breaks: tuple[tuple[int, int], ...],
    possible: tuple[tuple[int, int], ...],
    minute: int,
) -> str:
    containing = [interval for interval in opens if _interval_contains(interval, minute)]
    if not containing or any(_interval_contains(interval, minute) for interval in breaks):
        return "closed_confirmed"
    if any(_interval_contains(interval, minute) for interval in possible):
        return "needs_confirmation"  # 쉬는 시간일 수도 — 단정하지 않는다
    # 겹치는 구간이 여럿이면 가장 늦게 닫는 구간을 쓴다('11:00~15:00, 09:00~22:00' 의 14:45 는 영업 중이다).
    remaining = (
        None if any(_is_full_day(interval) for interval in containing)
        else max(_minutes_until_close(interval, minute) for interval in containing)
    )
    for start, _end in breaks:
        until_break = (start - minute) % _DAY_MINUTES
        if until_break and (remaining is None or until_break < remaining):
            remaining = until_break  # 곧 쉬는 시간 — 닫는 것과 같다
    if remaining is not None and remaining <= 30:
        return "closing_soon"
    if any(0 < (start - minute) % _DAY_MINUTES <= 30 for start, _end in possible):
        return "needs_confirmation"  # 곧 쉬는 시간일 수도
    return "open_expected"


def open_status_at_arrival(facility: dict, arrival_at: datetime) -> str:
    """Return one of open_expected, closing_soon, closed_confirmed, needs_confirmation."""
    availability = facility.get("availability_evidence")
    if is_effective_availability_evidence(availability, at=arrival_at):
        return "open_expected" if availability["status"] == "open" else "closed_confirmed"
    local = arrival_at.astimezone(KST)
    hours = facility.get("operating_hours")
    if not isinstance(hours, dict):
        hours = {}
    closed = closed_day_status(hours.get("closed"), local)
    if closed == "closed":
        return "closed_confirmed"
    if closed == "uncertain":
        # 격주·서수 없는 매월 휴무의 그 요일 — 시각 범위가 있어도 그날 연다고 말할 수 없다.
        return "needs_confirmation"

    day_key = "weekday" if local.weekday() < 5 else "weekend"
    raw = str(hours.get(day_key) or hours.get("open") or "")
    always_open, opens, breaks, possible, truncated = _parse_opening_hours(raw)
    if always_open:
        return "open_expected"
    if truncated or not opens:
        # 500자를 넘겨 잘린 원문은 읽지 못한 뒤쪽에 다른 시각·쉬는 시간이 있을 수 있다 — 무엇도 단정하지 않는다.
        return "needs_confirmation"
    return _status_from_intervals(opens, breaks, possible, local.hour * 60 + local.minute)


# 도착 시각 자격 탈락 사유. 화면이 '왜 비었는지' 를 말할 수 있어야 해서 코드로 남긴다
# (개수 차이로 이유를 추측하게 두면 그건 값을 지어내는 것이다).
ARRIVAL_CLOSED = "closed_at_arrival"              # 닫혔거나 도착 후 30분 안에 닫힌다
ARRIVAL_LATE_NIGHT_UNCONFIRMED = "late_night_unconfirmed"  # 심야 + 영업 미확인 식당·카페


def arrival_ineligibility_reason(facility: dict, arrival_at: datetime) -> str | None:
    """이 시각에 보낼 수 없는 이유. 보낼 수 있으면 None.

    is_recommendable_at_arrival 의 판정을 그대로 쓰되 **왜** 를 함께 돌려준다. 두 함수가
    각자 규칙을 갖지 않도록 아래 bool 판정은 이 함수를 감싸기만 한다 — 규칙이 갈라지면
    화면이 말하는 이유와 실제 탈락 사유가 어긋난다.
    """
    status = open_status_at_arrival(facility, arrival_at)
    # 도착 후 30분 안에 닫히는 곳도 이동 목적지로 권하지 않는다.
    if status in {"closed_confirmed", "closing_soon"}:
        return ARRIVAL_CLOSED
    if status == "needs_confirmation" and facility.get("type") in FOOD_TYPES:
        local = arrival_at.astimezone(KST)
        minute = local.hour * 60 + local.minute
        # 심야에는 미확인 식당·카페를 '확인 필요' 후보로도 보내지 않는다.
        if minute >= LATE_NIGHT_START_MINUTE or minute < LATE_NIGHT_END_MINUTE:
            return ARRIVAL_LATE_NIGHT_UNCONFIRMED
    return None


def is_recommendable_at_arrival(facility: dict, arrival_at: datetime) -> bool:
    """Return whether the place can enter any honest recommendation tier."""
    return arrival_ineligibility_reason(facility, arrival_at) is None


def recommendation_eligibility_tier(
    facility: dict,
    arrival_at: datetime,
    travel_source: str,
) -> int | None:
    """Classify a candidate before SPOT scoring; ``None`` means never recommend.

    Opening-hours evidence is more important than route precision. A verified-open
    place with an honest distance estimate therefore remains preferable to a place
    whose opening hours are unknown. Callers rank by tier before score and fill weaker
    tiers only when stronger ones cannot meet the limit (select_eligibility_tiers).
    """
    if not is_recommendable_at_arrival(facility, arrival_at):
        return None
    hours_verified = open_status_at_arrival(facility, arrival_at) == "open_expected"
    route_verified = travel_source == "osm_pedestrian"
    if hours_verified:
        return 0 if route_verified else 1
    return 2 if route_verified else 3


def select_eligibility_tiers(
    candidates: list[tuple],
    limit: int,
    *,
    fill_weaker: bool,
    fill_order: Callable[[tuple], object] | None = None,
) -> list[tuple]:
    """채점할 후보 — 가장 강한 등급 전부, ``fill_weaker`` 이고 그것이 ``limit`` 보다 적으면 다음 등급들에서 채운다.

    가장 강한 등급만 남기면, 영업시간이 확인된 곳이 반경에 하나라도 있을 때 영업시간이 빈 카카오·LocalData 행
    1,000여 곳이 통째로 빠져 모두가 같은 소수 가게로 몰린다(분산과 반대). 채우면 호출부가 (등급, SPOT 정렬 키)
    순으로 정렬해 확인된 곳이 언제나 앞이고, 채운 카드는 자기 등급('영업 확인 필요')을 단다.

    ``fill_weaker`` 는 호출부가 반드시 정한다(요청의 fill_weaker_tiers). 배포된 구 웹 번들은 응답을 점수로 다시
    줄 세워 eligibility_tier 를 보지 않는다 — 채운 미확인 카드가 그 화면에서는 맨 앞에 설 수 있어서, 등급 순으로
    그리는 번들이 청할 때만 채운다. False 면 종전 그대로 가장 강한 등급만 돌려준다.

    각 tuple 의 마지막 항목이 등급이다. 가장 강한 등급은 전부(종전과 같다), 채우는 등급은 모자란 개수 ×
    TIER_FILL_POOL_FACTOR 개까지만 ``fill_order``(호출부는 도보 시간이 짧은 순) 순서로 데려온다 — 채점 비용 상한.
    """
    if not candidates:
        return []
    limit = max(1, int(limit))
    by_tier: dict[int, list[tuple]] = {}
    for candidate in candidates:
        by_tier.setdefault(candidate[-1], []).append(candidate)
    selected: list[tuple] = []
    for tier in sorted(by_tier):
        group = by_tier[tier]
        if not selected:
            selected.extend(group)
            if not fill_weaker:
                break
            continue
        missing = limit - len(selected)
        if missing <= 0:
            break
        if fill_order is not None:
            group = sorted(group, key=fill_order)
        selected.extend(group[: missing * TIER_FILL_POOL_FACTOR])
    return selected
