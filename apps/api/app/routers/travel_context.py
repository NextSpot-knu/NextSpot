from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.services.travel_context_parser import parse_travel_context

router = APIRouter(prefix="/api/v1/travel-context", tags=["travel-context"])


class ParseRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=300)


class ParseResponse(BaseModel):
    context: dict
    llm_status: str
    requires_confirmation: bool = True


@router.post("/parse", response_model=ParseResponse)
async def parse_context(req: ParseRequest):
    context, status = await parse_travel_context(req.text)
    return ParseResponse(context=context, llm_status=status)

