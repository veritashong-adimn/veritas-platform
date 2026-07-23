/**
 * CompanyCreatePage — 거래처 등록 화면 (/admin/companies/new).
 *
 * 목록과 분리된 독립 페이지. 입력은 공통 CompanyForm(mode="create")을 사용한다.
 * - 취소  → 거래처 관리(목록)으로 이동
 * - 등록 완료 → 거래처 상세로 이동 (상세 모달 열기)
 */
import React from 'react';
import { PageHeader } from './PageHeader';
import { dsStickyPageHeader } from '../../lib/ds';
import { CompanyForm } from './CompanyForm';

interface CompanyCreatePageProps {
  token: string;
  onToast: (msg: string) => void;
  /** 취소 → 목록 */
  onCancel: () => void;
  /** 등록 완료 → 상세로 이동 */
  onCreated: (companyId: number) => void;
  /** 유사 거래처 상세보기 */
  onOpenCompany?: (id: number) => void;
  onOpenTranslator?: (userId: number, email: string) => void;
}

export function CompanyCreatePage({ token, onToast, onCancel, onCreated, onOpenCompany, onOpenTranslator }: CompanyCreatePageProps) {
  return (
    <div style={{ background: '#f9fafb', minHeight: '100vh' }}>
      <PageHeader
        onBack={onCancel}
        backLabel="목록"
        testId="btn-company-create-back"
        title="거래처 등록"
        style={dsStickyPageHeader()}
      />
      {/* 독립 페이지: 목록과 동일한 컨텐츠 폭(width 100%). 팝업식 중앙 max-width 박스를 쓰지 않는다. */}
      <div style={{ padding: '20px 0 64px', width: '100%' }}>
        <CompanyForm
          mode="create"
          token={token}
          onToast={onToast}
          onSaved={(c) => onCreated(c.id)}
          onCancel={onCancel}
          onOpenCompany={onOpenCompany}
          onOpenTranslator={onOpenTranslator}
        />
      </div>
    </div>
  );
}
