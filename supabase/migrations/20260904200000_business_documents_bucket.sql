-- 사업자등록증 증빙 업로드 — 비공개 버킷과 그 접근 규칙.
--
-- 배경: business_verification_requests.document_path 칼럼과, 심사가 끝나면 그 파일을 지우는
-- 코드(app/routers/dev.py _clear_evidence)는 예전부터 있었다. 그런데 **버킷 자체가 없었고,
-- 프런트에 업로드 경로도 없었다.** 즉 신청자는 서류를 낼 방법이 없었고, 심사자는 신청서에
-- 적힌 가게 이름과 facility_id 를 대조할 근거가 없었다(그 facility_id 는 신청자가 본문에
-- 적어 보낸 값이라 아무도 검증하지 않는다).
--
-- 보관 정책은 기존 결정을 그대로 따른다: **확인이 끝나면 보관하지 않는다.** 승인이든 반려든
-- 결정과 같은 호출에서 파일과 사업자번호 뒤 4자리를 지운다(dev.py). 그래서 이 버킷은
-- 장기 보관소가 아니라 심사 대기열의 임시 첨부다.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'business-documents',
    'business-documents',
    false,                                   -- 공개 URL 없음. 심사자는 서명 URL 로만 본다.
    5242880,                                 -- 5MB. 휴대폰으로 찍은 등록증 한 장이면 충분하다.
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 업로드는 **자기 폴더에만**. 경로는 '<uid>/<파일명>' 규약이고 첫 세그먼트를 auth.uid() 와
-- 대조한다. 이게 없으면 로그인한 누구나 남의 uid 폴더에 파일을 올려, 그 사람의 신청서에
-- 붙은 증빙인 것처럼 보이게 만들 수 있다.
DROP POLICY IF EXISTS business_documents_insert_own ON storage.objects;
CREATE POLICY business_documents_insert_own ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'business-documents'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

-- 자기가 올린 것만 다시 볼 수 있다(업로드가 됐는지 확인하는 용도).
-- 심사자(developer)는 이 정책으로 보지 않는다 — 백엔드가 service_role 로 서명 URL 을 만든다.
-- service_role 은 RLS 를 우회하므로 별도 정책이 필요 없다.
DROP POLICY IF EXISTS business_documents_select_own ON storage.objects;
CREATE POLICY business_documents_select_own ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'business-documents'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

-- 지우는 것은 서버만 한다(심사 종료 시 _clear_evidence). 신청자가 임의로 지우면 심사자가
-- 보던 근거가 심사 도중 사라진다 — DELETE 정책을 일부러 두지 않는다.
