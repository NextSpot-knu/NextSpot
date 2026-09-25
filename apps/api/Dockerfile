# --- NextSpot API 컨테이너 (로컬/배포 공용) ---
# 단일 스테이지 + pip(requirements.txt). 대회용 Poetry/Cloud Run 빌드 경로는 제거됨.
FROM python:3.11-slim

WORKDIR /app

# 의존성 먼저 설치(레이어 캐시 활용)
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# 애플리케이션 코드 복사
COPY . .

# 실행 환경 변수 기본값
ENV ENV=production
ENV PORT=8080

# glibc 가 스레드마다 malloc arena 를 늘려 해제된 메모리를 붙들고 있어(asyncio.to_thread 워커
# 스레드가 늘어날 때마다) RSS 가 계단식으로 오르는 것을 막는다 - 512MB 단일 인스턴스 OOM
# (2026-09-21, Render nextspot-api 15~60분마다 재시작) 대응. python:3.11-slim 은 Debian
# 기반(glibc)이라 이 환경변수가 그대로 적용된다(Alpine/musl 베이스였다면 무의미).
ENV MALLOC_ARENA_MAX=2
# 고정 128KB 문턱: glibc 의 동적 mmap 문턱(최대 32MB까지 커진다)을 끈다 — 큰 PostgREST 응답 버퍼가 늘 mmap 되어
# 해제 즉시 OS 로 돌아간다. python:3.11-slim(trixie) 실측: ARENA_MAX=2 단독 대비 정착·피크 -5MB, CPU 불변.
ENV MALLOC_MMAP_THRESHOLD_=131072
ENV MALLOC_TRIM_THRESHOLD_=131072

# 포트 개방 메타데이터
EXPOSE 8080

# 구동: app.main:app (docker-compose 는 호스트 8000 → 컨테이너 8080 매핑)
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
