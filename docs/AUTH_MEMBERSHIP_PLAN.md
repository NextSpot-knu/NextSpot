# 앱 자체 회원(이메일/비밀번호) 인증 — DB & 구현 계획

> 작성 2026-07-16. 실행 전 검토용. OAuth(카카오·구글)와 별개로, 앱이 직접 소유하는
> 이메일/비밀번호 회원 체계를 도입한다. DB 마이그레이션은 이 계획 승인 후 적용한다.
> 관련: [`OAUTH_PLAN.md`](./OAUTH_PLAN.md)(익명·소셜), 저장 데이터 영속화(`lib/savedFacilities.ts`).

---

## 0. 한 줄 정의

랜딩 '바로 시작' → **로그인/회원가입 페이지**. 이메일+비밀번호로 가입·로그인하며, 기존 익명(게스트)
세션은 **정회원으로 전환**해 저장·취향 데이터를 그대로 승계한다. 게스트 둘러보기도 유지한다.

---

## 1. 인증 방식 결정 (핵심)

| 선택지 | 내용 | 판정 |
|---|---|---|
| **A. Supabase Auth 이메일/비밀번호** | `auth.users`(이메일·해시비번·확인상태)를 Supabase 가 관리. JWT·RLS·`handle_new_user`·`saved_facilities`(user_id 기준)를 **그대로 재사용** | ✅ **채택** |
| B. 완전 커스텀(자체 users+비번해시+자체 JWT) | FastAPI JWT 검증·모든 RLS(`auth.uid()`)·user_id 연동 데이터를 전면 재작성 | ❌ 비용 과다·이득 없음 |

**"앱 자체 회원"의 의미**: 신원을 구글/카카오에 위임하지 않고 **이메일+비밀번호를 우리 Supabase 프로젝트가
직접 보관·검증**한다 = 앱이 계정을 소유. Supabase 는 자체호스팅 가능한 우리 DB 이므로 "자체 회원" 요건 충족.
백엔드(FastAPI)의 JWT 검증은 이미 이메일 사용자도 처리하므로 **무변경**.

---

## 2. DB 구성

### 2-1. 재사용(변경 없음)
- **`auth.users`** (Supabase 관리): `email`, `encrypted_password`, `email_confirmed_at`, `is_anonymous`.
- **`public.users`**: 이미 `id`(=auth uid), `nickname`, `avatar_url`, `preferred_categories`, `role` 보유.
- **`handle_new_user` 트리거**: 신규 `auth.users` INSERT(이메일 가입 포함) 시 `public.users` 자동 생성 +
  `raw_user_meta_data`의 `full_name/name`→`nickname` 복사. **이메일 가입도 그대로 커버**.
- **`saved_facilities`·`user_preference_vectors` 등**: user_id 기준이라 회원 전환 후에도 자동 승계.

### 2-2. 신규/변경 (마이그레이션 후보 — 승인 후 적용)
| # | 항목 | 필요성 | 결정 필요 |
|---|---|---|---|
| M1 | `public.users.username TEXT UNIQUE`(선택) | @핸들/표시용 고유 아이디를 쓸지 | **쓸지 여부**(안 쓰면 nickname 만으로 충분) |
| M2 | `handle_new_user` 에 `nickname` 메타키 폴백 추가 | 가입 시 닉네임을 `full_name` 외 `nickname` 키로도 받을 수 있게(사소) | 선택 |
| M3 | (커스텀 클레임/role 확장) | 지금은 `role='tourist'` 기본으로 충분 | 불필요(보류) |

> 결론: **DB 스키마 변경은 최소**(사실상 없거나 M1 username 하나). 핵심은 스키마가 아니라
> **Supabase Auth 대시보드 설정**(§3)이다.

### 2-3. Supabase Auth 설정 (대시보드 — 사람 작업)
| 설정 | 위치 | 권고 |
|---|---|---|
| Email 프로바이더 | Authentication → Sign In / Providers → Email | **Enable**(기본 켜짐) |
| **Confirm email**(이메일 인증) | 같은 화면 | **데모: OFF**(가입 즉시 세션·로그인). 운영: ON(메일 확인 후 활성) |
| 비밀번호 정책(최소 길이 등) | 같은 화면 | 최소 8자 권장 |
| Allow anonymous sign-ins | 같은 화면 | **유지 ON**(게스트 둘러보기) |
| 이메일 템플릿(Confirm ON 시) | Authentication → Emails | 확인 메일 문구 한글화 |

---

## 3. 사용자 플로우 (TO-BE)

```
랜딩 '바로 시작' ──▶ /login
   ├─ [로그인] 이메일+비번 → signInWithPassword → /main
   ├─ [회원가입] 이메일+비번(+닉네임)
   │     ├─ 현재 익명 세션 있음 → updateUser(email,password)로 '전환'(uid 유지 → 데이터 승계) → /setup
   │     └─ 세션 없음 → signUp → (Confirm OFF)즉시 세션 → /setup / (Confirm ON)확인메일 안내
   └─ [게스트로 둘러보기] → /setup (익명 세션 그대로, 무마찰 유지)
```

- **가입=전환**: 게스트가 회원가입하면 익명 uid 를 유지한 채 이메일/비번을 붙인다(Supabase 익명→정회원
  전환). 그래서 게스트로 저장한 장소·취향이 회원 계정에 **그대로 남는다**(OAuth linkIdentity 와 동일 사상).
- **로그인=계정 전환**: 다른 회원으로 로그인하면 uid 가 바뀌므로, 로그인 직후 `reconcileUserData` +
  `syncSaved`(이미 구현)로 이전 게스트 로컬 데이터를 청소하고 그 회원의 저장 목록을 복원한다.

---

## 4. 작업 목록 (파일)

| # | 작업 | 파일 | 상태 |
|---|---|---|---|
| F1 | 랜딩 '바로 시작' → `/login` | `app/page.tsx` | 이번 반영 |
| F2 | 이메일 로그인/가입 헬퍼(`signInWithEmail`·`signUpWithEmail`) — 익명 전환·프로필 백필 포함 | `lib/auth.ts` | 이번 반영 |
| F3 | 로그인/회원가입/게스트 페이지 | `app/login/page.tsx`(신규) | 이번 반영 |
| F4 | 로그인 성공 후 데이터 격리·복원 배선 | `app/login/page.tsx`(reconcile+syncSaved) | 이번 반영 |
| F5 | i18n 키(로그인/가입/에러) | `lib/i18n/*` | 이번 반영 |
| F6 | 마이페이지 계정 섹션에 이메일 회원 표기·연동(선택) | `components/AccountSection.tsx` | 후속 |
| D1 | (선택) `username` 마이그레이션 + `handle_new_user` 폴백 | `supabase/migrations/*` | **승인 후** |
| C1 | 대시보드 설정(§2-3)·(선택)username 적용 | Supabase 콘솔 | 사람 작업 |

> **이번 턴 범위**: F1~F5(랜딩 연결 + 로그인 페이지, 기존 DB 로 동작). **DB 마이그레이션(D1)과
> 대시보드 설정(C1)은 이 계획 승인 후** 진행.

---

## 5. 결정이 필요한 항목 (사람)

1. **이메일 인증(Confirm email) ON/OFF** — 데모 편의(OFF) vs 보안(ON). → 기본 권고 **OFF**.
2. **username(고유 아이디) 도입 여부** — 닉네임만으로 충분한지. → 기본 권고 **미도입**(nickname 사용).
3. **게스트 유지 여부** — '게스트로 둘러보기'를 남길지, 로그인 강제할지. → 기본 권고 **유지**.
4. **비밀번호 재설정 메일 플로우** 이번 스코프 포함 여부. → 권고 **후속(Phase 2)**.

---

## 6. 비목표 (이번에 안 함)
- 비밀번호 재설정/변경, 이메일 변경, 2FA, 소셜↔이메일 계정 병합.
- username 기반 검색/멘션.
- 관리자/머천트 인증 변경(별도 체계 유지).
