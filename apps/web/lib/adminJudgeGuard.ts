// 심사용 관리자 계정(openapi@gmail.com)으로 막힌 관제 쓰기의 안내 문구.
//
// 심사위원 여러 명이 이 계정 하나를 함께 쓴다. 서버(apps/api/app/routers/admin.py)는 그중 전체 설정 저장과
// 장소 삭제만 403 으로 막고 이유를 detail 에 싣는다. lib/admin-api.ts 는 서버 문장을 화면에 싣지 않고
// 상태 코드만 넘기므로(검수 안 된 문장 차단) 같은 문장을 여기 둔다. 이게 없으면 심사위원은
// '잠시 후 다시 시도해 주세요' 를 보고, 몇 번을 눌러도 되지 않는 재시도를 하게 된다.
//
// 관제 화면은 관리자 역할로만 열리고(app/admin/layout.tsx) developer 는 서버 역할 가드를 늘 통과하므로,
// 이 두 쓰기의 403 은 심사 계정 가드에서만 나온다. 문장의 정본은 서버 상수이고 옆 테스트가 대조한다.

export type JudgeBlockedWrite = 'settings' | 'deleteFacility';

export const JUDGE_BLOCKED_MESSAGES: Record<JudgeBlockedWrite, string> = {
  settings: '심사용 계정에서는 전체 설정을 바꿀 수 없어요.',
  deleteFacility: '심사용 계정에서는 장소를 삭제할 수 없어요.',
};

/** 실패가 심사 계정 가드(403)면 그 이유 문장, 아니면 null — 호출부는 기존 문구를 그대로 쓴다. */
export function judgeBlockedMessage(status: number | null, write: JudgeBlockedWrite): string | null {
  return status === 403 ? JUDGE_BLOCKED_MESSAGES[write] : null;
}
