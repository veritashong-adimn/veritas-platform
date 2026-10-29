// ─── 과거 CRM 전환 견적 — 원본 총액(공급가·부가세 구분 없음) 안내 ─────────────────────
// 편집 화면의 부가세는 화면 계산값이다. 원본 총액과 다른 금액으로 저장하려 하면 서버가 확인을 요구한다(LEGACY_VAT_UNCONFIRMED).
// 내부 화면 전용 — 고객용 견적서·거래명세서에는 출력하지 않는다.
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/constants';

export function LegacyVatNotice({ quoteId, token }: { quoteId: number; token: string }) {
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => {
    fetch(api(`/api/admin/quotes/${quoteId}`), { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => setPrice(d?.legacyOrigin?.taxBreakdown === 'unknown' ? Number(d.price ?? 0) : null))
      .catch(() => setPrice(null));
  }, [quoteId, token]);
  if (price == null) return null;
  return (
    <div data-testid="legacy-vat-notice" style={{ padding: '10px 14px', marginBottom: 12, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, fontSize: 13, color: '#92400e', lineHeight: 1.6 }}>
      과거 CRM 원본 총액 <b>{Math.round(price).toLocaleString()}원</b> — 원본에 공급가·부가세 구분이 없어 <b>부가세 포함 여부 확인이 필요</b>합니다.
      편집 화면의 부가세는 계산값이며, 원본 총액과 다른 금액으로 저장하려면 확인 절차를 거칩니다(고객 문서는 저장된 금액으로 출력).
    </div>
  );
}

/** 저장 응답이 원본 총액 확인 요구(LEGACY_VAT_UNCONFIRMED)면 직원 확인을 받아 true 를 돌려준다 */
export async function confirmLegacyVatChange(data: { code?: string; error?: string }, confirmFn: (msg: string) => Promise<boolean>): Promise<boolean> {
  if (data?.code !== 'LEGACY_VAT_UNCONFIRMED') return false;
  return confirmFn(`${data.error ?? ''}\n\n확인을 누르면 변경된 금액으로 저장합니다.`);
}
