from fastapi import APIRouter
from pydantic import BaseModel, Field
from app.services.predict_service import predict_congestion

router = APIRouter(tags=["predict"])

class PredictRequest(BaseModel):
    facility_type: str = Field(..., description="Facility type (e.g., cafeteria, parking, meeting_room, rest_area)")
    hour: int = Field(..., ge=0, le=23, description="Hour of the day (0-23)")
    day_of_week: int = Field(..., ge=0, le=6, description="Day of the week (0-6, where 0=Monday, 6=Sunday)")

class PredictResponse(BaseModel):
    predicted_congestion: float

@router.post("", response_model=PredictResponse)
def predict_endpoint(req: PredictRequest):
    # 공개 조회용(무인증) 엔드포인트다. 로컬 model.pkl 미학습 시 0.5 폴백이라 비용 부담이 없다.
    # 내부 전용으로 닫으려면 get_current_user 의존성을 추가하면 된다(응답 스키마 불변).
    pred = predict_congestion(req.facility_type, req.hour, req.day_of_week)
    return PredictResponse(predicted_congestion=pred)
