// 관제 데모(/admin/support?demo=1)의 예시 문의 — 모두 만든 값이다. 이름은 가렸고 연락처는 example.com 이다.
// 행 모양은 화면이 서버에서 받는 InquiryRow 와 같다(app/admin/support/page.tsx).
// 시각은 호출 시각 기준 상대값이라 목록이 늘 '방금 들어온 문의' 처럼 보인다. 난수는 쓰지 않는다.

import type { InquiryRow } from '@/app/admin/support/page';

const MIN = 60_000;

export function demoInquiries(now: number = Date.now()): InquiryRow[] {
  const ago = (minutes: number) => new Date(now - minutes * MIN).toISOString();

  return [
    {
      id: 'd3m0a001-0000-4000-8000-000000000001',
      user_id: 'demo-user-0001',
      user_name: '관광객 김**',
      type: '이용 문의',
      title: '쿠폰 사용 문의',
      content:
        '타임세일 쿠폰을 받았는데 결제할 때 어디에 보여 드려야 하나요?\n가게 직원분이 처음 보는 화면이라고 하셔서 여쭤봅니다.',
      status: 'new',
      created_at: ago(14),
      reply_body: null,
      replied_at: null,
    },
    {
      id: 'd3m0a002-0000-4000-8000-000000000002',
      user_id: 'demo-merchant-0002',
      user_name: '사장님 박**',
      type: '사장님 문의',
      title: '대기 시간 표시 문의',
      content:
        '저녁 시간에 손님이 많은데 앱에는 대기 10분으로 나옵니다.\n실제 대기는 30분쯤인데 어디서 고치면 되는지 알려 주세요.',
      status: 'new',
      created_at: ago(52),
      reply_body: null,
      replied_at: null,
    },
    {
      id: 'd3m0a003-0000-4000-8000-000000000003',
      user_id: null,
      user_name: '관광객 이**',
      type: '오류 신고',
      title: '길안내 오류',
      content:
        '안내된 길로 가니 막다른 골목이었습니다. 공사 중이라 지나갈 수 없었어요.\n회신은 user***@example.com 으로 부탁드립니다.',
      status: 'new',
      created_at: ago(3 * 60 + 10),
      reply_body: null,
      replied_at: null,
    },
    {
      id: 'd3m0a004-0000-4000-8000-000000000004',
      user_id: 'demo-merchant-0004',
      user_name: '사장님 최**',
      type: '사장님 문의',
      title: '가게 사진 등록',
      content:
        '가게 대표 사진을 새로 바꾸고 싶습니다. 앱에서 올리는 방법이 어디에 있나요?\n사진은 세 장 정도 준비해 두었습니다.',
      status: 'in_progress',
      created_at: ago(6 * 60 + 25),
      reply_body: null,
      replied_at: null,
    },
    {
      id: 'd3m0a005-0000-4000-8000-000000000005',
      user_id: 'demo-merchant-0005',
      user_name: '사장님 정**',
      type: '정보 수정 요청',
      title: '혼잡도 정보 수정 요청',
      content:
        '평일 오후 2시는 한산한 편인데 지도에는 붐빔으로 표시됩니다.\n시간대별 혼잡도를 다시 확인해 주실 수 있을까요?',
      status: 'in_progress',
      created_at: ago(26 * 60),
      reply_body: null,
      replied_at: null,
    },
    {
      id: 'd3m0a006-0000-4000-8000-000000000006',
      user_id: 'demo-user-0006',
      user_name: '관광객 한**',
      type: '계정 문의',
      title: '계정 문의',
      content:
        '비밀번호를 바꾸고 싶은데 마이페이지에서 메뉴를 찾지 못했습니다.\n어디서 바꾸는지 알려 주세요.',
      status: 'resolved',
      created_at: ago(2 * 24 * 60),
      reply_body:
        '마이페이지 > 설정 > 비밀번호 변경에서 바꾸실 수 있습니다.\n로그인 화면의 비밀번호 찾기로도 새 비밀번호를 만드실 수 있어요.',
      replied_at: ago(2 * 24 * 60 - 45),
    },
    {
      id: 'd3m0a007-0000-4000-8000-000000000007',
      user_id: 'demo-user-0007',
      user_name: '관광객 오**',
      type: '이용 문의',
      title: '쿠폰 사용 기한 문의',
      content: '받은 쿠폰이 오늘까지라고 되어 있는데 자정까지 쓸 수 있나요?',
      status: 'resolved',
      created_at: ago(3 * 24 * 60),
      reply_body: '쿠폰은 표시된 마감 시각까지 사용하실 수 있습니다. 마이페이지의 쿠폰함에서 남은 시간을 확인해 주세요.',
      replied_at: ago(3 * 24 * 60 - 30),
    },
  ];
}
