# --- InduSpot API 컨테이너 (로컬/배포 공용, 비-GCP) ---
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

# 포트 개방 메타데이터
EXPOSE 8080

# 구동: app.main:app (docker-compose 는 호스트 8000 → 컨테이너 8080 매핑)
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
