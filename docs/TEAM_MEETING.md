# NextSpot — 팀원 회의 안건 (만나서 처리/결정)

> 승용이 로컬에서 마이그레이션·코드 정비·repo 세팅은 끝냈고, **아래는 팀원(특히 Supabase·Vercel 소유자)과 함께 해야 하는 일**입니다.
> 배포·환경변수 상세는 `docs/DEPLOY_AND_ENV.md` 참고.

---

## ✅ 먼저: 지금까지 완료된 것 (참고)
- 구미 산업단지(InduSpot) → 경주 황리단길 관광(NextSpot) **도메인 전면 전환** (코드·시드·문서)
- 더미/목업 데이터 **전부 제거 → 실데이터(Supabase) 전용** 처리
- 모의 위치 = 경주 주요 관광지(황리단길·대릉원·첨성대 등), 지도 **줌별 밀집도** 적용
- GitHub **NextSpot-knu/NextSpot** 생성, `main` + `feature/seungyong` 푸시, 빌드 통과
- 적대적 잔재 검증 통과(브랜드·구미·산업어휘·좌표·목업·하드코딩URL = 0)

---

## 🔴 1. Supabase 스키마 교체 — **대시보드 접근 권한자(팀원)가 실행**
경주 데이터로 돌아가려면 **반드시 1회** 필요. (약 2분, DB 비밀번호 공유 불필요)

1. https://supabase.com 로그인 → 팀 프로젝트
2. **SQL Editor → New query**
3. 레포 **`supabase/RESET_AND_SETUP.sql`** 전체 복사 → 붙여넣기 → **Run**
   → 기존 InduSpot(구미) 스키마·데이터 삭제 + 경주 관광 스키마·시드(16곳 + 7일 혼잡로그) 생성

> ⚠️ 기존 InduSpot 데이터는 삭제됩니다(더 안 쓰므로 OK). **되돌릴 수 없음** → 실행 전 한 번 더 확인.
> ▶ 회의 때: 팀원 화면에서 같이 실행하고, 직후 `facilities` 테이블에 경주 16곳 들어왔는지 확인.

---

## 🔴 2. Vercel 자동 배포 — **팀원 Vercel 계정으로 연결**
InduSpot처럼 push→자동배포. **계정은 재사용하되 NextSpot은 새 프로젝트로 import**(레포가 다름).

1. 팀원 Vercel 계정 로그인 → **Add New → Project** → `NextSpot-knu/NextSpot` import
2. **Root Directory = `apps/web`** (중요)
3. **Environment Variables**에 `NEXT_PUBLIC_*` 키 입력 (값은 아래 4번 .env 참고)
4. **Deploy** → 이후 `main` push마다 자동 배포

### 📌 결정: 배포 URL 이름 (induspot.vercel.app → ?)
- 기존 `induspot.vercel.app`은 InduSpot 프로젝트 소유 → **NextSpot은 새 프로젝트라 새 이름** 부여 가능
- 프로젝트 생성 시 이름을 **`nextspot`** 으로 → `nextspot.vercel.app` (전역 중복 시 `nextspot-knu` 등)
- 언제든 **Project → Settings → Domains / 프로젝트명 변경**으로 수정 가능
- ▶ 회의 때: 쓸 서브도메인 이름 합의 (또는 커스텀 도메인 쓸지)

---

## 🟡 3. 백엔드(FastAPI) 호스팅 — **결정 필요**
Vercel은 프론트(Next.js)만 배포. 추천 API(`apps/api`)는 별도 호스팅 필요.
- `main` 지도/추천: 백엔드 없어도 **클라이언트 폴백**으로 동작 (데모 가능)
- `explore/recommend` 상세 추천: **FastAPI 필요**
- ▶ 회의 때 결정: Render/Railway/Fly.io 중 어디에 올릴지 / 아니면 데모는 main 지도 중심으로 갈지

---

## 🟡 4. 환경변수(.env) 위치 — **공유용 메모**
> 로컬 `.env`는 **gitignore**되어 깃에 안 올라감 → 팀원도 **본인 로컬에 직접** 둬야 함.
> 값은 기존 **`Induspot/.env`** 에 있던 것과 동일 (Supabase·Kakao 키).

승용 로컬에 이미 정리해 둔 파일 위치 (NextSpot 루트 기준):
| 파일 | 용도 | 주요 키 |
|---|---|---|
| `.env` (루트) | docker-compose 공용 | SUPABASE_*, JWT_SECRET, KAKAO_*, ADMIN_API_TOKEN |
| `apps/api/.env` | FastAPI 백엔드 | SUPABASE_URL/ANON/SERVICE_ROLE, JWT_SECRET |
| `apps/web/.env.local` | Next.js 프론트 | NEXT_PUBLIC_SUPABASE_*, NEXT_PUBLIC_KAKAO_MAPS_APP_KEY, NEXT_PUBLIC_FASTAPI_URL |

- **배포용 키 등록 위치**: Vercel 대시보드 환경변수(프론트) / 백엔드 호스팅 환경변수
  → **GitHub Secret 아님** (Secret은 GitHub Actions 쓸 때만. 우리는 Vercel)
- ▶ 회의 때: 팀원에게 위 3개 파일을 어떻게 전달할지(보안 채널) — Slack DM/1Password 등. **깃/메신저 평문 자제**

---

## 🟢 5. (선택) 예측 모델 재학습
스키마 교체 후 로컬에서 1회: `cd apps/api && python scripts/train.py` → `model.pkl` 갱신
(미실행 시 예측 0.5 폴백, 앱은 정상)

---

## 🟢 6. 이후 백로그 (회의에서 우선순위 합의)
- **TourAPI(한국관광공사) 실연동** — 현재 시드는 수기 큐레이션 16곳. 실데이터 자동 수집 붙이기 (P1)
- TTTV 가중치 계획서값(0.40/0.40/0.20) vs 코드값(0.45/0.25/0.30) 정합 — 테스트 영향 검토 후
- 황리단길 외 경주 전역 확장 범위

---

### 회의 체크리스트 (요약)
- [ ] Supabase `RESET_AND_SETUP.sql` 실행 + 경주 16곳 확인
- [ ] Vercel에 NextSpot import (Root=`apps/web`) + 환경변수 + 도메인 이름 합의
- [ ] 백엔드 호스팅 결정 (Render/Railway/… or 데모는 main 중심)
- [ ] `.env` 3개 파일 팀원에게 보안 전달
- [ ] (선택) `train.py` 재학습 / TourAPI 연동 일정
