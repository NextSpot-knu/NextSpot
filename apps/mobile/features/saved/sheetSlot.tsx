// 저장 장소를 눌렀을 때 뜨는 추천 카드 시트 — features/recommendation-card 의 RecommendationSheet 그대로.
//
// 웹 saved/page.tsx 가 RecommendationCard 에 넘기던 것과 같은 짝이다.
//   · onAccept(바로 갈래요) — 서버 수락·여정 기록·길안내는 시트가 이미 했다. 여기서는 시트만 닫는다(길안내를 두 번 열지 않는다).
//   · onReject(다시 안볼래요) → 저장에서 뺀다(unsaved). 서버 '거절' 이 아니라 목록 정리라 취향 학습이 없다(rejectIsRemoval).
//   · onKeep(나중에) — 이미 저장된 장소라 새로 할 일이 없다(시트가 북마크를 다시 저장하는 것은 같은 id 라 그대로다).
// 화면(app/(tabs)/saved.tsx)은 이 파일의 `SavedSheetSlot` 과 props 만 안다.
import { useMemo } from 'react';

import { RecommendationSheet } from '~/features/recommendation-card';

import { candidateFromBookmark, type SavedBookmark } from './savedList';

export interface SavedSheetSlotProps {
  /** 열린 장소. null 이면 닫힘. */
  bookmark: SavedBookmark | null;
  onClose: () => void;
  /** 저장에서 빼기 — 웹 onReject. 화면이 unsaved 피드백·삭제·토스트를 처리하고 시트를 닫는다. */
  onRemove: (bookmark: SavedBookmark) => void;
  onViewProfile?: () => void;
  onViewLab?: () => void;
}

export function SavedSheetSlot({ bookmark, onClose, onRemove, onViewProfile, onViewLab }: SavedSheetSlotProps) {
  const candidate = useMemo(() => (bookmark ? candidateFromBookmark(bookmark) : null), [bookmark]);
  return (
    <RecommendationSheet
      selected={candidate}
      candidates={[]}
      openAs="normal"
      onAccept={onClose}
      onReject={() => {
        if (bookmark) onRemove(bookmark);
      }}
      rejectIsRemoval
      onClose={onClose}
      onViewProfile={onViewProfile}
      onViewLab={onViewLab}
    />
  );
}
