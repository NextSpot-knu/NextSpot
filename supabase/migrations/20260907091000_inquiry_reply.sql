-- =========================================================================
-- inquiries: 관리자 답변 본문을 담을 자리를 만든다
-- =========================================================================
-- 무엇이 깨져 있었나:
--   /admin/support 의 '답변 전송' 은 답변을 어디에도 보내지 않았다. 관리자가 답변을 쓰고
--   버튼을 누르면 프런트는 `PATCH /api/v1/admin/inquiries/{id}` 를 **status='resolved' 하나만**
--   담아 호출했다. 쓴 글은 컴포넌트 state 에서 사라지고 티켓은 닫힌다. 관리자는 답했다고
--   믿고, 문의자는 아무것도 받지 못한다 — 사람 사이의 연락이 조용히 사라지는 종류의 결함이다.
--
--   근본 원인이 스키마에 있었다: 20260531220000 이 만든 inquiries 에는 **답변을 담을 컬럼이
--   아예 없다.** 이후 어떤 마이그레이션도 추가하지 않았다(20260601120000·20260707120000·
--   20260904091000 은 전부 RLS 만 손댔다). 컬럼이 없으니 백엔드 PATCH 모델도 status 만
--   받았고, 화면은 그 사실을 몰라 "답변이 전송되었습니다" 라고 알렸다.
--
-- 무엇을 더하는가:
--   reply_body   — 관리자가 쓴 답변 본문. NULL = 아직 답하지 않음(빈 문자열과 구분한다).
--   replied_at   — 답변이 저장된 시각. 문의자 화면이 "언제 답이 왔는지" 를 말할 근거다.
--   replied_by   — 답한 관리자. ON DELETE SET NULL — 담당자 계정이 지워져도 **답변 본문은
--                  남아야 한다.** 문의자가 이미 읽은 답이 계정 정리 때문에 사라지면 안 된다.
--                  (같은 이유로 CASCADE 를 쓰지 않는다. inquiries.user_id 의 FK 는 계정 삭제
--                   요구를 따르느라 CASCADE 지만(20260825120000), replied_by 는 문의자가 아니라
--                   담당자라 삭제 대상이 아니다.)
--
-- 전달 채널:
--   메일·푸시 인프라가 이 저장소에 없다. 그래서 전달은 **앱 내 표시**다 — 문의자는
--   /mypage/inquiries 에서 자기 문의와 답변을 본다. 그 화면이 있어야 '답변했다' 가 사실이 된다.
--
-- ── RLS: 문의자가 자기 답변을 읽을 수 있는가 ───────────────────────────────
--   읽을 수 있다. 이미 그렇게 돼 있어 새 정책을 만들지 않는다:
--     · 20260707120000 의 select_own_or_admin_inquiries 가
--         FOR SELECT TO authenticated USING (user_id = auth.uid() OR ...admin)
--       이다. RLS 정책은 **행** 단위라 컬럼이 늘어도 그대로 적용된다 — 자기 행이 보이면
--       그 행의 reply_body 도 보인다.
--     · 컬럼 단위 GRANT 는 이 표에 걸려 있지 않다. 20260905090000 이 congestion_logs 에
--       한 REVOKE/GRANT (신원 컬럼 가리기)는 그 표에만 적용된다. 그래서 congestion_logs 와
--       달리 여기서는 "컬럼을 더하면 브라우저에서 안 보인다" 는 함정이 없다.
--   즉 이 파일은 컬럼만 더하면 충분하다. 정책을 '혹시 몰라서' 다시 쓰지 않는 이유는,
--   멀쩡히 도는 정책을 DROP/CREATE 하는 순간 그 사이의 요청이 거부되기 때문이다.
--
--   ⚠️ 남는 한계(정책으로 해결할 수 없다): 세션 없이 접수된 문의는 user_id 가 NULL 이다
--      (20260904091000 이 익명 문의 경로를 그렇게 열어 뒀다). NULL 은 auth.uid() 와 절대
--      같아지지 않으므로 **그 문의의 답변은 앱 안에서 아무도 볼 수 없다.** 관리자 화면이
--      답변 전에 그 사실을 경고한다(app/admin/support/page.tsx). 스키마로 고칠 문제가
--      아니라 '연락처 없는 익명 문의' 라는 접수 방식 자체의 성질이다.
--
-- ── 인덱스 ────────────────────────────────────────────────────────────────
--   /mypage/inquiries 가 `user_id = ? ORDER BY created_at DESC` 로 조회한다. 지금은 PK
--   인덱스뿐이라 전체 스캔이다. 표가 작아 당장은 티가 안 나지만, 이 조회는 사용자가 화면을
--   열 때마다 도는 경로라 처음부터 인덱스를 붙여 둔다.
--
-- 배포 순서 안전성: 이 마이그레이션이 **적용되기 전에도** 백엔드는 정상 동작한다.
--   admin.py 의 _is_missing_reply_columns 폴백이 '컬럼 없음' 오류만 골라내 상태 변경만
--   수행하고 응답으로 reply_saved=false 를 알린다(500 이 아니다). 화면은 그때 "답변 저장은
--   아직 불가" 라고 말한다 — account.py 의 requested_role 폴백과 같은 방식이다.
--
-- 멱등: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS — 재실행해도 안전하다.
-- 적용: Supabase SQL Editor 에 붙여넣어 1회 실행.

alter table public.inquiries
  add column if not exists reply_body text,
  add column if not exists replied_at timestamptz,
  add column if not exists replied_by uuid references public.users(id) on delete set null;

-- '내 문의' 목록 조회 경로(user_id 필터 + 최신순).
create index if not exists inquiries_user_created_idx
    on public.inquiries (user_id, created_at desc);
