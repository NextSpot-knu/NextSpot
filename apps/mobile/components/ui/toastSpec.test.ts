import assert from 'node:assert/strict';

import { navInsetsFor } from '../navigation/navMetricsCore';
import { NAV_BAR_HEIGHT } from '../../lib/theme/tokens';
import { REPORT_TOAST, TOAST_BUTTON, announcementText, isActionButton, reportToastBottom, toastSideMargin } from './toastSpec';

// 폭: 폰(≤600)은 좌우 16 → 390 폭에서 358(웹 측정 16,770,358,58).
assert.equal(toastSideMargin(390), 16);
assert.equal(390 - 2 * toastSideMargin(390), 358);
assert.equal(toastSideMargin(600), 16);
// 펼친 폴드·태블릿: 폭 356 가운데.
assert.ok(Math.abs(673 - 2 * toastSideMargin(673) - 356) <= 1); // 반올림 1pt 이내
assert.equal(toastSideMargin(800), 222);

// 자리(D17 c): 탭 화면 = 막대 위 8, 그 밖 = 16 + 아래 안전 영역. AppToaster 는 navMetrics.toastBottom 을 그대로 쓴다.
assert.equal(navInsetsFor('/', 0).toastBottom, NAV_BAR_HEIGHT + 8);
assert.equal(navInsetsFor('/saved', 24).toastBottom, NAV_BAR_HEIGHT + 24 + 8);
assert.equal(navInsetsFor('/login', 24).toastBottom, 16 + 24);
assert.equal(navInsetsFor('/setup', 0).toastBottom, 16);

// 제보 채널: 화면 아래 96 + 안전 영역, 3.2초.
assert.equal(reportToastBottom(0), 96);
assert.equal(reportToastBottom(24), 120);
assert.equal(REPORT_TOAST.duration, 3200);

// 버튼 웹 값.
assert.equal(TOAST_BUTTON.height, 24);
assert.equal(TOAST_BUTTON.ink, '#171717');

// 행동 버튼 판별 — { label, onClick } 만 버튼으로 그린다(ReactNode 는 sonner-native 그대로).
assert.equal(isActionButton({ label: '보기', onClick: () => undefined }), true);
assert.equal(isActionButton(undefined), false);
assert.equal(isActionButton({ label: '보기' }), false);
assert.equal(isActionButton('보기'), false);

// 읽기 화면 알림 문구.
assert.equal(announcementText('취향 프로필에 반영했어요'), '취향 프로필에 반영했어요');
assert.equal(announcementText('모든 저장된 스팟을 초기화할까요?', '삭제된 목록은 되돌릴 수 없습니다.'), '모든 저장된 스팟을 초기화할까요? 삭제된 목록은 되돌릴 수 없습니다.');
assert.equal(announcementText('설정 초기화', '되돌릴 수 없어요'), '설정 초기화. 되돌릴 수 없어요');
assert.equal(announcementText('  ', '설명만'), '설명만');
assert.equal(announcementText('', ''), '');

console.log('toastSpec ok');
