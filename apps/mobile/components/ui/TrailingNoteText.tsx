// 한 줄 문구 끝의 괄호 덧붙임을 한 덩어리로 — 웹 TrailingNoteText(G5a-07). 좁은 폰에서 줄이 괄호 한가운데서 갈라지면
// ('…TourAPI (unless' / 'credited otherwise)') 무엇을 덧붙이는지 읽히지 않는다. RN 에는 whitespace-nowrap 이 없어
// 덧붙임 안 공백을 줄바꿈 없는 공백(U+00A0)으로 바꾼다.
import type { TextProps } from 'react-native';

import { splitTrailingNote } from '@/lib/trailingNote';

import { Text } from './Text';

export function TrailingNoteText({ text, ...rest }: Omit<TextProps, 'children'> & { text: string; className?: string }) {
  const { lead, note } = splitTrailingNote(text);
  return (
    <Text {...rest}>
      {lead}
      {note ? <Text>{note.replace(/ /g, ' ')}</Text> : null}
    </Text>
  );
}
