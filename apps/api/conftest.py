# pytest 루트 앵커 — 이 파일이 있는 디렉터리(apps/api)가 sys.path 에 삽입되어
# 테스트의 `from app.services...` 임포트가 어떤 실행 방식에서도 동작한다.
# (`python -m pytest` 는 CWD 를 sys.path 에 넣어주지만, CI 처럼 `pytest` 를 직접 실행하면
#  넣지 않아 ModuleNotFoundError: No module named 'app' 수집 오류(exit 2)가 났다.)
