# pytest 루트 앵커 — 이 파일이 있는 디렉터리(apps/api)가 sys.path 에 삽입되어
# 테스트의 `from app.services...` 임포트가 어떤 실행 방식에서도 동작한다.
# (`python -m pytest` 는 CWD 를 sys.path 에 넣어주지만, CI 처럼 `pytest` 를 직접 실행하면
#  넣지 않아 ModuleNotFoundError: No module named 'app' 수집 오류(exit 2)가 났다.)
#
# ⚠️ tests/ 아래 어디에도 __init__.py 를 두지 말 것. tests/scripts/ 는 실제 `scripts` 패키지(apps/api/scripts)와
#  이름이 같아 둘 다 네임스페이스 패키지일 때만 공존한다. tests/scripts/__init__.py 를 만들면 sys.path 앞쪽의
#  apps/api/tests 가 `scripts` 를 가로채 `from scripts.ingest_tourapi import ...` 가 깨진다.
