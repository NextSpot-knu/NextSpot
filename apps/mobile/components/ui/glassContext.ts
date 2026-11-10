// 유리 컨텍스트 — Glass 가 내리고 Text·Icon 이 읽는다(유리 안 보조 글자색, G2-G03).
// Glass.tsx 에 두지 않는 이유: Text 는 어디서나 쓰여 expo-blur 를 끌어오지 않게 한다.
import { createContext, useContext } from 'react';

import type { GlassTone } from './textStyle';

export const GlassToneContext = createContext<GlassTone>(null);

/** 지금 유리 안인가(light·rail) — 밖이면 null. */
export function useGlassTone(): GlassTone {
  return useContext(GlassToneContext);
}
