// 앱 밖으로 나가는 링크 — 카카오맵 길안내·장소, 전화, 일반 웹 페이지.
// 웹 원본 apps/web/lib/navigation.ts(기준 커밋 e07ea61)는 window.open 으로 새 탭을 연다. 앱은:
//   - 카카오맵 앱이 깔려 있으면(Linking.canOpenURL) `kakaomap://` 로 연다.
//   - 아니면 https 주소를 expo-web-browser 로 연다(시스템 브라우저 시트 — WebView 를 쓰지 않는다, App Store 4.2).
// canOpenURL 이 참이 되려면 앱 설정이 필요하다: iOS Info.plist LSApplicationQueriesSchemes 에 'kakaomap',
// 안드로이드 11+ AndroidManifest <queries> 에 kakaomap 스킴 VIEW 인텐트(설정 플러그인). 없으면 늘 웹으로 간다(안전한 쪽).
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import { telHref } from '@/lib/phoneLink';
import {
  kakaoDrivingHandoff,
  kakaoPlaceHandoff,
  kakaoWalkingHandoff,
  type KakaoDestination,
  type KakaoHandoff,
  type LatLng,
} from './kakaoLinks';

export type { KakaoDestination, KakaoHandoff, LatLng } from './kakaoLinks';
export { kakaoDrivingHandoff, kakaoPlaceHandoff, kakaoWalkingHandoff } from './kakaoLinks';

export type OpenResult = 'app' | 'browser' | 'failed';

/** http(s) 페이지를 시스템 브라우저 시트로 연다. 그 밖의 스킴은 열지 않는다. */
export async function openExternalUrl(url: string): Promise<OpenResult> {
  if (!/^https?:\/\//i.test(url)) return 'failed';
  try {
    await WebBrowser.openBrowserAsync(url);
    return 'browser';
  } catch {
    try {
      await Linking.openURL(url); // 브라우저 시트를 못 띄우면(드물다) 기본 브라우저 앱으로
      return 'browser';
    } catch {
      return 'failed';
    }
  }
}

/** 앱 스킴을 먼저, 안 되면 웹 주소로. 웹 빌드는 앱 스킴을 건너뛴다 — 브라우저의 canOpenURL 은 늘 참이라 `kakaomap://` 빈 탭만 열린다. */
export async function openKakaoHandoff(handoff: KakaoHandoff): Promise<OpenResult> {
  if (handoff.app && Platform.OS !== 'web') {
    try {
      if (await Linking.canOpenURL(handoff.app)) {
        await Linking.openURL(handoff.app);
        return 'app';
      }
    } catch {
      /* 확인·열기 실패 — 웹으로 */
    }
  }
  return openExternalUrl(handoff.web);
}

export function openWalkingDirections(dest: KakaoDestination, origin?: LatLng | null): Promise<OpenResult> {
  return openKakaoHandoff(kakaoWalkingHandoff(dest, origin));
}

export function openDrivingDirections(dest: KakaoDestination, origin?: LatLng | null): Promise<OpenResult> {
  return openKakaoHandoff(kakaoDrivingHandoff(dest, origin));
}

export async function openKakaoPlace(id: string | number | null | undefined): Promise<OpenResult> {
  const handoff = kakaoPlaceHandoff(id);
  return handoff ? openKakaoHandoff(handoff) : 'failed';
}

export { telHref } from '@/lib/phoneLink';

/** 전화 걸기 — 웹 telHref 와 같은 규칙으로 첫 번호만. 번호가 아니면 'failed'(화면은 글자로만 보여 준다). */
export async function openPhone(phone: string | null | undefined): Promise<'app' | 'failed'> {
  const href = telHref(phone);
  if (!href) return 'failed';
  try {
    await Linking.openURL(href);
    return 'app';
  } catch {
    return 'failed'; // 시뮬레이터·태블릿처럼 전화가 없는 기기
  }
}
