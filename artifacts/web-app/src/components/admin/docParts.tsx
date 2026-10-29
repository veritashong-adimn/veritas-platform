/**
 * 고객 문서(견적서·거래명세서) 공통 부품 — 두 문서가 같은 박스·행·표 배지·직인을 쓰도록 한 곳에서 관리한다.
 *  · 직인: 환경설정에 등록된 회사 직인(R2 비공개)을 서버가 권한 확인 후 data URI 로 내려준다(원본 URL 미노출).
 *    공급자 정보 박스 오른쪽 위(상호~연락처 행 오른쪽 빈 공간)에 절대 위치로 놓여 박스 높이를 바꾸지 않는다.
 */
import React, { useEffect, useState } from 'react';
import { ITEM_TYPE_LABEL } from '../../lib/quotePdf';
import { api } from '../../lib/constants';

export const BRAND = '#1e3a5f';
export const BRAND_LIGHT = '#e8edf5';

// 직인 — 약 18mm(A4 794px 기준 1mm ≈ 3.78px), 비율 유지(contain). 위치는 견적서에서 확정한 값(박스 기준 right 14 / top 29)
const SEAL_PX = 68;

/** 문서 출력용 직인. url: undefined = 불러오는 중(인쇄 버튼 대기) / null = 미등록·표시 안 함·실패. error: 조회 실패 안내(화면 전용) */
export function useCompanySeal(): { url: string | null | undefined; error: string | null } {
  const [state, setState] = useState<{ url: string | null | undefined; error: string | null }>({ url: undefined, error: null });
  useEffect(() => {
    let alive = true;
    const token = localStorage.getItem('auth_token') ?? '';
    fetch(api('/api/admin/company-seal/document'), { headers: { Authorization: `Bearer ${token}` } })
      .then(async r => {
        const d = await r.json().catch(() => null);
        if (!alive) return;
        if (!r.ok) setState({ url: null, error: d?.error ?? '직인 정보를 불러오지 못했습니다.' });
        else setState({ url: d?.dataUrl || null, error: d?.error ?? null });
      })
      .catch(() => { if (alive) setState({ url: null, error: '직인 정보를 불러오지 못했습니다.' }); });
    return () => { alive = false; };
  }, []);
  return state;
}

/** 공급자 정보 박스용 직인 이미지(InfoBox aside) — 첫 페이지 상단 블록에만 있으므로 여러 페이지 문서에서도 한 번만 출력된다 */
export function SealImage({ src, testId }: { src: string; testId: string }) {
  return (
    <img src={src} alt="직인" data-testid={testId}
      style={{ position: 'absolute', right: 14, top: 29, width: SEAL_PX, height: SEAL_PX, objectFit: 'contain', mixBlendMode: 'multiply', pointerEvents: 'none' }} />
  );
}

/** 미리보기 툴바의 직인 조회 실패 안내(인쇄 본문에는 포함되지 않음) */
export function SealErrorNotice({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <span data-testid="doc-seal-error" title={error} style={{ color: '#fbbf24', fontSize: 12, fontWeight: 600 }}>
      ⚠ {error} 직인 없이 출력됩니다.
    </span>
  );
}

export function InfoBox({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '10px 12px', position: 'relative' }}>
      {aside}
      <div style={{
        fontSize: 10, fontWeight: 800, color: BRAND, letterSpacing: 0.5,
        marginBottom: 7, paddingBottom: 5, borderBottom: `1.5px solid ${BRAND_LIGHT}`,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

// 공급자·수신자 박스 공통 행 — 항목 순서·행 간격·글자 크기·정렬을 양쪽 동일하게 유지. 담당자 행은 수신자만(showContact).
//  omitEmptyContact: 담당자·연락처·이메일 값이 없으면 행을 숨긴다(거래명세서 수신자). 기본값은 공란 행 유지(견적서).
export function PartyRows({ companyName, businessNumber, representative, contactName, phone, email, address, showContact = true, omitEmptyContact = false }: {
  companyName?: string; businessNumber?: string; representative?: string; contactName?: string;
  phone?: string; email?: string; address?: string; showContact?: boolean; omitEmptyContact?: boolean;
}) {
  const shown = (v?: string) => !omitEmptyContact || !!v?.trim();
  return (
    <>
      <InfoRow label="상호"       value={companyName    || ''} />
      <InfoRow label="사업자번호" value={businessNumber || ''} />
      <InfoRow label="대표자"     value={representative || ''} />
      {showContact && shown(contactName) && <InfoRow label="담당자"     value={contactName    || ''} />}
      {shown(phone) && <InfoRow label="연락처"     value={phone          || ''} />}
      {shown(email) && <InfoRow label="이메일"     value={email          || ''} />}
      {/* 긴 주소는 InfoRow 가 단어 단위로 자동 줄바꿈 */}
      <InfoRow label="주소"       value={address        || ''} />
    </>
  );
}

export function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 2, lineHeight: '16px' }}>
      <span style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, minWidth: 70, flexShrink: 0, lineHeight: '16px' }}>
        {label}
      </span>
      <span style={{
        fontSize: 11, color: '#111827', fontWeight: 500, lineHeight: '16px', // 행 높이 고정 — 공란 행과 값 있는 행의 간격 동일
        // 인쇄 시 주소·숫자 단위(예: "2406호")가 중간에서 끊기지 않도록:
        // keep-all → 공백 단위로만 줄바꿈(동·호 등 토큰 유지), break-word → 박스 초과 시에만 예외 처리.
        // (break-all 금지 — 숫자 중간 분리의 원인. 지시문 §3·§4)
        minWidth: 0,
        whiteSpace: 'normal',
        wordBreak: 'keep-all',
        overflowWrap: 'break-word',
        ...(mono ? { fontFamily: 'monospace', fontSize: 10 } : {}),
      }}>
        {value}
      </span>
    </div>
  );
}

export function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 11, borderBottom: '1px solid #f1f5f9' }}>
      <span style={{ color: '#6b7280', fontWeight: 600 }}>{label}</span>
      <span style={{ color: '#111827', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

export function ItemTypeBadge({ type }: { type: string }) {
  const colors: Record<string, { bg: string; color: string }> = {
    translation:    { bg: '#dbeafe', color: '#1d4ed8' },
    interpretation: { bg: '#dcfce7', color: '#15803d' },
    equipment:      { bg: '#fef3c7', color: '#b45309' },
    expense:        { bg: '#f3f4f6', color: '#6b7280' },
    discount:       { bg: '#fee2e2', color: '#dc2626' },
  };
  const c = colors[type] ?? colors.expense;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 5px', borderRadius: 4,
      background: c.bg, color: c.color, fontSize: 9, fontWeight: 700,
    }}>
      {ITEM_TYPE_LABEL[type] ?? type}
    </span>
  );
}
