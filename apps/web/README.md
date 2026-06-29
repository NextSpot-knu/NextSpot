# InduSpot - 스마트 공단 인프라 수요 분산 AI 플랫폼

산업단지 내 공용 인프라(식당, 주차장, 회의실, 휴게 공간)의 실시간 혼잡도를 분석하고, 혼잡 발생 시 TTTV(Total Time to Value) 알고리즘 기반 대안 경로 및 시간대를 추천하는 B2B SaaS 모노레포 프로젝트입니다.

## 기술 스택
- **Frontend / BFF**: Next.js 14 (App Router) + TypeScript + Tailwind CSS
- **Backend API / ML**: FastAPI (Python 3.11) + Pydantic v2 + Poetry
- **Database & Auth**: Supabase (PostgreSQL + Realtime + GoTrue)
- **Vector DB**: Pinecone
- **Map**: Kakao Maps JavaScript SDK
- **Container**: Docker & Docker Compose

## 프로젝트 구조
```text
induspot/
├── apps/
│   ├── web/                  # Next.js 14
│   └── api/                  # FastAPI (Python 3.11)
├── packages/
│   └── shared-types/         # Next.js ↔ FastAPI 공유 타입 정의
├── migrations/               # Supabase SQL 마이그레이션
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

#### 백엔드 (FastAPI) 로컬 구동 (Poetry 필요)
```bash
cd apps/api
poetry install
poetry run uvicorn app.main:app --reload
```
