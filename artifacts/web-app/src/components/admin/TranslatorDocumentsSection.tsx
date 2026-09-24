import React from "react";
import { EntityDocumentsSection, type PendingDoc } from "./EntityDocumentsSection";

// ─────────────────────────────────────────────────────────────────────────────
// TranslatorDocumentsSection — 통번역사 서류관리(§2·§8). 공통 EntityDocumentsSection 의 얇은 래퍼.
//  · 통번역사 도메인 엔드포인트(/api/admin/translators/:id/documents)만 주입한다. (translatorId = users.id)
//  · 기존 이력서/신분증/통장사본(GCS)과는 별개 SSOT(translator_documents, R2). 소유관계를 섞지 않는다.
//  · 이력서는 새 파일을 등록해도 과거 서류를 덮어쓰지 않고 각각 별도 행으로 이력 보존한다(§6).
// ─────────────────────────────────────────────────────────────────────────────

// 선택형 문서종류(직접입력 허용). 값=표시 라벨(varchar 자유값). "직접입력…"은 공통 컴포넌트가 자동 추가.
export const TRANSLATOR_DOC_TYPE_OPTIONS = [
  { value: "이력서", label: "이력서" },
  { value: "신분증", label: "신분증" },
  { value: "통장사본", label: "통장사본" },
  { value: "약관", label: "약관" },
  { value: "통역사 준수서약서", label: "통역사 준수서약서" },
  { value: "학위/졸업증명서", label: "학위/졸업증명서" },
  { value: "NDA/보안서약서", label: "NDA/보안서약서" },
  { value: "계약서", label: "계약서" },
  { value: "대리수급동의서", label: "대리수급동의서" },
  { value: "기타", label: "기타" },
];

// 신규 등록 단계에서 메모리에 보관하는 문서(공통 타입 재사용).
export type PendingTranslatorDoc = PendingDoc;

export function TranslatorDocumentsSection({
  translatorId, token, onToast, canEdit = true, compact = false,
  pendingMode = false, pendingDocs, onPendingDocsChange,
}: {
  /** live 모드에서 필수(= users.id). pending 모드에서는 무시. */
  translatorId?: number | null;
  token: string;
  onToast: (msg: string) => void;
  canEdit?: boolean;
  compact?: boolean;
  pendingMode?: boolean;
  pendingDocs?: PendingTranslatorDoc[];
  onPendingDocsChange?: (docs: PendingTranslatorDoc[]) => void;
}) {
  return (
    <EntityDocumentsSection
      docsBaseUrl={translatorId ? `/api/admin/translators/${translatorId}/documents` : undefined}
      docTypeOptions={TRANSLATOR_DOC_TYPE_OPTIONS}
      defaultDocType="이력서"
      title="서류관리"
      token={token}
      onToast={onToast}
      canEdit={canEdit}
      compact={compact}
      pendingMode={pendingMode}
      pendingDocs={pendingDocs}
      onPendingDocsChange={onPendingDocsChange}
    />
  );
}

export default TranslatorDocumentsSection;
