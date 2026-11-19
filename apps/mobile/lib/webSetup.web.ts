// 웹 전용 준비 — index.ts 가 라우터보다 먼저 싣는다. 네이티브 쪽 파일(webSetup.ts)은 비어 있다.
//
// ① 넓은 화면 기둥: 데스크톱 브라우저에서 앱을 폰 폭 기둥으로 그린다 — body 를 가운데 기둥으로 만드는 CSS 를 싣고(첫 렌더 전),
// 화면 코드가 보는 창 폭도 기둥 폭으로 맞춘다.
// 그러지 않으면 useWindowDimensions 가 1440 같은 창 폭을 돌려줘 코스(좌우 분할)·대안(두 열)·시트(좌우 여백)가
// 태블릿 배치로 바뀐다. react-native-web 의 Dimensions 는 visualViewport 를 읽으므로 get 과 change 이벤트를 감싼다.
// 규칙(숫자·판정)은 webFrameCore.ts 한 곳.
// ③ 글자: 한국어 낱말 단위 줄바꿈·ja·zh 금칙·입력칸 포커스 외곽선·가짜 굵게 끄기 CSS(webTypographyCore.ts)와 첫 <html lang>.
import { Alert, Dimensions, type AlertButton, type AlertOptions } from 'react-native';

import { applyDocumentLang } from './i18n/documentLang';
import { LOCALE_STORAGE_KEY, isLocale } from './i18n/initialLocale';
import { colors } from './theme/tokens';
import { framedWindow, webFrameCss, type WindowSize } from './webFrameCore';
import { pickAlertButtons } from './webAlertCore';
import { webTypographyCss } from './webTypographyCore';

type DimensionsValue = { window: WindowSize; screen: WindowSize };
type Handler = (dims: DimensionsValue) => void;

const target = Dimensions as unknown as {
  get: (key: 'window' | 'screen') => WindowSize;
  addEventListener: (type: string, handler: Handler) => { remove: () => void };
  removeEventListener: (type: string, handler: Handler) => void;
  __nextspotFramed?: boolean;
};

if (typeof document !== 'undefined' && !target.__nextspotFramed) {
  target.__nextspotFramed = true;

  // 웹 출력은 한 페이지(app.json web.output 'single')라 app/+html.tsx 를 쓰지 않는다 — 여기서 <head> 에 싣는다.
  const style = document.createElement('style');
  style.id = 'nextspot-web-frame';
  style.textContent = webFrameCss({ page: colors.hanji, outside: colors['hanji-deep'] }) + webTypographyCss();
  document.head.appendChild(style);

  // 기본 템플릿이 <html lang="en"> 이다 — 첫 렌더 전에 저장된 언어(없으면 ko)로. 기기 언어로 고르는 경우와 언어 바꾸기는
  // I18nProvider 가 다시 맞춘다(documentLang.ts). keep-all·금칙 CSS(webTypographyCore.ts)가 이 값으로 걸린다(G2-G06).
  let saved: string | null = null;
  try {
    saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    /* 저장소를 못 읽으면 ko */
  }
  applyDocumentLang(isLocale(saved) ? saved : 'ko');

  // 같은 원본이면 같은 결과 객체를 돌려준다 — 매 호출 새 객체면 useWindowDimensions 가 쓸데없이 다시 그린다.
  let lastSource: WindowSize | null = null;
  let lastFramed: WindowSize | null = null;
  const frame = (window: WindowSize): WindowSize => {
    if (window !== lastSource) {
      lastSource = window;
      lastFramed = framedWindow(window);
    }
    return lastFramed as WindowSize;
  };

  const originalGet = target.get.bind(Dimensions);
  target.get = (key) => (key === 'window' ? frame(originalGet('window')) : originalGet(key));

  const originalAdd = target.addEventListener.bind(Dimensions);
  const originalRemove = target.removeEventListener.bind(Dimensions);
  const wrapped = new Map<Handler, Handler>();
  target.addEventListener = (type, handler) => {
    const inner: Handler = (dims) => handler({ ...dims, window: frame(dims.window) });
    wrapped.set(handler, inner);
    originalAdd(type, inner);
    return { remove: () => target.removeEventListener(type, handler) };
  };
  target.removeEventListener = (type, handler) => {
    originalRemove(type, wrapped.get(handler) ?? handler);
    wrapped.delete(handler);
  };
}

// ② 대화상자: react-native-web 의 Alert.alert 는 아무것도 하지 않는다 — 저장 전체 삭제·데이터 삭제 확인, 외부 AI 해석 동의(답을
// 기다리는 Promise 가 영영 풀리지 않는다), 사진 신고, 위치 거부 안내가 눌러도 반응이 없었다. 브라우저 기본 창으로 대신한다.
// 버튼 고르기 규칙은 webAlertCore.ts(테스트 있음).
Alert.alert = (title: string, message?: string, buttons?: AlertButton[], options?: AlertOptions) => {
  const text = [title, message].filter(Boolean).join('\n\n');
  const pick = pickAlertButtons(buttons ?? [], options);
  if (pick.kind === 'notice') {
    window.alert(text);
    pick.onClose?.();
    return;
  }
  if (window.confirm(text)) pick.onConfirm?.();
  else pick.onCancel?.();
};
