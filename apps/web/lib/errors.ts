// catch 절 에러에서 사용자에게 보여줄 메시지를 안전하게 꺼내는 헬퍼.
//
// 배경: tsconfig 가 strict 라 `catch (err)` 의 err 는 `unknown` 이다(TS 4.4+ 의
// useUnknownInCatchVariables). 그동안 이걸 `catch (err: any)` 로 눌러서 `err?.message` 를
// 그냥 읽었는데, 이건 두 가지를 놓친다:
//   1) throw 되는 게 항상 Error 는 아니다. 문자열·객체·undefined 도 throw 될 수 있고,
//      그때 `err.message` 는 undefined 라 사용자에게 빈 메시지가 나간다.
//   2) any 라서 `err.mesage` 같은 오타를 컴파일러가 못 잡는다.
//
// 이 저장소의 에러 클래스(ApiError·MerchantApiError 등)는 모두 Error 를 상속하므로
// instanceof 경로로 걸린다. 그 외 타입은 문자열화하되, 의미 없는 "[object Object]" 는
// 사용자에게 보여줄 값이 아니므로 undefined 를 돌려 호출부의 폴백 문구가 뜨게 한다.

/**
 * 사용자에게 노출할 에러 메시지. 뽑아낼 게 없으면 undefined —
 * 호출부에서 `errorMessage(err) || '잠시 후 다시 시도해 주세요.'` 처럼 폴백과 함께 쓴다.
 */
export function errorMessage(err: unknown): string | undefined {
  if (err instanceof Error) return err.message || undefined;
  if (typeof err === "string") return err || undefined;
  // 문자열도 Error 도 아닌 값(숫자·null·평범한 객체 등)은 그대로 보여주면 소음이다.
  return undefined;
}
