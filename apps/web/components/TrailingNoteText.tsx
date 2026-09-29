import { splitTrailingNote } from "@/lib/trailingNote";

/**
 * 한 줄 문구를 그리되 끝의 괄호 덧붙임은 한 덩어리로 둔다 — 좁은 폰에서 줄이 괄호 앞에서만 바뀐다
 * ('… TourAPI' / '(unless credited otherwise)'). 덧붙임이 없으면 문구 그대로.
 */
export function TrailingNoteText({ text }: { text: string }) {
  const { lead, note } = splitTrailingNote(text);
  if (!note) return <>{text}</>;
  return (
    <>
      {lead}
      <span className="whitespace-nowrap">{note}</span>
    </>
  );
}
