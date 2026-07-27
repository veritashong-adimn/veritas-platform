import { AliasSection } from "./AliasSection";

// ─── 거래처 기업명 Alias(별칭) 관리 ──────────────────────────────────────────
// 공용 AliasSection 의 얇은 래퍼. 거래처 전용 엔드포인트·라벨만 고정하고
// 나머지 UI/UX·동작(bound/draft 모드)은 AliasSection 과 100% 동일하다.
//   - bound 모드 : companyId 지정 → /api/admin/companies/:id/aliases 서버 CRUD
//   - draft 모드 : companyId 미지정 + value/onChange → 로컬 문자열 목록(등록 화면)
export function CompanyAliasSection({ companyId, token, onToast, value, onChange, compact }: {
  /** 지정 시 bound(서버 CRUD) 모드, 미지정 시 draft(로컬) 모드 */
  companyId?: number;
  token: string;
  onToast: (msg: string) => void;
  /** draft 모드 전용: 별칭 문자열 목록(제어 컴포넌트) */
  value?: string[];
  onChange?: (names: string[]) => void;
  /** 등록/수정 폼용 간결 모드 */
  compact?: boolean;
}) {
  return (
    <AliasSection
      basePath={companyId != null ? `/api/admin/companies/${companyId}` : undefined}
      token={token}
      onToast={onToast}
      value={value}
      onChange={onChange}
      compact={compact}
      headerLabel="기업명 Alias"
      testId="company-alias-section"
    />
  );
}

export default CompanyAliasSection;
