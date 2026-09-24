import React from "react";
import { EntityDocumentsSection, type PendingDoc } from "./EntityDocumentsSection";

// ─────────────────────────────────────────────────────────────────────────────
// VendorDocumentsSection — 외주업체 서류관리(§8). 공통 EntityDocumentsSection 의 얇은 래퍼로,
// 외주업체 도메인 엔드포인트(/api/admin/companies/:id/documents)와 FK(vendorProfileId)만 주입한다.
// 외부 API(props/export)는 기존과 동일하게 유지한다.
// ─────────────────────────────────────────────────────────────────────────────

// 선택형 문서종류(직접입력 허용). 값=표시 라벨(varchar 자유값). "직접입력…"은 공통 컴포넌트가 자동 추가.
export const VENDOR_DOC_TYPE_OPTIONS = [
  { value: "사업자등록증", label: "사업자등록증" },
  { value: "통장사본", label: "통장사본" },
  { value: "보안/NDA", label: "보안/NDA" },
  { value: "회사소개서", label: "회사소개서" },
  { value: "인증서", label: "인증서" },
  { value: "허가서", label: "허가서" },
  { value: "계약서", label: "계약서" },
  { value: "기타", label: "기타" },
];

// 신규 등록 단계에서 메모리에 보관하는 문서(공통 타입 재사용).
export type PendingVendorDoc = PendingDoc;

export function VendorDocumentsSection({
  companyId, token, onToast, vendorProfileId, canEdit = true, compact = false,
  pendingMode = false, pendingDocs, onPendingDocsChange,
}: {
  /** live 모드에서 필수. pending 모드에서는 무시(null 허용). */
  companyId?: number | null;
  token: string;
  onToast: (msg: string) => void;
  vendorProfileId?: number | null;
  canEdit?: boolean;
  compact?: boolean;
  pendingMode?: boolean;
  pendingDocs?: PendingVendorDoc[];
  onPendingDocsChange?: (docs: PendingVendorDoc[]) => void;
}) {
  return (
    <EntityDocumentsSection
      docsBaseUrl={companyId ? `/api/admin/companies/${companyId}/documents` : undefined}
      docTypeOptions={VENDOR_DOC_TYPE_OPTIONS}
      defaultDocType="사업자등록증"
      title="외주업체 서류"
      token={token}
      onToast={onToast}
      canEdit={canEdit}
      compact={compact}
      extraRegisterFields={{ vendorProfileId: vendorProfileId ?? null }}
      pendingMode={pendingMode}
      pendingDocs={pendingDocs}
      onPendingDocsChange={onPendingDocsChange}
    />
  );
}

export default VendorDocumentsSection;
