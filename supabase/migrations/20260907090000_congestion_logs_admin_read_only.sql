-- 관리자·개발자의 congestion_logs 직접 쓰기를 막는다 (읽기만 남긴다).
--
-- 무엇이 문제였나: `admin_all_logs` 가 `FOR ALL TO authenticated` 였다. SELECT 뿐 아니라
-- INSERT/UPDATE/DELETE 다. 그래서 `role='admin'` 계정은 번들에 들어 있는 anon 키와 자기
-- JWT 만으로 브라우저에서 `congestion_logs` 에 `evidence_tier='verified'` 행을 직접 넣거나,
-- 이미 있는 행을 verified 로 UPDATE 할 수 있었다.
--
-- 왜 그게 나쁜가: `evidence_tier='verified'` 는 **모델 학습의 정답**이다(scripts/train.py 가
-- {verified, corroborated} 를 학습 데이터로 쓴다). 그래서 이 저장소는 관리자 슬라이더로 넣는
-- 값조차 `single_report` 로 낮춰 두었는데(app/routers/admin.py `_ADMIN_OVERRIDE_SOURCE`),
-- **같은 사람이 그 강등을 우회하는 직접 쓰기 경로를 그대로 갖고 있었다.** 강등에 의미가 없었다.
--
-- 그리고 admin 은 이제 내부 팀 권한이 아니다 — 신청·심사로 부여되는 **외부 관제 담당자**
-- 자리다(20260827140000). 외부인에게 학습 정답을 직접 쓰게 둘 이유가 없다.
--
-- 무엇이 바뀌나: 관리자 화면의 쓰기 경로는 전부 우리 API 를 거친다
-- (`POST /admin/congestion-override` → service_role). service_role 은 RLS 를 우회하므로
-- 이 변경의 영향을 받지 않는다. 즉 화면 동작은 그대로이고, **브라우저에서 직접 쓰는 경로만**
-- 사라진다.
--
-- 되돌리려면: 아래 정책을 다시 `FOR ALL` 로 만들면 된다(권장하지 않는다).

DROP POLICY IF EXISTS admin_all_logs ON public.congestion_logs;

-- 이름을 바꾼다 — `all` 이 아니게 됐으므로 이름이 계속 `admin_all_logs` 면 다음 사람이
-- 정책 목록만 보고 여전히 전권인 줄 안다.
DROP POLICY IF EXISTS admin_read_logs ON public.congestion_logs;
CREATE POLICY admin_read_logs ON public.congestion_logs FOR SELECT TO authenticated
    USING (public.is_admin_or_dev());
