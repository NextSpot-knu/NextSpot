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
# **일요일마다** '매주 월요일' 가게를 전부 닫힌 곳으로 봤다(2026-10-31 재현). 이제 요일 글자는 이렇게 읽는다:
#   · 바로 뒤에 '요일' 이 붙으면 앞에 무엇이 붙어 있어도 요일이다(매주월요일 · 휴무월요일).
#   · 앞이 숫자면 요일이 아니다(1월 · 15일 — 날짜).
#   · 앞이 한글이면 그 한글이 휴무를 말하는 말(매주·격주·휴무·휴관…)일 때만 요일이다(매주화,수 · 매주월,화요일).
#     '당일'·'공휴일'·'매월'·'1주일' 의 '일'·'월' 은 요일이 아니다.
#   · 다만 한글 뒤에 붙은 '일' 은 바로 뒤가 '요일' 이 아니면 앞말이 무엇이어도 요일이 아니다 — '휴관일 : 매주 월요일'
#     ·'휴무일 없음' 의 '일' 은 '날' 이고(TourAPI 에 가장 흔한 표기), '매주일' 은 '매주' 다.
#   · '요일' 없는 낱글자는 뒤도 한글·숫자에 붙지 않아야 한다('월 2회' 의 '월' = 달).
#   · 구분 기호 없이 붙여 쓴 묶음('토일 휴무' · '금토일' · '토일요일')은 요일 순서대로 이어지고, 앞뒤가 한글이 아니거나
#     휴무를 말하는 말일 때만 목록이다 — '화목한'·'수목원'·'생년월일'·'금일(오늘)' 은 아니다. 주말에 닫는 가게를 주말에
#     추천하지 않게 하려는 것이다(못 읽으면 영업으로 떨어진다).
#
# 입력은 먼저 NFKC 로 맞춘다(전각 숫자·물결·괄호 → 반각) — 파이썬과 JS 의 '\d'·'\s' 가 보는 글자가 달라 같은
# 원문에 두 쪽이 다른 답을 내지 않게. 그리고 앞 300자만 읽는다 — 실제 휴무 문구는 100자 안팎이고, 비정상적으로
# 긴 입력이 정규식 되돌아보기로 이벤트 루프를 붙잡지 않게 하는 상한이다.
#
# 웹 lib/restDate.ts 의 closedDayStatus 와 **같은 규칙·같은 식**이다. 웹은 iOS 16.4 미만 Safari 가 읽지 못하는
# 정규식 '뒤쪽 보기' 를 쓸 수 없어서 앞 글자 검사를 정규식 밖에서 하고, 여기서도 똑같이 한다. 두 테스트가 같은
# 사례 파일(tests/fixtures/opening_hours_parity.json)을 읽으므로 한쪽만 고치면 그 쪽 테스트가 깨진다.
#
# 매월 n번째 요일('매월 둘째·넷째 일요일' · '1st and 3rd Sundays')은 그 날짜가 이 달의 몇 번째 그 요일인지
# (1~7일 = 첫째) 계산해 그날만 닫는다 — 모든 일요일을 닫지 않는다. 서수를 읽지 못한 매월·격주 규칙('매월 1회
# 월요일'·'격주 월요일'·'every other Monday')은 그 요일을 '모름(uncertain)' 으로 둔다: 닫혔다고도(후보에서
# 빠짐), 열었다고도(영업 확인) 하지 않고 영업 확인 필요로 내린다. 공휴일에 따른 대체 휴무('월요일이 공휴일이면
# 화요일')는 매주 규칙이 아니라 버린다 — 공휴일 달력이 없어 그날을 가려낼 수 없고, 매주 화요일을 닫는 것보다
# 그 하루를 놓치는 편이 덜 틀린다.

_WEEKDAY_CHARS = "월화수목금토일"  # 인덱스 = datetime.weekday() (월=0 … 일=6)
_DAY = "[월화수목금토일]"
_DAY_LIST = rf"{_DAY}(?:\s*[·,/、~\-–]\s*{_DAY})*"
# 구분 기호 없이 붙여 쓴 요일 묶음('토일 휴무' · '금토일' · '월화요일'). 요일 순서대로(월<화<…<일) 이어질 때만
# 요일 목록이다 — '화목한'·'수목원'·'일월' 은 낱말이고, '금일' 은 '오늘' 이라 묶음으로 읽지 않는다(_compact_days_ok).
_COMPACT_RUN = r"[월화수목금토일]{2,}"
_DAY_RUN_RE = re.compile(rf"({_COMPACT_RUN}|{_DAY_LIST})(\s*요일)?")
# 요일 글자에 붙여 써도 요일로 읽는 앞말(두 글자) — '매주화,수'·'휴무월,화요일'.
_GLUE_BEFORE_DAY_RE = re.compile(r"(?:매주|격주|격월|매월|매달|휴무|휴관|휴업|휴점)$")
# 붙여 쓴 묶음의 앞뒤: 앞이 한글이면 휴무 앞말('매주토일'·'휴무일토일'), 뒤가 한글이면 휴무·공휴일·이음말·조사
# ('토일공휴일 휴무'·'토일은 휴무')일 때만 요일 묶음이다.
_COMPACT_LEFT_GLUE_RE = re.compile(r"(?:매주|매월|매달|격주|격월|휴무|휴관|휴업|휴점|휴무일|휴관일)$")
_COMPACT_RIGHT_RE = re.compile(r"휴무|휴관|휴업|휴점|휴일|정기|공휴일|법정|및|과|와|은|는|에|엔")
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
_EN_DAY_RE = re.compile(rf"(^|[^a-z])({_EN_DAY_NAMES})s?(?![a-z])")
_EN_WEEKEND_RE = re.compile(r"(^|[^a-z])weekends?(?![a-z])")
_EN_OPEN_RE = re.compile(r"(?:^|[^a-z])open(?![a-z])")
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

# 공휴일 대체 휴무 조건 — 공휴일 낱말과 조건 낱말이 **함께** 있는 괄호·절만 조건으로 본다.
# '정기휴일 매주 월요일' 의 '휴일' 은 공휴일이 아니다(앞이 한글이면 bare '휴일' 로 치지 않는다).
_HOLIDAY_WORD = r"(?:법정\s*)?(?:공휴일|국경일|명절|연휴|대체\s*휴일)|(?:^|[^가-힣])휴일|(?:^|[^a-z])holidays?(?![a-z])"
_HOLIDAY_RE = re.compile(_HOLIDAY_WORD)
_CONDITION_RE = re.compile(
    r"경우|이면|이라면|일\s*때|인\s*때|겹치|겹칠|다음\s*날|익일|이튿날"
    r"|(?:^|[^a-z])(?:if|when|following|next\s+day)(?![a-z])"
)
# 조건절이 시작되는 자리 — '월요일이 공휴일…' 의 주어, 또는 공휴일 낱말. 여기서 절 끝까지 버린다.
_CONDITION_START_RE = re.compile(rf"{_DAY}\s*요일\s*(?:이|가|은|는)\s*(?:{_HOLIDAY_WORD})|{_HOLIDAY_WORD}")

# 서수 안의 선택 조각은 모두 '공백 + 반드시 있는 글자'(번·째·주) 꼴이다 — 공백만 홀로 선택되는 자리가 없어야
# 정규식이 공백을 나누는 방법을 곱으로 늘리지 않는다(예전 꼴은 '1 1 1 … x' 12개에 4.5초가 걸렸다).
# '주' 는 뒤에 '일' 이 오면 서수의 일부로 읽지 않는다('1주일' = 일주일) — 그 '일' 이 '일요일' 일 때만 예외다
# ('첫째주일요일' = 첫째 주 일요일).
_ORDINAL = (
    r"(?:첫(?:\s*번)?(?:\s*째)?|둘\s*째|두\s*번\s*째|셋\s*째|세\s*번\s*째|넷\s*째|네\s*번\s*째"
    r"|다섯(?:\s*번)?\s*째|마지막|[1-5](?:\s*번)?(?:\s*째)?)(?:\s*(?:주차|주(?!일(?!요일))))?"
)
# 서수 사이 이음 — 구두점 / 및·과·와 / 공백, 서로 겹치지 않는 세 갈래.
_ORDINAL_SEP = r"(?:\s*[·,/、&]\s*|\s*(?:및|과|와)\s*|\s+)"
# 앞이 숫자인 서수('12월' 의 '2')는 정규식 밖에서 거른다(웹과 같은 식).
_MONTHLY_RE = re.compile(
    rf"(?:(?:매월|매달)\s*)?({_ORDINAL}(?:{_ORDINAL_SEP}{_ORDINAL})*)"
    rf"\s*(?:의\s*)?({_COMPACT_RUN}|{_DAY_LIST})(\s*요일)?"
)
# 숫자만 있는 서수('1월'·'15일')는 날짜일 수 있어 서수로 보지 않는다 — '째'·'주'·'번' 이나 낱말 서수가 있어야 한다.
_ORDINAL_MARK_RE = re.compile(r"[째주번]|첫|둘|셋|넷|다섯|마지막")
_ORDINAL_TOKEN_RE = re.compile(r"첫|둘|두|셋|세|넷|네|다섯|마지막|[1-5]")
_ORDINAL_VALUE = {
    "첫": 1, "1": 1, "둘": 2, "두": 2, "2": 2, "셋": 3, "세": 3, "3": 3,
    "넷": 4, "네": 4, "4": 4, "다섯": 5, "5": 5,
}
_KO_UNCERTAIN_MARKER_RE = re.compile(r"격주|격월|매월|매달")
_EN_UNCERTAIN_RE = re.compile(r"(^|[^a-z])(?:every\s+other|alternate|alternating|bi-?weekly)(?![a-z])")
# 요일 뒤에 붙으면 휴무 요일이 아닌 것: 영업시간(화~일 11:00), 영업 요일(일요일 영업 — '영업 안 함' 은 제외).
# 숫자는 '[0-9]' 로 적는다 — 파이썬 '\d' 는 다른 문자권 숫자도 받지만 JS 는 아니다(웹과 같은 답을 내려고).
_TIME_AFTER_RE = re.compile(r"\s*(?::\s*)?[0-9]{1,2}\s*(?::|시)")
_OPEN_AFTER_RE = re.compile(
    r"(?:\s*(?:에는|엔|에|은|는))?\s*(?:영업|운영|개방|오픈|정상|open)(?!\s*(?:안|않|하지\s*않|중지|중단|x(?![a-z])))"
)
_PARTIAL_DAY_AFTER_RE = re.compile(r"\s*(?:오전|오후|점심|저녁|야간)")
_DIGIT_AFTER_RE = re.compile(r"\s*[0-9]")
_HANGUL_OR_DIGIT_RE = re.compile(r"[가-힣0-9]")
# 조건절은 조건 낱말 뒤 첫 이음말까지만 — '공휴일 다음날 휴무 및 매주 월요일 휴무' 의 뒤 절은 매주 규칙이다.
_CLAUSE_JOIN_RE = re.compile(r"및|과|와|/")
_MAX_CLOSED_TEXT = 300


@dataclass(frozen=True)
class _ClosedDayRules:
    open_all_year: bool = False
    weekly: frozenset[int] = frozenset()
    # (서수 집합, 마지막 주 여부, 요일 집합)
    monthly: tuple[tuple[frozenset[int], bool, frozenset[int]], ...] = ()
    uncertain: frozenset[int] = frozenset()

    @property
    def has_rules(self) -> bool:
        return bool(self.weekly or self.monthly or self.uncertain)


def _expand_day_list(text: str) -> set[int]:
    """'월·화' → {0, 1}, '월~수' → {0, 1, 2}(범위는 요일 순서로, '금~월' 처럼 주를 넘겨도 된다)."""
    days: set[int] = set()
    previous: int | None = None
    pending_range = False
    for token in re.findall(r"[월화수목금토일]|[~\-–]", text):
        if token in "~-–":
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
    def paren(match: re.Match) -> str:
        inner = match.group(1)
        if _HOLIDAY_RE.search(inner) and _CONDITION_RE.search(inner):
            return " "
        return f" {inner} "

    text = re.sub(r"\(([^()]*)\)", paren, text)
    return "".join(_drop_condition_clause(piece) for piece in re.split(r"([,\n;])", text))


def _drop_condition_clause(piece: str) -> str:
    """절 안의 조건절만 지운다 — 시작(공휴일·'월요일이 공휴일…')부터 조건 낱말 뒤 첫 이음말(및·과·와·/) 앞까지.

    이음말 뒤는 계속 읽는다: '공휴일 다음날 휴무 및 매주 월요일 휴무' 에서 앞 절만 버리고 월요일 규칙은 남는다.
    이음말이 없으면 종전처럼 절 끝까지 버린다('매주 월요일 휴무이며 공휴일인 경우 다음날 휴무').
    """
    kept = ""
    while _HOLIDAY_RE.search(piece) and _CONDITION_RE.search(piece):
        start = _CONDITION_START_RE.search(piece)
        if start is None:
            return kept
        condition = _CONDITION_RE.search(piece, start.start())
        join = _CLAUSE_JOIN_RE.search(piece, condition.end()) if condition else None
        if join is None:
            return kept + piece[:start.start()]
        kept += piece[:start.start()] + " "
        piece = piece[join.start():]
    return kept + piece


def _bare_day_end_ok(text: str, end: int) -> bool:
    """'요일' 이 붙지 않은 낱글자는 뒤가 한글·숫자면 요일이 아니다('월 2회' 의 '월' = 달)."""
    following = text[end:end + 1]
    if following and _HANGUL_OR_DIGIT_RE.match(following):
        return False
    return not _DIGIT_AFTER_RE.match(text, end)


def _is_compact_run(days_text: str) -> bool:
    return len(days_text) >= 2 and all(char in _WEEKDAY_CHARS for char in days_text)


def _compact_days_ok(days_text: str) -> bool:
    """붙여 쓴 묶음은 요일 순서대로(월<화<…<일)일 때만 목록이다. '금일' 은 '오늘'(금일 휴무)이라 읽지 않는다."""
    if days_text == "금일":
        return False
    indexes = [_WEEKDAY_CHARS.index(char) for char in days_text]
    return all(later > earlier for earlier, later in zip(indexes, indexes[1:]))


def _compact_right_ok(text: str, end: int) -> bool:
    """붙여 쓴 묶음 바로 뒤가 한글이면 휴무·공휴일·이음말·조사여야 한다('토일휴무' 는 되고 '화목한' 은 아니다)."""
    following = text[end:end + 1]
    return not (following and _HANGUL_RE.match(following)) or bool(_COMPACT_RIGHT_RE.match(text, end))


def _accept_compact_run(text: str, match: re.Match) -> bool:
    start = match.start()
    previous = text[start - 1] if start else ""
    if not _compact_days_ok(match.group(1)):
        return False
    if previous and previous in _DIGITS:
        return False
    if previous and _HANGUL_RE.match(previous) and not _COMPACT_LEFT_GLUE_RE.search(text[max(0, start - 3):start]):
        return False
    return bool(match.group(2)) or _compact_right_ok(text, match.end())


def _accept_day_run(text: str, match: re.Match) -> bool:
    """요일 글자 묶음이 정말 요일인지 — 앞 글자 규칙은 이 절 머리 주석 참조."""
    if _is_compact_run(match.group(1)):
        return _accept_compact_run(text, match)
    start = match.start()
    previous = text[start - 1] if start else ""
    if previous and previous in _DIGITS:
        return False
    if previous and _HANGUL_RE.match(previous):
        attached = text.startswith("요일", start + 1)
        # 한글 뒤에 붙은 '일' 은 '요일' 이 붙지 않으면 '날' 이다(휴관일·휴무일·매주일) — 앞말과 상관없이 거른다.
        if not attached and (text[start] == "일" or not _GLUE_BEFORE_DAY_RE.search(text[max(0, start - 2):start])):
            return False
    return bool(match.group(2)) or _bare_day_end_ok(text, match.end())


def _day_runs(text: str, pos: int = 0, latest_start: int | None = None) -> list[re.Match]:
    """요일 묶음을 앞에서부터. 요일이 아닌 자리('당일, 월요일' 의 '일')면 한 글자 뒤에서 다시 찾는다 —
    그래야 같은 묶음 안의 진짜 요일('월요일')을 놓치지 않는다."""
    runs: list[re.Match] = []
    while True:
        match = _DAY_RUN_RE.search(text, pos)
        if match is None or (latest_start is not None and match.start() > latest_start):
            return runs
        if _accept_day_run(text, match):
            runs.append(match)
            pos = match.end()
        else:
            pos = match.start() + 1


@lru_cache(maxsize=4096)
def _parse_closed_days(raw: str) -> _ClosedDayRules | None:
    text = unicodedata.normalize("NFKC", raw)[:_MAX_CLOSED_TEXT]
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = text.translate(str.maketrans("（）［］【】〔〕[]", "()()()()()")).lower()
    if not text.strip():
        return None
    if _OPEN_ALL_YEAR_RE.search(text):
        return _ClosedDayRules(open_all_year=True)

    text = _drop_holiday_conditions(text)
    weekly: set[int] = set()
    uncertain: set[int] = set()
    monthly: list[tuple[frozenset[int], bool, frozenset[int]]] = []

    # 1) 매월 n번째 요일(한국어). 거른 자리에서는 한 글자 뒤부터 다시 찾는다('12월 둘째 일요일').
    pos = 0
    while (match := _MONTHLY_RE.search(text, pos)) is not None:
        start, group, days_text = match.start(), match.group(1), match.group(2)
        prefixed = match.group(0).startswith(("매월", "매달"))
        compact = _is_compact_run(days_text)
        if (
            (not prefixed and start and text[start - 1] in _DIGITS)
            or not _ORDINAL_MARK_RE.search(group)
            or (compact and not _compact_days_ok(days_text))
            or not (
                match.group(3)
                or (_compact_right_ok(text, match.end()) if compact else _bare_day_end_ok(text, match.end()))
            )
        ):
            pos = start + 1
            continue
        ordinals = {_ORDINAL_VALUE[token] for token in _ORDINAL_TOKEN_RE.findall(group) if token != "마지막"}
        monthly.append((frozenset(ordinals), "마지막" in group, frozenset(_expand_day_list(match.group(2)))))
        text = _blank(text, start, match.end())
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

    # 3) 서수 없는 매월·격주 — 그 요일은 모름. 표시(격주·매월) 뒤 12글자 안에서 시작하는 요일 묶음.
    for marker in list(_KO_UNCERTAIN_MARKER_RE.finditer(text)):
        if text[marker.start():marker.end()] != marker.group(0):
            continue  # 앞 단계가 이미 읽어 지운 자리
        runs = _day_runs(text, marker.end(), marker.end() + 12)
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

    def add_days(days: set[int], end: int) -> None:
        rest = text[end:]
        if _TIME_AFTER_RE.match(rest) or _OPEN_AFTER_RE.match(rest):
            return
        if _PARTIAL_DAY_AFTER_RE.match(rest):
            uncertain.update(days)  # '토요일 오후 휴무' — 하루 전체가 닫힌 것은 아니다.
            return
        weekly.update(days)

    # 4) 매주 요일
    for match in _day_runs(text):
        add_days(_expand_day_list(match.group(1)), match.end())
    for match in _KO_WEEKEND_RE.finditer(text):
        add_days({5, 6}, match.end())
    for match in _EN_DAY_RE.finditer(text):
        word_start = match.start() + len(match.group(1))
        if _EN_OPEN_RE.search(re.split(r"[,;\n]", text[:word_start])[-1]):
            continue  # 'Open Mon-Sat, closed Sundays' 의 영업 요일
        add_days({_EN_DAY_INDEX[match.group(2)]}, match.end())
    for match in _EN_WEEKEND_RE.finditer(text):
        add_days({5, 6}, match.end())

    return _ClosedDayRules(
        weekly=frozenset(weekly), monthly=tuple(monthly), uncertain=frozenset(uncertain - weekly),
    )


def closed_day_status(raw: object, at: datetime) -> Literal["closed", "uncertain", "open"] | None:
    """휴무일 원문이 ``at``(한국 날짜) 에 대해 말하는 것.

    closed = 그날 휴무, uncertain = 그 요일을 말하지만 그날인지 알 수 없음(격주·서수 없는 매월),
    open = 휴무 규칙을 읽었고 그날은 해당하지 않음(연중무휴 포함), None = 읽을 수 있는 규칙이 없음.
    """
    rules = _parse_closed_days(str(raw or ""))
    if rules is None:
        return None
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
# 시각 범위('09:00~18:00')를 영업 구간으로 읽는다. 쉬는 시간은 닫힌 구간이다 — '11:00~21:00 (15:00~17:00)'
# 처럼 영업 구간 안쪽의 괄호 범위, 또는 '브레이크타임 15:00~17:00' 처럼 쉬는 시간 말이 붙은 범위. 괄호
# 범위라도 다른 말이 붙었거나('동절기 09:00~21:00') 영업 구간 안에 들어가지 않으면 종전처럼 영업 구간이다.
# 닫는 시각 '24:00' 은 자정까지다. 입장 마감('입장 마감 17:00' · '마지막 입장' · 'last entry' · 라스트오더)은
# 그 구간의 실제 닫는 시각이다 — 입장이 끝난 뒤 도착하면 들어갈 수 없다(같은 줄의 가장 가까운 앞 구간에 건다).
# 웹 lib/restDate.ts 의 getArrivalOpenStatus 와 같은 규칙이다(같은 사례 파일).

# 하루 종일 열려 있는 곳 — '상시 개방'·'24시간'·'연중 개방'(경주 계림·월성 같은 야외 유적). 문자열 **전체**가
# 이 말일 때만 인정한다 — '시설별로 상이함' 같은 문장은 그대로 미확인. 웹이 2026-10-06 먼저 넣었고(ALWAYS_OPEN),
# 서버는 순위가 바뀌는 변경이라 공모전 뒤로 미뤘던 것을 같은 식으로 맞춘다.
_ALWAYS_OPEN_RE = re.compile(r"상시\s*(?:개방|운영)?|24\s*시간(?:\s*(?:개방|운영|영업))?|연중\s*(?:무휴\s*)?개방")
_CLOCK = r"(?:[01]?[0-9]|2[0-3]):[0-5][0-9]"
_TIME_RANGE_RE = re.compile(rf"({_CLOCK})\s*(?:~|-|–|—)\s*({_CLOCK}|24:00)")
_BREAK_WORD_RE = re.compile(r"브레이크|break|휴게|쉬는\s*시간|준비\s*시간|휴식", re.IGNORECASE)
# 선택 조각은 '공백 + 반드시 있는 글자' 꼴로만 둔다(공백만 홀로 선택되면 되돌아보기가 곱으로 는다 — 휴무일 절 참조).
_BREAK_NEGATED_RE = re.compile(
    r"(?:\s*(?:타임|time|시간))?(?:\s*:)?\s*(?:없|무(?![가-힣])|x(?![a-z])|none)", re.IGNORECASE
)
_NO_BEFORE_RE = re.compile(r"(?:^|[^a-z])no\s*$", re.IGNORECASE)
# 입장 마감 — 말 다음 시각('입장 마감 17:00' · 'L.O 20:30'), 또는 시각 다음 말('17:00까지 입장').
_LAST_ENTRY_LABEL = (
    r"입장\s*마감|마지막\s*입장|최종\s*입장|매표\s*마감|발권\s*마감|라스트\s*오더"
    r"|last\s*(?:entry|admission|order)|l\.\s*o\.?"
)
_LAST_ENTRY_RE = re.compile(
    rf"(?:{_LAST_ENTRY_LABEL})(?:\s*(?:시간|시각))?(?:\s*(?:은|는))?(?:\s*:)?\s*(?:~\s*)?({_CLOCK})", re.IGNORECASE
)
_ENTRY_UNTIL_RE = re.compile(rf"({_CLOCK})\s*(?:까지\s*입장|입장\s*마감)")
_DAY_MINUTES = 24 * 60
# 영업시간 원문은 철·문·요일마다 줄이 늘어 휴무 문구보다 길다(실적재 수십~200자대) — 넉넉히 500자까지만 읽는다.
_MAX_HOURS_TEXT = 500


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


@lru_cache(maxsize=4096)
def _parse_opening_hours(raw: str) -> tuple[bool, tuple[tuple[int, int], ...], tuple[tuple[int, int], ...]]:
    """(하루 종일 영업, 영업 구간들, 쉬는 시간 구간들) — 구간은 0시부터의 분(닫는 쪽 24:00 = 1440)."""
    raw = unicodedata.normalize("NFKC", raw)[:_MAX_HOURS_TEXT]  # 전각 '０９:００～' → 반각(웹과 같은 입력)
    if _ALWAYS_OPEN_RE.fullmatch(re.sub(r"<br\s*/?>", " ", raw, flags=re.IGNORECASE).strip()):
        return True, (), ()
    text = re.sub(r"<br\s*/?>", "\n", raw, flags=re.IGNORECASE)
    parens = [(match.start(), match.end(), match.group(1)) for match in re.finditer(r"\(([^()]*)\)", text)]
    matches = list(_TIME_RANGE_RE.finditer(text))
    # 영업·괄호 범위는 글 위치를 함께 둔다 — 입장 마감을 같은 줄의 구간에 걸 때 쓴다(_apply_last_entry).
    opens: list[tuple[int, int, tuple[int, int]]] = []
    breaks: list[tuple[int, int]] = []
    bare: list[tuple[int, int, tuple[int, int]]] = []
    for index, match in enumerate(matches):
        interval = (_clock_minutes(match.group(1)), _clock_minutes(match.group(2)))
        located = (match.start(), match.end(), interval)
        inner = next((body for start, end, body in parens if start < match.start() and match.end() < end), None)
        if inner is not None:
            if _has_break_word(inner):
                breaks.append(interval)
            elif inner.strip() == match.group(0).strip():
                bare.append(located)  # '(15:00~17:00)' — 영업 구간 안쪽이면 쉬는 시간(아래)
            else:
                opens.append(located)
            continue
        # 괄호 밖: 같은 절(줄·쉼표)에서 범위 바로 앞의 말, 또는 절 끝까지 다른 범위가 없을 때 뒤의 말을 본다
        # ('11:00~21:00 브레이크타임 15:00~17:00' 의 '브레이크타임' 은 뒤 범위의 말이다).
        clause_start = max(text.rfind(delimiter, 0, match.start()) for delimiter in "\n,;") + 1
        previous_end = matches[index - 1].end() if index else 0
        before = text[max(clause_start, previous_end):match.start()]
        clause_end = min(
            (pos for pos in (text.find(delimiter, match.end()) for delimiter in "\n,;") if pos != -1),
            default=len(text),
        )
        next_start = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        after = text[match.end():clause_end] if next_start >= clause_end else ""
        if _has_break_word(before) or _has_break_word(after):
            breaks.append(interval)
        else:
            opens.append(located)
    for located in bare:
        if any(_strictly_inside(located[2], outer) for _, _, outer in opens):
            breaks.append(located[2])
        else:
            opens.append(located)
    opens = _apply_last_entry(text, opens)
    return False, tuple(interval for _, _, interval in opens), tuple(breaks)


def _status_from_intervals(
    opens: tuple[tuple[int, int], ...], breaks: tuple[tuple[int, int], ...], minute: int
) -> str:
    containing = [interval for interval in opens if _interval_contains(interval, minute)]
    if not containing or any(_interval_contains(interval, minute) for interval in breaks):
        return "closed_confirmed"
    # 겹치는 구간이 여럿이면 가장 늦게 닫는 구간을 쓴다('11:00~15:00, 09:00~22:00' 의 14:45 는 영업 중이다).
    remaining = (
        None if any(_is_full_day(interval) for interval in containing)
        else max(_minutes_until_close(interval, minute) for interval in containing)
    )
    for start, _end in breaks:
        until_break = (start - minute) % _DAY_MINUTES
        if until_break and (remaining is None or until_break < remaining):
            remaining = until_break  # 곧 쉬는 시간 — 닫는 것과 같다
    return "closing_soon" if remaining is not None and remaining <= 30 else "open_expected"


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
    always_open, opens, breaks = _parse_opening_hours(raw)
    if always_open:
        return "open_expected"
    if not opens:
        return "needs_confirmation"
    return _status_from_intervals(opens, breaks, local.hour * 60 + local.minute)


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
