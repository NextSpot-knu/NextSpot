// 가게 사진 신고 · 이 사진 숨기기(계획 M19 — App Store 1.2 사용자 콘텐츠 대비).
//
// 웹에는 없는 앱 전용 행동이다. 신고는 웹 지원 문의 화면(app/mypage/support/page.tsx)과 같은 Supabase `inquiries` 표에 넣는다 —
// RLS 정책 inquiries_insert_own_or_anonymous 가 user_id 를 'NULL 이거나 본인' 으로만 받는다. 표에 가게 id 칸이 없어 본문 첫 줄에
// `facility_id: <id>` 로 적는다(관제의 문의 목록에서 보고 기존 '사진 내리기' 로 처리). 숨기기는 이 기기에만 남는 목록이다.
import type { SupabaseClient } from '@supabase/supabase-js';

import type { KeyValueStore } from './tripLoop';

export const HIDDEN_PHOTOS_KEY = 'nextspot_hidden_photos';
/** 관제 문의 목록의 분류값 — 번역하지 않는다(웹 support 폼 주석과 같은 이유). */
export const PHOTO_REPORT_TYPE = '사진 신고';
const MAX_HIDDEN = 500;

function defaultStore(): KeyValueStore | null {
  try {
    return (globalThis as { localStorage?: KeyValueStore }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadHiddenPhotos(store: KeyValueStore | null = defaultStore()): string[] {
  try {
    const arr = JSON.parse(store?.getItem(HIDDEN_PHOTOS_KEY) ?? '[]');
    return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function save(list: string[], store: KeyValueStore | null): void {
  try { store?.setItem(HIDDEN_PHOTOS_KEY, JSON.stringify(list.slice(-MAX_HIDDEN))); } catch { /* 저장 불가 — 이번 실행 동안만 */ }
}

export function hidePhoto(url: string, store: KeyValueStore | null = defaultStore()): string[] {
  const list = loadHiddenPhotos(store);
  if (!url || list.includes(url)) return list;
  const next = [...list, url];
  save(next, store);
  return next;
}

export function unhidePhoto(url: string, store: KeyValueStore | null = defaultStore()): string[] {
  const next = loadHiddenPhotos(store).filter((u) => u !== url);
  save(next, store);
  return next;
}

/** 숨긴 사진을 뺀 후보. 순서는 지킨다. */
export function withoutHidden(urls: readonly string[], hidden: readonly string[]): string[] {
  if (hidden.length === 0) return [...urls];
  const set = new Set(hidden);
  return urls.filter((u) => !set.has(u));
}

export interface PhotoReportInput {
  facilityId: string;
  facilityName: string;
  photoUrl: string;
  userId: string | null;
  userName: string | null;
}

/** inquiries 한 줄. user_name 은 NOT NULL 이라 익명이어도 값이 필요하다(DB 로 가는 값 — 번역 대상이 아니다). */
export function buildPhotoReportRow(input: PhotoReportInput) {
  return {
    user_id: input.userId,
    user_name: input.userName?.trim() || '익명',
    type: PHOTO_REPORT_TYPE,
    title: `사진 신고: ${input.facilityName}`.slice(0, 120),
    content: [`facility_id: ${input.facilityId}`, `photo_url: ${input.photoUrl}`, `facility_name: ${input.facilityName}`].join('\n'),
    status: 'new',
  };
}

/** 신고 전송. 실패하면 false(오류 문구는 호출부가 말한다). */
export async function reportPhoto(
  client: Pick<SupabaseClient, 'from' | 'auth'>,
  input: Omit<PhotoReportInput, 'userId' | 'userName'>,
): Promise<boolean> {
  try {
    let userId: string | null = null;
    let userName: string | null = null;
    try {
      const { data: { session } } = await client.auth.getSession();
      if (session?.user) {
        userId = session.user.id;
        const meta = session.user.user_metadata as { full_name?: string } | undefined;
        userName = meta?.full_name || session.user.email?.split('@')[0] || null;
      }
    } catch { /* 세션을 모르면 익명 신고(RLS 가 허용하는 유일하게 안전한 값) */ }
    const { error } = await client.from('inquiries').insert([buildPhotoReportRow({ ...input, userId, userName })]);
    return !error;
  } catch {
    return false;
  }
}
