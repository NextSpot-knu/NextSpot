"""사용자 8차원 선호 벡터 저장소 — Supabase 백엔드.

(대회 종료 후 GCP Firestore 백엔드를 제거하고 Supabase 테이블 `user_preference_vectors` 로 이전.)

설계 노트: 이 저장소는 ANN(최근접 이웃) 검색이 아니라 **user_id 로 벡터를 저장/조회(KV)** 하는 용도다.
(코사인 유사도는 tttv/preference.py 가 CATEGORY_VECTORS 와 로컬 계산.)

폴백 우선: Supabase 미가용/실패(예: 테이블 미생성) 시 프로세스 메모리 dict 로 graceful 폴백.
외부 인터페이스(_normalize_vector / get_user_vector / upsert_user_vector /
adjust_user_vector_on_feedback / available)는 시그니처 호환을 위해 그대로 유지한다(백엔드만 교체).
"""

import asyncio
import math

import structlog

from app.core.supabase import supabase_admin

logger = structlog.get_logger()

_TABLE = "user_preference_vectors"


class PreferenceVectorStore:
    def __init__(self):
        # service_role 클라이언트(RLS 우회) — 백엔드 신뢰 경로에서 적재/조회.
        self.client = supabase_admin
        # Supabase 실패/테이블 미생성 시 폴백(프로세스 메모리, 비영속).
        self._memory: dict[str, list[float]] = {}

    @property
    def available(self) -> bool:
        """저장소 사용 가능 여부(클라이언트 초기화 성공 여부)."""
        return self.client is not None

    def _normalize_vector(self, vector: list[float]) -> list[float]:
        """L2 정규화를 통해 벡터 크기를 1로 조절합니다."""
        sq_sum = sum(x ** 2 for x in vector)
        if sq_sum == 0:
            # 8차원 기본 제로 벡터 방지
            return [1.0 / math.sqrt(8)] * 8
        norm = math.sqrt(sq_sum)
        return [x / norm for x in vector]

    async def get_user_vector(self, user_id: str) -> list[float] | None:
        """Supabase 에서 사용자 선호도 벡터를 비동기적으로 조회합니다."""
        uid = str(user_id)
        if self.client is not None:
            try:
                res = await asyncio.to_thread(
                    self.client.table(_TABLE).select("vector").eq("user_id", uid).limit(1).execute
                )
                if res.data:
                    vec = res.data[0].get("vector")
                    if vec and len(vec) == 8:
                        return [float(x) for x in vec]
                    if vec:
                        # 문서는 있으나 차원 불일치(외부 오염/스키마 변경) — 가시화만 하고 콜드스타트로 덮어쓰게 둔다.
                        logger.warning("pref_vector_dim_mismatch", user_id=uid, dim=len(vec))
                return None
            except Exception as e:
                # 테이블 미생성/네트워크 실패 → 메모리 폴백
                logger.warning("pref_vector_get_failed", user_id=uid, error=str(e))
                return self._memory.get(uid)
        return self._memory.get(uid)

    async def upsert_user_vector(self, user_id: str, vector: list[float]):
        """사용자 선호도 벡터를 정규화하여 Supabase 에 저장합니다."""
        uid = str(user_id)
        normalized = self._normalize_vector(vector)
        if self.client is not None:
            try:
                await asyncio.to_thread(
                    self.client.table(_TABLE).upsert({"user_id": uid, "vector": normalized}).execute
                )
                return
            except Exception as e:
                logger.warning("pref_vector_upsert_failed", user_id=uid, error=str(e))
        self._memory[uid] = normalized

    async def adjust_user_vector_on_feedback(self, user_id: str, facility_vector: list[float], action: str):
        """사용자 피드백에 따라 선호도 벡터를 점진적으로 업데이트합니다.
        - 수락(accepted): 시설 벡터 방향으로 10% 이동
        - 거절(rejected/ignored): 반대 방향으로 5% 이동
        """
        current_vector = await self.get_user_vector(user_id)
        if not current_vector:
            current_vector = [0.0] * 8

        current_vector = self._normalize_vector(current_vector)
        facility_vector = self._normalize_vector(facility_vector)

        if action == "accepted":
            # v_new = v_old + 0.1 * (v_facility - v_old)
            new_vector = [
                v_old + 0.1 * (v_fac - v_old)
                for v_old, v_fac in zip(current_vector, facility_vector)
            ]
        else:  # rejected, ignored
            # v_new = v_old - 0.05 * (v_facility - v_old)
            new_vector = [
                v_old - 0.05 * (v_fac - v_old)
                for v_old, v_fac in zip(current_vector, facility_vector)
            ]

        await self.upsert_user_vector(user_id, new_vector)


# 싱글톤 인스턴스 (Supabase 백엔드; 시그니처 호환 유지)
preference_vector_service = PreferenceVectorStore()
