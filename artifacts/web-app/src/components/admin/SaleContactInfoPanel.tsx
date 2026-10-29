// ─── 과거 CRM 판매건 고객 담당자 연락처(출처 구분) ─────────────────────────────────
// 판매 당시 원본(진행관리표) 연락처와 현재 담당자 Master 연락처를 나눠 보여 준다. 둘이 달라도 어느 쪽도 지우거나 덮어쓰지 않는다.
// 확인된 값만 표시하고 없으면 '-'. 내부 화면 전용(고객용 PDF 에는 쓰지 않음).
import React from 'react';

export type SourcePhone = { raw: string; number: string; type: 'mobile' | 'landline' | 'rep' | 'unknown'; shared: 'company_rep' | 'shared_in_company' | 'shared_cross_company' | null };
export type ContactInfo = {
  restoredName: string | null; sourcePhones: SourcePhone[];
  sourceEmails?: string[]; companyEmail?: string | null;
  effectiveEmail?: string | null; effectiveEmailFrom?: 'master' | 'source' | 'company' | null;
  effectivePhone?: string | null; effectivePhoneFrom?: 'master' | 'source' | null;
  linked: { id: number; name: string; position: string | null; department: string | null; phone: string | null; mobile: string | null; officePhone: string | null; email: string | null } | null;
  linkVia: string | null; candidate: ContactInfo['linked']; nameMismatch: boolean; phoneMatchesMaster: boolean | null;
};

const TYPE_LABEL: Record<SourcePhone['type'], string> = { mobile: '휴대전화', landline: '일반전화', rep: '대표번호', unknown: '유형 불명' };
const SHARED_LABEL: Record<NonNullable<SourcePhone['shared']>, string> = {
  company_rep: '거래처 대표번호', shared_in_company: '공용번호(같은 거래처 여러 담당자)', shared_cross_company: '다른 거래처에서도 쓰인 번호',
};
const VIA_LABEL: Record<string, string> = {
  auto_name_phone: '자동 연결(거래처·이름·연락처 일치)', auto_samename_phone: '자동 연결(동명 중 개인번호로 식별)',
  manual: '직원 연결', project: '운영 판매 담당자',
};

// 표시 전용 하이픈(저장값 불변) — 숫자만 저장된 Master 번호를 원본 번호와 같은 형태로 보여 준다
export function fmtPhone(v: string | null | undefined): string {
  const d = String(v ?? '').replace(/\D/g, '');
  if (!d) return v ? String(v) : '';
  if (/^02\d{7,8}$/.test(d)) return d.length === 9 ? `02-${d.slice(2, 5)}-${d.slice(5)}` : `02-${d.slice(2, 6)}-${d.slice(6)}`;
  if (/^0\d{9,10}$/.test(d)) return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  return String(v);
}

const SRC_LABEL: Record<string, string> = { master: '담당자 Master', source: '과거 CRM 원본', company: '거래처 Master' };

const row = (label: string, value: React.ReactNode, testId?: string) => (
  <>
    <span style={{ color: '#6b7280' }}>{label}</span>
    <span data-testid={testId} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{value ?? '-'}</span>
  </>
);

export function SaleContactInfoPanel({ companyName, info }: { companyName: string | null; info: ContactInfo }) {
  const m = info.linked;
  const tag = (t: string, color = '#6b7280') => <span style={{ marginLeft: 6, fontSize: 11, color }}>{t}</span>;
  // 업무 화면 기본 표시 — 담당자 연락처·이메일은 서버가 정한 값(담당자 Master → 과거 CRM 원본 → 거래처 이메일)
  return (
    <div data-testid="sale-contact-info" style={{ fontSize: 13 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '5px 10px' }}>
        {row('거래처', companyName || '-')}
        {row('고객 담당자명', info.restoredName ?? m?.name ?? '-', 'sci-name')}
        {row('담당자 연락처', fmtPhone(info.effectivePhone) || '-', 'sci-phone')}
        {row('담당자 이메일', info.effectiveEmail || '-', 'sci-email')}
        {row('Master 연결', m ? <><b>{m.name}</b>{tag(VIA_LABEL[info.linkVia ?? ''] ?? '연결됨')}</> : <span style={{ color: '#9ca3af' }}>미연결</span>, 'sci-link')}
        {info.nameMismatch && (
          <span style={{ gridColumn: 'span 2', fontSize: 12, color: '#b91c1c' }} data-testid="sci-name-mismatch">
            연결된 Master 이름({m?.name})이 원본 고객명({info.restoredName})과 다릅니다 — 연결을 확인하세요.
          </span>
        )}
      </div>
      {/* 출처 상세 — 원본·Master·거래처 값은 그대로 보존되어 있고 필요할 때만 펼쳐 본다 */}
      <details style={{ marginTop: 8 }} data-testid="sci-source-detail">
        <summary style={{ cursor: 'pointer', fontSize: 12, color: '#6b7280' }}>출처 상세</summary>
        <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '4px 10px', marginTop: 6, fontSize: 12 }}>
          {row('원본 전화(판매 당시)', info.sourcePhones.length ? info.sourcePhones.map(p => (
            <div key={p.number}>{p.raw}{tag(p.shared ? SHARED_LABEL[p.shared] : TYPE_LABEL[p.type])}</div>
          )) : '-', 'sci-source-phone')}
          {row('원본 이메일', info.sourceEmails?.length ? info.sourceEmails.join(', ') : '-', 'sci-source-email')}
          {row('Master 휴대전화', fmtPhone(m?.mobile) || '-', 'sci-master-mobile')}
          {row('Master 일반전화', fmtPhone(m?.phone || m?.officePhone) || '-', 'sci-master-phone')}
          {row('Master 이메일', m?.email || '-', 'sci-master-email')}
          {row('거래처 이메일', info.companyEmail || '-', 'sci-company-email')}
          {row('사용 중인 값', <span style={{ color: '#6b7280' }}>
            연락처 {SRC_LABEL[info.effectivePhoneFrom ?? ''] ?? '-'} · 이메일 {SRC_LABEL[info.effectiveEmailFrom ?? ''] ?? '-'}
          </span>)}
          {m && info.phoneMatchesMaster === false && info.sourcePhones.length > 0 && (
            <span style={{ gridColumn: 'span 2', color: '#92400e' }} data-testid="sci-phone-differs">판매 당시 번호와 현재 Master 번호가 다릅니다 — 두 값을 모두 보존합니다.</span>
          )}
        </div>
      </details>
    </div>
  );
}
