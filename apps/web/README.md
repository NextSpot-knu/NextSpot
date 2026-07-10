# NextSpot - 경주 관광 수요 분산 AI 플랫폼

경주 황리단길 관광 POI(음식점, 카페, 관광지, 문화시설)의 실시간 혼잡도를 분석하고, 혼잡 발생 시 SPOT(Smart Place Optimization for Tourism) 알고리즘 기반 대안 장소 및 시간대를 추천하는 관광 수요 재배치 모노레포 프로젝트입니다.

## 기술 스택
- **Frontend / BFF**: Next.js 16 (App Router) + TypeScript + Tailwind CSS
- **Backend API / ML**: FastAPI (Python 3.11) + Pydantic v2 (pip / requirements.txt)
- **Database & Auth**: Supabase (PostgreSQL + Realtime + GoTrue)
- **Map**: Kakao Maps JavaScript SDK
- **Container**: Docker & Docker Compose

## 프로젝트 구조
```text
nextspot/
├── apps/
│   ├── web/                  # Next.js 16
│   └── api/                  # FastAPI (Python 3.11)
├── packages/
│   └── shared-types/         # Next.js ↔ FastAPI 공유 타입 정의
├── supabase/migrations/      # Supabase SQL 마이그레이션 (정본)
├── docker-compose.yml
└── README.md
```

## 시작하기

### 환경 설정
각 프로젝트 디렉토리 내부의 환경변수 설정 파일(`.env.example`)을 참고하여 실제 `.env` 파일들을 구성하십시오.

1. **Root**: `.env` (공통)
2. **Web**: `apps/web/.env.local`
3. **API**: `apps/api/.env`

### 로컬 실행 방법

#### Docker Compose를 통한 FastAPI 및 서비스 실행
```bash
docker-compose up --build
```

#### 프론트엔드 (Next.js) 로컬 구동
```bash
cd apps/web
npm install
npm run dev
```

#### 백엔드 (FastAPI) 로컬 구동
```bash
cd apps/api
pip install -r requirements.txt
uvicorn app.main:app --reload
```
