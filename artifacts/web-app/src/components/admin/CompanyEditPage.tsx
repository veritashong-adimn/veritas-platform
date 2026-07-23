/**
 * CompanyEditPage — 거래처 수정 화면 (/admin/companies/:id/edit).
 *
 * 등록과 동일한 공통 CompanyForm(mode="edit")을 사용한다. 초기값·이전 상호를 서버에서
 * 로드해 폼에 주입한다.
 * - 취소  → 거래처 상세로 이동
 * - 저장  → 거래처 상세로 이동
 */
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/constants';
import { PageHeader } from './PageHeader';
import { dsStickyPageHeader } from '../../lib/ds';
import { CompanyForm, companyToFormValues, type CompanyFormValues } from './CompanyForm';

interface CompanyEditPageProps {
  companyId: number;
  token: string;
  onToast: (msg: string) => void;
  /** 취소 → 상세 */
  onCancel: () => void;
  /** 저장 완료 → 상세 */
  onSaved: (companyId: number) => void;
}

export function CompanyEditPage({ companyId, token, onToast, onCancel, onSaved }: CompanyEditPageProps) {
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<CompanyFormValues | null>(null);
  const [vendorTypeCustom, setVendorTypeCustom] = useState('');
  const [originalName, setOriginalName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(api(`/api/admin/companies/${companyId}`), { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json();
        if (!alive) return;
        if (!res.ok) { setError(data?.error ?? '거래처 정보를 불러오지 못했습니다.'); return; }
        const { values: v, vendorTypeCustom: vtc } = companyToFormValues(data);
        setValues(v);
        setVendorTypeCustom(vtc);
        setOriginalName(data?.name ?? '');
      } catch { if (alive) setError('거래처 정보 불러오기 실패'); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [companyId, token]);

  return (
    <div style={{ background: '#f9fafb', minHeight: '100vh' }}>
      <PageHeader
        onBack={onCancel}
        backLabel="상세"
        testId="btn-company-edit-back"
        title="거래처 수정"
        subtitle={originalName || undefined}
        style={dsStickyPageHeader()}
      />
      {/* 독립 페이지: 목록과 동일한 컨텐츠 폭(width 100%). 팝업식 중앙 max-width 박스를 쓰지 않는다. */}
      <div style={{ padding: '20px 0 64px', width: '100%' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '48px 0', color: '#9ca3af', fontSize: 14 }}>불러오는 중...</div>
        ) : error ? (
          <div style={{ textAlign: 'center', padding: '48px 0', color: '#dc2626', fontSize: 14 }}>{error}</div>
        ) : values ? (
          <CompanyForm
            mode="edit"
            companyId={companyId}
            token={token}
            onToast={onToast}
            initialValues={values}
            initialVendorTypeCustom={vendorTypeCustom}
            originalName={originalName}
            onSaved={(c) => onSaved(c.id)}
            onCancel={onCancel}
          />
        ) : null}
      </div>
    </div>
  );
}
