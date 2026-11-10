// /explore/recommend — 대기 보드·지도에서 눌러 온 장소의 '대신 갈 만한 곳'(웹 app/explore/recommend/page.tsx).
// 탭 안 숨은 경로(app/(tabs)/_layout 의 href: null)라 하단 탭 막대가 보이고 활성은 '홈'이다(G2-G02). 머리(스택 헤더)는 없다 —
// 웹처럼 화면 안의 원형 '지도 보기' 버튼이 대신한다(G4a-15, D3). 구현은 features/explore.
export { default } from '~/features/explore/RecommendScreen';
