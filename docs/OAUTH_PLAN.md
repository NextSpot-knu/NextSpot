# OAuth 도입 구현 계획 — 게스트(익명) → 소셜 계정 연동

> 작성 2026-07-15. 실행 전 검토용 계획 문서.
> 관련 정본: 인증 현황은 `apps/web/components/SessionBootstrap.tsx` 주석, 보안 결정은 `docs/IMPROVEMENT_PLAN.md` D3.

---

## 0. 한 줄 정의

**무마찰 익명 세션은 그대로 유지**하고, 그 위에 **카카오·구글 OAuth 로그인/연동**을 선택 단계로 얹어
기기 간 사용자 식별·데이터 이관이 가능한 "진짜 계정"으로 승격할 수 있게 한다.

---

## 1. 현재 상태 (AS-IS)

| 항목 | 현재 | 근거 파일 |
|---|---|---|
| 진입 플로우 | 랜딩 → `/setup`(취향 입력) → `/main`. 로그인 UI 없음 | `apps/web/app/page.tsx` |
| 세션 | 마운트 시 `signInAnonymously()` 1회 — **per-device 익명 세션**(localStorage 지속) | `components/SessionBootstrap.tsx` |
| 폴백 | 익명 로그인 실패 시 목업 방문자 ID(`GYEONGJU-VISITOR-01`) | `lib/api-client.ts:209` |
| 사용자 프로비저닝 | `auth.users` INSERT → `public.users` 자동 생성 트리거 | `supabase/migrations/20260710160000_handle_new_user.sql` |
| 백엔드 인증 | Supabase JWT 검증(JWKS ES256/RS256 + HS256 폴백), `sub` = user_id | `apps/api/app/core/supabase.py` |
| OAuth 준비도 | `detectSessionInUrl: false` — **OAuth 리다이렉트 명시적 미사용** | `lib/supabase.ts:42` |
| 빌드 제약 | `output: 'export'` 정적 export — **서버 라우트/서버 액션 불가** | `apps/web/next.config.ts:4` |
| 로그아웃 | mypage에 `signOut()` 이미 존재 | `app/mypage/page.tsx:157` |

**문제**: 익명 세션은 단말에 묶인다. 기기 변경·localStorage 소실 시 취향/쿠폰/저장/제보 이력이 유실되고,
사용자 구분이 "브라우저 1개 = 사용자 1명" 수준이라 상용 시나리오(재방문 관광객, 다기기)에서 한계.

---

## 2. 설계 결정 (제안)

### D-A. 익명 우선(frictionless-first)은 유지한다
- 랜딩·온보딩 플로우는 **로그인 강제 없이 지금과 동일**하게 시작한다(공모전 데모 UX 훼손 금지).
- OAuth는 **선택적 승격**: ① 온보딩 완료 직후 1회 제안, ② mypage에서 상시 가능.

### D-B. 승격은 Supabase 네이티브 `linkIdentity()` 를 쓴다
- 익명 사용자가 카카오/구글 identity를 **같은 `auth.users` 행에 연결** → `user_id`(UUID) 불변.
- 따라서 `users`·`user_coupons`·`recommendations`·`user_feedback`·`user_preference_vectors` 등
  **모든 기존 데이터가 마이그레이션 없이 그대로 승계**된다. (별도 데이터 이관 코드 0줄.)
- Supabase 대시보드에서 **"Enable manual linking"** 토글 필요(§6 수동 단계).

### D-C. 프로바이더는 카카오(주) + 구글(부) 2종
- 카카오: 국내 관광객 주류. 이미 Kakao Developers 앱 보유(지도 SDK) — 같은 앱에 Kakao Login 활성화.
- 구글: 외국인 관광객(앱은 ko/en/ja/zh 다국어 지원) 커버.
- Apple/네이버는 이번 스코프 제외(비목표 §7).

### D-D. 정적 export 제약 → PKCE + 클라이언트 콜백 페이지
- 서버 라우트가 없으므로 **supabase-js PKCE 플로우**(기본값)를 그대로 사용.
- `lib/supabase.ts` 의 `detectSessionInUrl: false → true` 로 변경하고,
  전용 콜백 페이지 `app/auth/callback/page.tsx`(클라이언트 컴포넌트)에서 세션 확립 확인 후
  원래 위치로 복귀시킨다(`redirectTo` 에 복귀 경로를 쿼리로 실어 보냄).
- ⚠️ `detectSessionInUrl: true` 전역화의 부작용 검토: 관리자 앱은 Supabase 세션을 안 쓰므로 영향 없음.

### D-E. "다른 기기에서 로그인"은 계정 전환으로 처리 (병합은 비목표)
- 기기 B의 익명 세션 상태에서 기존 계정으로 `signInWithOAuth()` 하면 익명 세션은 버려지고
  기존 계정 세션으로 교체된다. **기기 B 익명 사용자의 데이터는 병합하지 않는다**(고아로 남음 — 무해).
- 오래된 익명 사용자 정리는 운영 배치(비목표, §7에 후속 과제로 기록)로 미룬다.

### D-F. 백엔드(FastAPI)는 무변경이 원칙
- JWT의 `sub` 가 그대로 user_id 이므로 검증 로직 변경 불필요.
- (선택) `is_anonymous` 클레임을 읽어 "계정 사용자 전용" 엔드포인트 게이팅이 필요해지면 후속으로.

---

## 3. 사용자 플로우 (TO-BE)

```
[첫 방문]
랜딩 → (익명 세션 자동 생성) → /setup 취향 입력 → 완료 화면에
  "카카오로 계정 만들기(선택) / 나중에" 제안 ──┐
                                              ├─ linkIdentity('kakao'|'google')
[재방문·기존 게스트]                           │   → Supabase OAuth 리다이렉트
mypage → "소셜 계정 연동" 버튼 ────────────────┘   → /auth/callback → 복귀
                                                  (user_id 불변, 데이터 승계)

[다른 기기·재설치]
mypage → "이미 계정이 있어요 → 카카오/구글 로그인"
  → signInWithOAuth() → 기존 계정 세션으로 교체(익명 세션 폐기)
```

UI 노출 위치는 2곳뿐: **setup 완료 스텝**(1회 제안) + **mypage 계정 섹션**(연동/로그인/로그아웃 상태별 표시).
랜딩 페이지는 변경하지 않는다.

---

## 4. 작업 목록 (파일 단위)

### 4-1. 프론트 (apps/web)

| # | 작업 | 파일 | 비고 |
|---|---|---|---|
| F1 | `detectSessionInUrl: true` + 주석 갱신 | `lib/supabase.ts` | PKCE 코드 교환 자동화 |
| F2 | OAuth 유틸 신설: `linkOAuth(provider)`, `signInOAuth(provider)`, `getAuthState()`(익명/연동/비로그인 판별 — `session.user.is_anonymous`, `user.identities` 검사) | `lib/auth.ts` (신규) | redirectTo = `${origin}/auth/callback?next=<복귀경로>` |
| F3 | 콜백 페이지: 세션 확립 대기 → `next` 로 replace. 실패 시 에러 안내 + 홈 복귀 | `app/auth/callback/page.tsx` (신규) | 클라이언트 컴포넌트, 정적 export 호환 |
| F4 | setup 완료 스텝에 "계정 만들기(선택)" 카드 — linkIdentity 호출, "나중에" 스킵 | `app/setup/page.tsx` | 스킵해도 기존 플로우 동일 |
| F5 | mypage 계정 섹션: 상태별 렌더 — (게스트) 연동 유도 배너 + 카카오/구글 버튼 + "기존 계정 로그인" / (연동됨) 프로바이더 뱃지 + 로그아웃 | `app/mypage/page.tsx` | 기존 signOut 재사용. 로그아웃 후 SessionBootstrap 이 새 익명 세션을 만들어 게스트 모드로 자연 복귀 |
| F6 | i18n 키 추가(ko/en/ja/zh): 연동 유도 문구·버튼·에러 | `lib/i18n/*` | 기존 461키 체계 준수 |
| F7 | (정리) `api-client.ts` 목업 사용자 폴백 경고 문구에 "로그인하면 유지됩니다" 안내는 **하지 않음** — 폴백은 익명 로그인 실패 시에만 도달하므로 현행 유지 | `lib/api-client.ts` | 무변경 확인만 |

### 4-2. DB (supabase/migrations — D2 규칙: migrations 추가 후 `node scripts/build_reset.mjs`)

| # | 작업 | 내용 |
|---|---|---|
| M1 | `20260716XXXXXX_oauth_profile_fields.sql` | `users.avatar_url TEXT` 추가(nullable). `handle_new_user()` 를 CREATE OR REPLACE 로 갱신 — OAuth 가입 시 `NEW.raw_user_meta_data` 에서 `name`→`nickname`, `avatar_url`→`avatar_url` 을 복사(없으면 NULL, 익명 가입은 현행과 동일). ⚠️ linkIdentity 승격은 INSERT 가 아니라 UPDATE 라 트리거를 안 탄다 → 승격 직후 프론트(F2)가 `users` 를 1회 UPDATE 로 백필한다. |

### 4-3. 백엔드 (apps/api)

| # | 작업 | 내용 |
|---|---|---|
| B1 | 무변경(원칙 확인) | JWT 검증·`fetch_user` 는 user_id 기준이라 그대로 동작. pytest 회귀만 확인 |

### 4-4. 문서

| # | 작업 | 내용 |
|---|---|---|
| C1 | `DEPLOY_AND_ENV.md` §1 뒤에 "OAuth 설정" 절 추가 | §6 수동 단계를 팀 공유용으로 |
| C2 | `HANDOVER.md` 사람이 해야 하는 것에 §6 항목 추가 | 대시보드/콘솔 작업은 사람만 가능 |

---

## 5. 구현 순서 & 검증

```
M1 (트리거·컬럼)          — 선행 (없어도 승격은 되지만 프로필 백필 대상 컬럼 필요)
  → F1·F2·F3 (인프라)     — 콜백까지 왕복 확인이 최우선 리스크 해소
  → F5 (mypage)           — 연동/로그인/로그아웃 3상태 수동 테스트
  → F4 (setup 제안)       — UX 마무리
  → F6·C1·C2              — 문구/문서
```

**검증 체크리스트**
- [ ] 게스트로 취향 입력·쿠폰 발급 → 카카오 연동 → **user_id 동일**, 취향·쿠폰 그대로 (Supabase `auth.users` 의 identities 2개 확인)
- [ ] 연동된 계정 로그아웃 → 새 익명 세션으로 게스트 모드 정상 동작(무회귀)
- [ ] 시크릿 창(=다른 기기 시뮬)에서 "기존 계정 로그인" → 같은 취향/쿠폰 복원
- [ ] 이미 카카오가 연동된 계정에 재차 linkIdentity → 에러 토스트(중복 연동) 정상 처리
- [ ] 익명 로그인 자체가 꺼진 환경에서도 기존 목업 폴백 무회귀
- [ ] `npm run lint / typecheck / build --workspace=apps/web` + `pytest apps/api -q` 그린
- [ ] 콜백 페이지가 정적 export 빌드(`next build`)에 포함되는지 확인

---

## 6. 사람이 해야 하는 수동 단계 (코드 밖 — 실행 승인 후 진행)

> 메뉴 이름은 Supabase 대시보드 버전마다 바뀌지만 URL 경로는 안정적이라, 프로젝트 ref 기준 직행 링크를
> 함께 적는다(현 프로젝트 ref = `epqdxkydhptlivecwfwu`). 아래는 2026-07 재구성된 UI 기준.

1. **Supabase 대시보드**
   - **Authentication → Sign In / Providers** (구 'Providers')
     → 링크: `https://supabase.com/dashboard/project/epqdxkydhptlivecwfwu/auth/providers`
     - "Auth Providers" 목록에서 **Kakao** 펼쳐 Enable + Client ID(= Kakao REST API 키)·Client Secret 입력
     - 같은 목록에서 **Google** 펼쳐 Enable + Client ID·Secret(GCP) 입력
     - 이 페이지에 표시되는 **Callback URL (for OAuth)** 값을 복사 → 카카오/구글 콘솔의 Redirect URI 로 사용
       (형식: `https://epqdxkydhptlivecwfwu.supabase.co/auth/v1/callback`)
     - 같은 페이지 하단 사용자 가입 옵션에서 **Allow anonymous sign-ins** ON + **Allow manual linking** ON
       (← linkIdentity 필수. 구 UI 의 'Enable manual linking')
   - **Authentication → URL Configuration**
     → 링크: `https://supabase.com/dashboard/project/epqdxkydhptlivecwfwu/auth/url-configuration`
     - **Redirect URLs** 에 `http://localhost:3000/auth/callback`, `https://<vercel 도메인>/auth/callback` 추가
2. **Kakao Developers 콘솔** (지도 쓰는 기존 앱 재사용)
   - 카카오 로그인 **활성화(ON)** + Redirect URI = 위 1번에서 복사한 Supabase Callback URL
   - 동의 항목: 닉네임·프로필 이미지(선택 동의). 이메일은 비즈 앱 전환 필요 → **이번 스코프에선 미수집**
3. **Google Cloud 콘솔**
   - OAuth 동의 화면(외부) + 웹 클라이언트 생성, 승인된 리디렉션 URI = 위 Supabase Callback URL
4. (기 완료 여부 확인) 1번의 "Allow anonymous sign-ins" ON + `handle_new_user`(+`20260715140000`) 적용 — 익명 승격의 전제

---

## 7. 비목표 (이번에 안 하는 것)

- 이메일/비밀번호 가입, 매직링크, Apple/네이버 로그인
- **메타(Facebook/Instagram) 로그인** — 인스타 피드 기반 취향 분석 목적으로 검토했으나 보류(2026-07-15 결정).
  사유: ① Meta App Review + 사업자 인증 요구로 공모전 일정 리스크, ② Instagram 개인 피드 API 는
  Basic Display 폐기 후 비즈니스/크리에이터 계정만 접근 가능해 일반 관광객 피드 분석이 사실상 불가,
  ③ 카카오+구글 대비 추가 커버리지 미미. 코드가 프로바이더 불문(F2)이라 후일 재개 시 버튼 추가 수준.
- 기기 B 익명 데이터와 기존 계정의 **병합**(orphan 은 방치 — 후속: 30일+ 미접속 익명 사용자 정리 배치)
- 관리자 인증 변경(D3 결정대로 데모 수준 유지 — `admin-auth.ts` 비접촉)
- 카카오 이메일 수집(비즈 앱 전환 필요), 휴대폰 인증
- 백엔드 신규 엔드포인트(승격은 전부 Supabase Auth + RLS 로 처리)

## 8. 리스크 & 완화

| 리스크 | 완화 |
|---|---|
| `detectSessionInUrl: true` 가 다른 페이지의 URL 해시를 오파싱 | PKCE(code 쿼리) 방식이라 해시 미사용. 콜백 외 경로엔 code 파라미터가 올 일 없음. 회귀로 main/explore 딥링크 확인 |
| 카카오 로그인 최초 심사/설정 지연 | 구글을 먼저 붙여 플로우 검증 → 카카오는 설정 완료 즉시 활성화(코드 동일) |
| linkIdentity 중복 이메일 충돌(구글 계정이 이미 다른 사용자에 연동) | Supabase 가 422 반환 → F2 에서 에러 토스트 + "기존 계정 로그인" 유도 |
| 데모 시나리오 회귀 | 모든 OAuth UI 는 선택 경로. 익명 폴백 체인(익명 실패→목업)은 손대지 않음 |
