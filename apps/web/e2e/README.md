# Deterministic browser coverage

Playwright runs Chromium at 390×844. Tests freeze browser locale/state, intercept API calls,
and stub Kakao external navigation so CI never depends on a real account, GPS, map SDK, or
third-party network. Ranking/SOLAR/filter invariants are exercised by the API golden fixture;
these browser tests cover the mobile integration boundary and four-locale overflow contract.
