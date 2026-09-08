# Deterministic browser coverage

Playwright runs Chromium at 390×844. Tests freeze browser locale/state, intercept API calls,
and stub Kakao external navigation so CI never depends on a real account, GPS, map SDK, or
third-party network. Ranking/SOLAR/filter invariants are exercised by the API golden fixture;
these browser tests cover the mobile integration boundary and four-locale overflow contract.

`course-replan.spec.ts` covers the multi-stop course screen (`/course`), whose controls are all
re-requests: it asserts the **request body** (`sequence`, `pins`) alongside the rendered stops,
because the screen alone cannot tell "the server picked that order" from "we asked for it".
Stub responses must be snake_case (`apiClient` camel-cases responses) and must include a
`slot_outcomes` entry for every filled slot — with an empty list the page treats the answer as a
legacy `/recommend` response and draws no pin/alternative controls at all.
