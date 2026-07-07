# NextSpot 배포 & 환경변수 매뉴얼

> 한 번만 설정하면 됩니다. ① Supabase 스키마 교체 → ② 환경변수 등록 → ③ Vercel 연결.

---

## 1. Supabase 설정 (앱이 데이터로 돌아가려면 필수)

NextSpot의 모든 데이터(장소·혼잡도·추천)는 **Supabase**(클라우드 PostgreSQL)에 저장됩니다.
팀원 프로젝트에는 옛 **InduSpot(구미 산업) 데이터**가 들어 있으므로, **경주 관광용으로 한 번 갈아끼웁니다.**

### 1-1. 스키마 교체 (1회, 약 2분) — *Supabase 대시보드 접근 권한이 있는 사람이 실행*
1. https://supabase.com 로그인 → 팀 프로젝트 선택
2. 왼쪽 메뉴 **SQL Editor** → **New query**
3. 레포의 **`supabase/RESET_AND_SETUP.sql`** 파일 내용을 **전체 복사 → 붙여넣기**
4. 우측 하단 **Run**
   → 구미 산업 스키마/데이터 **DROP** + 경주 관광 스키마·시드(16 POI + 7일 혼잡로그) **자동 생성**

> ⚠️ 되돌릴 수 없습니다(기존 InduSpot 데이터 삭제). InduSpot은 더 안 쓰므로 OK.
> DB 비밀번호 공유 불필요 — SQL Editor 접근만으로 끝.

> 📌 **DB 셋업 경로 정리** (`LOCAL_RUN.md` 와 공통 기준):
> - **신규/초기화 셋업** = 위처럼 `supabase/RESET_AND_SETUP.sql` **1회 실행**.
> - **기존 DB를 유지**해야 하면 대신 `supabase/migrations/*` 를 순차 적용(`supabase db push`).
> - 기존 DB에는 2026-07-07 `security_hardening` 마이그레이션
>   (`supabase/migrations/20260707120000_security_hardening.sql`)을 **반드시** 적용하세요(RLS 보안 수정).
> - `RESET_AND_SETUP.sql` 은 **자동 생성 파일**입니다(직접 수정 금지 — 스키마 변경은 migrations 에 추가 후 `node scripts/build_reset.mjs` 재실행).

### 1-2. (선택) 예측 모델 학습
스키마 적용 후 로컬에서 1회:
```bash
cd apps/api && python scripts/train.py    # Supabase 혼잡로그 → model.pkl
```
미실행 시 예측은 0.5로 폴백(앱은 정상 동작).

---

## 2. 환경변수 — "키를 어디에 넣나" (질문 답변)

NextSpot은 **Supabase URL/키 + Kakao 지도 키**가 필요합니다. 저장 위치는 **용도별로 다릅니다:**

| 용도 | 저장 위치 | 비고 |
|---|---|---|
| **로컬 개발** | `apps/api/.env` + `apps/web/.env.local` 파일 | `.gitignore`됨(커밋 안 됨). `.env.example` 복사 후 값 채우기 |
| **Vercel 배포** | **Vercel 대시보드 → Project → Settings → Environment Variables** | ✅ **이게 "secret 등록"입니다.** 1회 등록 → 매 배포 자동 주입. 깃에 노출 X |
| **GitHub Actions(Pages 쓸 때만)** | GitHub repo → Settings → Secrets → Actions | Actions 워크플로 전용. **Vercel 쓰면 불필요** |

> **❓ "env를 GitHub Secret으로 등록?"** → **Vercel을 쓰면 GitHub Secret이 아니라 `Vercel 환경변수`에 넣습니다.** 그게 Vercel판 "secret"이고, 깃에 노출되지 않는 안전한 저장소입니다.
> GitHub Secret은 **GitHub Actions(=Pages 배포)** 일 때만 의미가 있습니다. 우리는 Vercel을 쓰므로 → **Vercel 환경변수**.

**필요한 키** (기존 `Induspot/.env`에 이미 있음 — 그대로 복사):
- 백엔드: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`
- 프론트: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_KAKAO_MAPS_APP_KEY`, `NEXT_PUBLIC_FASTAPI_URL`

> 💡 Vercel에 등록한 값을 로컬로 가져오기: `npx vercel env pull apps/web/.env.local` → 로컬 `.env`도 수동 관리 불필요.

---

## 3. Vercel 자동 배포 (InduSpot과 동일 방식 · 팀원 Vercel 재사용)

InduSpot도 **Vercel 대시보드에 레포를 연결**해 push 시 자동 배포한 방식입니다(레포에 배포 설정 파일이 따로 없었음). NextSpot도 동일하게:

1. **팀원 Vercel 계정**(InduSpot 쓰던 그 계정)으로 https://vercel.com 로그인
2. **Add New → Project** → GitHub의 **`NextSpot-knu/NextSpot`** import
   (InduSpot 프로젝트는 그대로 두고, NextSpot은 **새 프로젝트**로 추가 — 레포가 다르므로 재사용이 아니라 새로 import)
3. **Root Directory = `apps/web`** 설정 (모노레포라 프론트 위치 지정) ← 중요
4. **Environment Variables**에 위 `NEXT_PUBLIC_*` 키 입력
5. **Deploy**

→ 이후 **`main` 브랜치에 push할 때마다 자동 배포.** URL은 `nextspot-xxx.vercel.app`(또는 커스텀 도메인).

> **GitHub Pages와 차이:** Pages는 `nextspot-knu.github.io/NextSpot` 같은 **서브경로 링크** + `basePath` 설정이 필요해 번거롭습니다. Vercel은 **루트 도메인(`*.vercel.app`)** 이라 깔끔 → **Vercel 권장**.

### 브랜치 전략
- **`main`** = 배포되는 안정 브랜치 (Vercel이 `main`을 자동 배포)
- **`feature/seungyong`** = 작업 브랜치. 완성되면 `main`으로 merge → 자동 배포
- Vercel은 **feature 브랜치도 프리뷰 배포**를 자동 생성 → main 머지 전 미리보기 가능

---

## 4. ⚠️ 백엔드(FastAPI)는 별도 호스팅 필요

Vercel은 **프론트(Next.js)만** 배포합니다. 추천 API(`apps/api`, FastAPI)는:
- `main/page` 추천: 백엔드 미가용 시 **클라이언트 미러(lib/recommender.ts)로 폴백** → 지도/추천 동작
- `explore/recommend` 상세 추천: **FastAPI 필요** → Render/Railway/Fly.io 등에 별도 배포 후 `NEXT_PUBLIC_FASTAPI_URL` 지정
- (백엔드 미배포 시 explore/recommend는 빈 추천 상태. 데모는 main 지도 중심으로 가능)
