// ─────────────────────────────────────────────────────────────────────────────
// 수행정보 (Performance) 섹션 — 판매 상세 C 섹션 · 1단계(기반) 스켈레톤
//
//  · 조회/수정 토글. 수정모드: 판매정보 불러오기 / 행 추가·복제·삭제 / 저장·취소.
//  · 1단계는 공통필드(수행구분·유형·상품명·상태·수행일·지급예정일·비고)만 편집.
//    개인 원천세·외주 매입 상세 입력 UI 는 2·3단계에서 확장(정산요약은 읽기전용 표시).
//  · 저장은 PUT /admin/projects/:id/performances (서버 재계산). 판매금액과 완전 분리.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState } from 'react';
import { api } from '../../lib/constants';
import { Card, GhostBtn, PrimaryBtn, ClickSelect } from '../ui';
import { C, TYPO, SP, BD, dsInputStd } from '../../lib/ds';

// ── 라벨 맵 ───────────────────────────────────────────────────────────────────
const CATEGORY_OPTS = [
  { value: 'individual', label: '개인 통번역사' },
  { value: 'vendor', label: '외주업체' },
];
const STATUS_OPTS = [
  { value: 'unassigned', label: '미배정' },
  { value: 'assigned', label: '배정완료' },
  { value: 'in_progress', label: '수행중' },
  { value: 'completed', label: '수행완료' },
  { value: 'payout_pending', label: '지급대기' },
  { value: 'paid', label: '지급완료' },
  { value: 'cancelled', label: '취소' },
];
const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(CATEGORY_OPTS.map(o => [o.value, o.label]));
const STATUS_LABEL: Record<string, string> = Object.fromEntries(STATUS_OPTS.map(o => [o.value, o.label]));
const SERVICE_LABEL: Record<string, string> = {
  translation: '번역', interpretation: '통역', equipment: '장비', expense: '기타',
  proofreading: '감수', editing: '편집/DTP', media: '미디어', operations: '운영/실비', combined: '통번역',
};
const RESIDENCY_OPTS = [
  { value: 'domestic_resident', label: '국내 거주자' },
  { value: 'overseas_or_nonresident', label: '해외 거주자·비거주자' },
];
const TREATMENT_OPTS = [
  { value: 'domestic_3_3', label: '국내 거주자 3.3%' },
  { value: 'exempt', label: '원천징수 제외' },
  { value: 'nonresident_custom', label: '비거주자 별도 원천징수' },
  { value: 'treaty_reduction_or_exemption', label: '조세조약 감면·면제' },
  { value: 'tax_review_required', label: '세무 확인 필요' },
];
const FEE_FIELDS: { key: keyof Row; label: string }[] = [
  { key: 'baseFee', label: '수행료' },
  { key: 'transportationFee', label: '교통비' },
  { key: 'businessTripFee', label: '출장비' },
  { key: 'copyrightFee', label: '저작권료' },
  { key: 'travelDayCompensation', label: '이동일 보상비' },
  { key: 'cancellationCompensation', label: '취소보상비' },
];
const EVIDENCE_OPTS = [
  { value: 'tax_invoice', label: '세금계산서' },
  { value: 'invoice', label: '계산서' },
  { value: 'zero_rate_tax_invoice', label: '영세율 세금계산서' },
  { value: 'other', label: '기타 증빙' },
  { value: 'none', label: '미발행' },
];
const VENDOR_TYPE_LABEL: Record<string, string> = {
  interpretation_equipment: '장비', editing: '편집/자막', translation_agency: '통번역업체',
  cleaning: '청소', water_supply: '상수도', etc: '기타',
};
const won = (n: unknown) => Math.round(Number(n ?? 0)).toLocaleString();
const num = (v: unknown) => Number(v ?? 0) || 0;

// 백엔드 calcVendorPurchase 미러
function calcVendorPreview(r: Row): { supply: number; vat: number; total: number } {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const supply = round2(num(r.supplyAmount));
  let vat = 0;
  switch (r.purchaseEvidenceType) {
    case 'tax_invoice': vat = round2(supply * 0.1); break;
    case 'invoice':
    case 'zero_rate_tax_invoice': vat = 0; break;
    default: vat = round2(num(r.vatAmount)); break; // other/none: 수동
  }
  return { supply, vat, total: round2(supply + vat) };
}

// 백엔드 calcIndividualPayout 미러(2소수 반올림) — 저장 전 미리보기용. 서버가 최종 재계산.
function calcIndivPreview(r: Row): { gross: number; rate: number; tax: number; net: number; confirmed: boolean } {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const gross = round2(num(r.baseFee) + num(r.transportationFee) + num(r.businessTripFee) +
    num(r.copyrightFee) + num(r.travelDayCompensation) + num(r.cancellationCompensation));
  let rate = 0, confirmed = true;
  switch (r.withholdingTreatment) {
    case 'domestic_3_3': rate = 3.3; break;
    case 'exempt': rate = 0; break;
    case 'nonresident_custom':
    case 'treaty_reduction_or_exemption': rate = num(r.withholdingRate); break;
    default: rate = 0; confirmed = false; break; // tax_review_required / 미선택
  }
  const tax = confirmed ? round2(gross * (rate / 100)) : 0;
  return { gross, rate, tax, net: round2(gross - tax), confirmed };
}

// 편집 행 모델 (서버 필드 일부 + 로컬 편집)
interface Row {
  id?: number;
  saleItemId?: number | null;
  performerCategory: string;
  status: string;
  serviceType?: string | null;
  productNameSnapshot?: string | null;
  languageOrServiceSnapshot?: string | null;
  performanceStartDate?: string | null;
  expectedPaymentDate?: string | null;
  memo?: string | null;
  // 개인 통번역사 (2단계)
  individualUserId?: number | null;
  performerNameSnapshot?: string | null;
  identifierSnapshotMasked?: string | null;
  residenceCountrySnapshot?: string | null;
  residencyType?: string | null;
  serviceCountry?: string | null;
  withholdingTreatment?: string | null;
  withholdingRate?: string | number | null;
  baseFee?: string | number | null;
  transportationFee?: string | number | null;
  businessTripFee?: string | number | null;
  copyrightFee?: string | number | null;
  travelDayCompensation?: string | number | null;
  cancellationCompensation?: string | number | null;
  // 외주업체 (3단계)
  vendorCompanyId?: number | null;
  vendorTypeSnapshot?: string | null;
  purchaseEvidenceType?: string | null;
  purchaseInvoiceDate?: string | null;
  actualPaymentDate?: string | null;
  // 정산요약(읽기전용 표시)
  grossPayment?: string | number | null;
  withholdingTax?: string | number | null;
  netPayment?: string | number | null;
  supplyAmount?: string | number | null;
  vatAmount?: string | number | null;
  totalPurchaseAmount?: string | number | null;
}

const toRow = (p: any): Row => ({
  id: p.id, saleItemId: p.saleItemId,
  performerCategory: p.performerCategory ?? 'individual',
  status: p.status ?? 'unassigned',
  serviceType: p.serviceType, productNameSnapshot: p.productNameSnapshot,
  languageOrServiceSnapshot: p.languageOrServiceSnapshot,
  performanceStartDate: p.performanceStartDate, expectedPaymentDate: p.expectedPaymentDate, memo: p.memo,
  individualUserId: p.individualUserId, performerNameSnapshot: p.performerNameSnapshot,
  identifierSnapshotMasked: p.identifierSnapshotMasked, residenceCountrySnapshot: p.residenceCountrySnapshot,
  residencyType: p.residencyType, serviceCountry: p.serviceCountry,
  withholdingTreatment: p.withholdingTreatment, withholdingRate: p.withholdingRate,
  baseFee: p.baseFee, transportationFee: p.transportationFee, businessTripFee: p.businessTripFee,
  copyrightFee: p.copyrightFee, travelDayCompensation: p.travelDayCompensation, cancellationCompensation: p.cancellationCompensation,
  vendorCompanyId: p.vendorCompanyId, vendorTypeSnapshot: p.vendorTypeSnapshot,
  purchaseEvidenceType: p.purchaseEvidenceType, purchaseInvoiceDate: p.purchaseInvoiceDate, actualPaymentDate: p.actualPaymentDate,
  grossPayment: p.grossPayment, withholdingTax: p.withholdingTax, netPayment: p.netPayment,
  supplyAmount: p.supplyAmount, vatAmount: p.vatAmount, totalPurchaseAmount: p.totalPurchaseAmount,
});

const dateVal = (s?: string | null) => (s ? String(s).slice(0, 10) : '');

interface Props {
  projectId: number;
  token: string;
  performances: any[];
  onChanged: () => void | Promise<void>;
  onToast: (msg: string) => void;
}

export default function PerformanceSection({ projectId, token, performances, onChanged, onToast }: Props) {
  const authH = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [editMode, setEditMode] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [deletedIds, setDeletedIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [searchIdx, setSearchIdx] = useState<number | null>(null);
  const [searchResults, setSearchResults] = useState<any[]>([]);

  const list: any[] = performances ?? [];

  const enterEdit = () => { setRows(list.map(toRow)); setDeletedIds([]); setEditMode(true); };
  const cancelEdit = () => { setRows([]); setDeletedIds([]); setEditMode(false); };
  const patchRow = (i: number, p: Partial<Row>) => setRows(prev => prev.map((r, idx) => idx === i ? { ...r, ...p } : r));
  const addRow = () => setRows(prev => [...prev, { performerCategory: 'individual', status: 'unassigned' }]);
  const dupRow = (i: number) => setRows(prev => {
    const src = prev[i];
    const copy: Row = { // 업무정보 유지, 수행자·금액·상태 초기화(§28)
      saleItemId: src.saleItemId, performerCategory: src.performerCategory, status: 'unassigned',
      serviceType: src.serviceType, productNameSnapshot: src.productNameSnapshot,
      languageOrServiceSnapshot: src.languageOrServiceSnapshot, performanceStartDate: src.performanceStartDate,
    };
    return [...prev.slice(0, i + 1), copy, ...prev.slice(i + 1)];
  });
  const removeRow = (i: number) => setRows(prev => {
    const r = prev[i];
    if (r.status === 'paid') { onToast('지급완료된 수행정보는 삭제할 수 없습니다.'); return prev; }
    if (r.id) setDeletedIds(d => [...d, r.id!]);
    return prev.filter((_, idx) => idx !== i);
  });

  const rowKey = (r: Row, i: number) => String(r.id ?? `new-${i}`);
  const toggleExpand = (k: string) => setExpanded(p => ({ ...p, [k]: !p[k] }));

  // 통번역사 검색(기존 CRM 검색 API 재사용)
  const runSearch = async (i: number, q: string) => {
    setSearchIdx(i);
    if (!q.trim()) { setSearchResults([]); return; }
    try {
      const res = await fetch(api(`/api/admin/translators?search=${encodeURIComponent(q)}`), { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => []);
      setSearchResults(Array.isArray(data) ? data.slice(0, 8) : []);
    } catch { setSearchResults([]); }
  };

  // 통번역사 선택 — 저장된 행에 대해 select-individual 호출(스냅샷·세무 기본값 서버 설정)
  const selectPerformer = async (i: number, translatorId: number) => {
    const r = rows[i];
    if (!r.id) { onToast('먼저 저장한 뒤 통번역사를 선택하세요.'); return; }
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/performances/${r.id}/select-individual`), {
        method: 'POST', headers: authH, body: JSON.stringify({ translatorId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? '통번역사 선택 실패'); return; }
      const s = data.row ?? {};
      patchRow(i, {
        performerCategory: 'individual', individualUserId: s.individualUserId,
        performerNameSnapshot: s.performerNameSnapshot, identifierSnapshotMasked: s.identifierSnapshotMasked,
        residenceCountrySnapshot: s.residenceCountrySnapshot, residencyType: s.residencyType,
        withholdingTreatment: s.withholdingTreatment,
      });
      setSearchResults([]); setSearchIdx(null);
      onToast('통번역사가 선택되었습니다.');
      onChanged();
    } catch { onToast('통번역사 선택 중 오류'); } finally { setBusy(false); }
  };

  // 외주업체 검색·선택(기존 거래처 CRM 재사용, companyType=vendor)
  const runVendorSearch = async (i: number, q: string) => {
    setSearchIdx(i);
    if (!q.trim()) { setSearchResults([]); return; }
    try {
      const res = await fetch(api(`/api/admin/companies?companyType=vendor&search=${encodeURIComponent(q)}`), { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => []);
      const arr = Array.isArray(data) ? data : (data.rows ?? []);
      setSearchResults(arr.slice(0, 8));
    } catch { setSearchResults([]); }
  };
  const selectVendor = async (i: number, companyId: number) => {
    const r = rows[i];
    if (!r.id) { onToast('먼저 저장한 뒤 업체를 선택하세요.'); return; }
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/performances/${r.id}/select-vendor`), { method: 'POST', headers: authH, body: JSON.stringify({ companyId }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? '업체 선택 실패'); return; }
      const s = data.row ?? {};
      patchRow(i, { performerCategory: 'vendor', vendorCompanyId: s.vendorCompanyId, performerNameSnapshot: s.performerNameSnapshot, vendorTypeSnapshot: s.vendorTypeSnapshot, identifierSnapshotMasked: s.identifierSnapshotMasked });
      setSearchResults([]); setSearchIdx(null);
      onToast('외주업체가 선택되었습니다.'); onChanged();
    } catch { onToast('업체 선택 중 오류'); } finally { setBusy(false); }
  };

  const importFromSale = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/performances/import-from-sale`), { method: 'POST', headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? '판매정보 불러오기 실패'); return; }
      onToast(data.message ?? '불러오기 완료');
      // 새로 생성된 행을 편집 상태에 즉시 반영(이미 있던 행 뒤에 추가)
      setRows(prev => [...prev, ...((data.rows ?? []) as any[]).map(toRow)]);
      await onChanged(); // 부모 목록도 동기화(취소 시 조회모드에 반영)
    } catch { onToast('판매정보 불러오기 중 오류'); } finally { setBusy(false); }
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const payload = {
        rows: rows.map((r, idx) => ({
          id: r.id,
          saleItemId: r.saleItemId ?? null,
          sequence: idx,
          performerCategory: r.performerCategory,
          status: r.status,
          serviceType: r.serviceType ?? null,
          productNameSnapshot: r.productNameSnapshot ?? null,
          languageOrServiceSnapshot: r.languageOrServiceSnapshot ?? null,
          performanceStartDate: r.performanceStartDate || null,
          expectedPaymentDate: r.expectedPaymentDate || null,
          actualPaymentDate: r.actualPaymentDate || null,
          memo: r.memo ?? null,
          // 개인 정산 입력(서버 재계산)
          individualUserId: r.individualUserId ?? null,
          residencyType: r.residencyType ?? null,
          serviceCountry: r.serviceCountry ?? null,
          withholdingTreatment: r.withholdingTreatment ?? null,
          withholdingRate: r.withholdingRate != null && r.withholdingRate !== '' ? num(r.withholdingRate) : null,
          baseFee: num(r.baseFee), transportationFee: num(r.transportationFee), businessTripFee: num(r.businessTripFee),
          copyrightFee: num(r.copyrightFee), travelDayCompensation: num(r.travelDayCompensation),
          cancellationCompensation: num(r.cancellationCompensation),
          // 외주 매입 입력(서버 재계산)
          vendorCompanyId: r.vendorCompanyId ?? null,
          purchaseEvidenceType: r.purchaseEvidenceType ?? null,
          purchaseInvoiceDate: r.purchaseInvoiceDate || null,
          supplyAmount: num(r.supplyAmount),
          vatAmountManual: num(r.vatAmount),
        })),
        deletedIds,
      };
      const res = await fetch(api(`/api/admin/projects/${projectId}/performances`), { method: 'PUT', headers: authH, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? '수행정보 저장 실패'); return; }
      onToast('수행정보가 저장되었습니다.');
      setEditMode(false); setRows([]); setDeletedIds([]);
      await onChanged();
    } catch { onToast('수행정보 저장 중 오류'); } finally { setBusy(false); }
  };

  const settlementSummary = (r: Row) => r.performerCategory === 'vendor'
    ? `공급가 ${won(r.supplyAmount)} · 부가세 ${won(r.vatAmount)} · 합계 ${won(r.totalPurchaseAmount)}`
    : `세전 ${won(r.grossPayment)} · 원천세 ${won(r.withholdingTax)} · 세후 ${won(r.netPayment)}`;

  // ── 헤더 ────────────────────────────────────────────────────────────────────
  const header = (
    <div style={{ ...TYPO.sectionTitle, paddingBottom: SP[4], borderBottom: BD.grid, marginBottom: SP[6], display: 'flex', alignItems: 'center', gap: SP[3] }}>
      <span style={{ width: 22, height: 22, borderRadius: BD.radius.md, background: '#fef3c7', color: '#b45309', fontSize: 12, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>C</span>
      수행정보
      <span style={{ ...TYPO.helper, marginLeft: SP[2] }}>통번역사 및 외주업체의 업무 배정·지급정보</span>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {editMode ? (
          <>
            <GhostBtn onClick={importFromSale} disabled={busy} style={{ fontSize: 12, padding: '6px 12px' }}
              data-testid="btn-perf-import" aria-label="판매정보 불러오기">판매정보 불러오기</GhostBtn>
            <GhostBtn onClick={addRow} disabled={busy} style={{ fontSize: 12, padding: '6px 12px' }}
              data-testid="btn-perf-add" aria-label="행 추가">+ 행 추가</GhostBtn>
            <GhostBtn onClick={cancelEdit} disabled={busy} style={{ fontSize: 12, padding: '6px 12px' }}
              data-testid="btn-perf-cancel" aria-label="취소">취소</GhostBtn>
            <PrimaryBtn onClick={save} disabled={busy} style={{ fontSize: 12, padding: '6px 12px' }}
              data-testid="btn-perf-save" aria-label="수행정보 저장">{busy ? '저장 중…' : '저장'}</PrimaryBtn>
          </>
        ) : (
          <GhostBtn onClick={enterEdit} style={{ fontSize: 12, padding: '6px 12px' }}
            data-testid="btn-perf-edit" aria-label="수행정보 수정">✏ 수행정보 수정</GhostBtn>
        )}
      </div>
    </div>
  );

  const th: React.CSSProperties = { ...TYPO.gridHeader, padding: '0 8px 8px', textAlign: 'left', borderBottom: BD.grid, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { ...TYPO.inputValue, padding: '8px', borderBottom: BD.divider, verticalAlign: 'top' };
  const inp: React.CSSProperties = { ...dsInputStd(), minHeight: 32, padding: '4px 8px', width: '100%' };

  const numInp = (v: unknown, on: (val: string) => void, testid: string, label: string) => (
    <input type="number" min={0} inputMode="numeric" style={inp} value={v == null || v === '' ? '' : String(v)}
      onChange={e => on(e.target.value)} data-testid={testid} aria-label={label} />
  );

  // 개인 정산 상세 패널 (2단계) — 통번역사 선택 · 거주/세무 · 지급항목 · 계산 미리보기
  const renderDetail = (r: Row, i: number) => {
    if (!r.id) {
      return <div style={{ ...TYPO.helper, padding: SP[3] }}>이 행을 먼저 저장하면 수행자 선택과 정산 입력을 할 수 있습니다.</div>;
    }
    // ── 외주업체 매입 (3단계) ──
    if (r.performerCategory === 'vendor') {
      const v = calcVendorPreview(r);
      const vatEditable = r.purchaseEvidenceType === 'other' || r.purchaseEvidenceType === 'none';
      return (
        <div style={{ padding: SP[4], background: '#fafafa', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: SP[4] }}>
          {/* 업체 선택 */}
          <div>
            <label style={{ ...TYPO.fieldLabel, display: 'block', marginBottom: SP[2] }}>외주업체</label>
            {r.performerNameSnapshot ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700 }}>{r.performerNameSnapshot}</span>
                {r.vendorTypeSnapshot && <span style={{ ...TYPO.helper }}>{VENDOR_TYPE_LABEL[r.vendorTypeSnapshot] ?? r.vendorTypeSnapshot}</span>}
                {r.identifierSnapshotMasked && <span style={{ ...TYPO.helper }}>· 사업자 {r.identifierSnapshotMasked}</span>}
                <button type="button" onClick={() => { patchRow(i, { performerNameSnapshot: null }); setSearchIdx(i); setSearchResults([]); }}
                  style={{ fontSize: 11, padding: '3px 8px', border: `1px solid ${C.g300}`, borderRadius: 6, background: C.bgCard, cursor: 'pointer' }}>변경</button>
              </div>
            ) : (
              <div style={{ position: 'relative', maxWidth: 420 }}>
                <input style={inp} placeholder="업체명·사업자번호로 검색…" onChange={e => runVendorSearch(i, e.target.value)}
                  data-testid={`perf-vsearch-${i}`} aria-label="외주업체 검색" />
                {searchIdx === i && searchResults.length > 0 && (
                  <div style={{ position: 'absolute', zIndex: 5, top: '100%', left: 0, right: 0, background: C.bgCard, border: `1px solid ${C.g200}`, borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.08)', maxHeight: 220, overflowY: 'auto' }}>
                    {searchResults.map(c => (
                      <button key={c.id} type="button" onClick={() => selectVendor(i, c.id)}
                        style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', borderBottom: `1px solid ${C.g100}`, background: 'transparent', cursor: 'pointer', fontSize: 13 }}>
                        <span style={{ fontWeight: 600 }}>{c.name}</span>
                        <span style={{ ...TYPO.helper, marginLeft: 8 }}>{VENDOR_TYPE_LABEL[c.vendorType] ?? c.vendorType ?? ''}{c.businessNumber ? ` · ${c.businessNumber}` : ''}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* 매입 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: SP[4] }}>
            <div>
              <label style={{ ...TYPO.fieldLabel, display: 'block', marginBottom: SP[2] }}>매입증빙 유형</label>
              <ClickSelect value={r.purchaseEvidenceType ?? ''} onChange={(val: string) => patchRow(i, { purchaseEvidenceType: val })} triggerStyle={inp} options={EVIDENCE_OPTS} />
            </div>
            <div>
              <label style={{ ...TYPO.fieldLabel, display: 'block', marginBottom: SP[2] }}>발행일</label>
              <input type="date" style={inp} value={dateVal(r.purchaseInvoiceDate)} onChange={e => patchRow(i, { purchaseInvoiceDate: e.target.value })} aria-label="매입세금계산서 발행일" />
            </div>
            <div>
              <label style={{ ...TYPO.fieldLabel, display: 'block', marginBottom: SP[2] }}>공급가액</label>
              {numInp(r.supplyAmount, val => patchRow(i, { supplyAmount: val }), `perf-supply-${i}`, '공급가액')}
            </div>
            <div>
              <label style={{ ...TYPO.fieldLabel, display: 'block', marginBottom: SP[2] }}>부가세{vatEditable ? '' : ' (자동)'}</label>
              {vatEditable
                ? numInp(r.vatAmount, val => patchRow(i, { vatAmount: val }), `perf-vat-${i}`, '부가세')
                : <div style={{ ...inp, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', background: '#f3f4f6', color: C.textSecondary, fontVariantNumeric: 'tabular-nums' }}>{won(v.vat)}원</div>}
            </div>
            <div>
              <label style={{ ...TYPO.fieldLabel, display: 'block', marginBottom: SP[2] }}>지급예정일</label>
              <input type="date" style={inp} value={dateVal(r.expectedPaymentDate)} onChange={e => patchRow(i, { expectedPaymentDate: e.target.value })} aria-label="지급예정일" />
            </div>
            <div>
              <label style={{ ...TYPO.fieldLabel, display: 'block', marginBottom: SP[2] }}>지급일</label>
              <input type="date" style={inp} value={dateVal(r.actualPaymentDate)} onChange={e => patchRow(i, { actualPaymentDate: e.target.value })} aria-label="지급일" />
            </div>
          </div>
          {/* 요약 */}
          <div style={{ display: 'flex', gap: SP[6], flexWrap: 'wrap', ...TYPO.inputValue, fontVariantNumeric: 'tabular-nums' }}>
            <span>공급가액 <b>{won(v.supply)}원</b></span>
            <span>부가세 <b>{won(v.vat)}원</b></span>
            <span>합계 <b style={{ color: C.primaryText }}>{won(v.total)}원</b></span>
            <span style={{ ...TYPO.helper }}>※ 저장 시 서버가 최종 재계산합니다.</span>
          </div>
        </div>
      );
    }
    const preview = calcIndivPreview(r);
    const treatment = r.withholdingTreatment ?? '';
    const rateEditable = treatment === 'nonresident_custom' || treatment === 'treaty_reduction_or_exemption';
    return (
      <div style={{ padding: SP[4], background: '#fafafa', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: SP[4] }}>
        {/* 통번역사 선택 */}
        <div>
          <label style={{ ...TYPO.fieldLabel, display: 'block', marginBottom: SP[2] }}>통번역사</label>
          {r.performerNameSnapshot ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700 }}>{r.performerNameSnapshot}</span>
              {r.identifierSnapshotMasked && <span style={{ ...TYPO.helper }}>식별번호 {r.identifierSnapshotMasked}</span>}
              {r.residenceCountrySnapshot && <span style={{ ...TYPO.helper }}>· {r.residenceCountrySnapshot}</span>}
              <button type="button" onClick={() => { patchRow(i, { performerNameSnapshot: null }); setSearchIdx(i); setSearchResults([]); }}
                style={{ fontSize: 11, padding: '3px 8px', border: `1px solid ${C.g300}`, borderRadius: 6, background: C.bgCard, cursor: 'pointer' }}>변경</button>
            </div>
          ) : (
            <div style={{ position: 'relative', maxWidth: 420 }}>
              <input style={inp} placeholder="이름·이메일로 검색…" onChange={e => runSearch(i, e.target.value)}
                data-testid={`perf-search-${i}`} aria-label="통번역사 검색" />
              {searchIdx === i && searchResults.length > 0 && (
                <div style={{ position: 'absolute', zIndex: 5, top: '100%', left: 0, right: 0, background: C.bgCard, border: `1px solid ${C.g200}`, borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.08)', maxHeight: 220, overflowY: 'auto' }}>
                  {searchResults.map(t => (
                    <button key={t.id} type="button" onClick={() => selectPerformer(i, t.id)}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', borderBottom: `1px solid ${C.g100}`, background: 'transparent', cursor: 'pointer', fontSize: 13 }}>
                      <span style={{ fontWeight: 600 }}>{t.name || t.email}</span>
                      <span style={{ ...TYPO.helper, marginLeft: 8 }}>{t.languagePairs || ''}{t.region ? ` · ${t.region}` : ''}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {/* 거주·세무 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: SP[4] }}>
          <div>
            <label style={{ ...TYPO.fieldLabel, display: 'block', marginBottom: SP[2] }}>거주구분</label>
            <ClickSelect value={r.residencyType ?? ''} onChange={(v: string) => patchRow(i, { residencyType: v })} triggerStyle={inp} options={RESIDENCY_OPTS} />
          </div>
          <div>
            <label style={{ ...TYPO.fieldLabel, display: 'block', marginBottom: SP[2] }}>원천징수 처리구분</label>
            <ClickSelect value={treatment} onChange={(v: string) => patchRow(i, { withholdingTreatment: v })} triggerStyle={inp} options={TREATMENT_OPTS} />
          </div>
          <div>
            <label style={{ ...TYPO.fieldLabel, display: 'block', marginBottom: SP[2] }}>적용세율</label>
            {rateEditable
              ? numInp(r.withholdingRate, v => patchRow(i, { withholdingRate: v }), `perf-rate-${i}`, '적용세율')
              : <div style={{ ...inp, display: 'flex', alignItems: 'center', background: '#f3f4f6', color: C.textSecondary }}>
                  {treatment === 'domestic_3_3' ? '3.3% (고정)' : treatment === 'exempt' ? '0%' : '미확정'}
                </div>}
          </div>
        </div>
        {treatment === 'tax_review_required' && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start', padding: '4px 10px', borderRadius: 6, background: '#fef3c7', color: '#b45309', fontSize: 12, fontWeight: 700 }}>
            ⚠ 세무확인 필요 — 세율·원천세가 확정값이 아닙니다
          </div>
        )}
        {/* 지급항목 */}
        <div>
          <label style={{ ...TYPO.fieldLabel, display: 'block', marginBottom: SP[2] }}>지급항목 (원, 음수 불가)</label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: SP[3] }}>
            {FEE_FIELDS.map(f => (
              <div key={String(f.key)}>
                <div style={{ ...TYPO.helper, marginBottom: 2 }}>{f.label}</div>
                {numInp(r[f.key], v => patchRow(i, { [f.key]: v } as Partial<Row>), `perf-${String(f.key)}-${i}`, f.label)}
              </div>
            ))}
          </div>
        </div>
        {/* 계산 미리보기 */}
        <div style={{ display: 'flex', gap: SP[6], flexWrap: 'wrap', ...TYPO.inputValue, fontVariantNumeric: 'tabular-nums' }}>
          <span>세전 <b>{won(preview.gross)}원</b></span>
          <span>원천세 <b style={{ color: preview.confirmed ? C.g900 : C.g400 }}>{preview.confirmed ? won(preview.tax) + '원' : '미확정'}</b></span>
          <span>세후 <b style={{ color: C.primaryText }}>{won(preview.net)}원</b></span>
          <span style={{ ...TYPO.helper }}>※ 저장 시 서버가 최종 재계산합니다.</span>
        </div>
      </div>
    );
  };

  return (
    <Card>
      {header}

      {/* ── 조회모드 ── */}
      {!editMode && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
            <thead><tr>
              {['수행구분', '유형 / 상품명', '상태', '수행일', '지급예정일', '정산정보'].map(h => <th key={h} style={th}>{h}</th>)}
            </tr></thead>
            <tbody>
              {list.map((p, i) => {
                const r = toRow(p);
                return (
                  <tr key={p.id ?? i}>
                    <td style={td}>
                      <div>{CATEGORY_LABEL[r.performerCategory] ?? r.performerCategory}</div>
                      {r.performerNameSnapshot && <div style={{ fontSize: 11, color: C.textMuted }}>{r.performerNameSnapshot}</div>}
                    </td>
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>{r.productNameSnapshot || '—'}</div>
                      <div style={{ fontSize: 11, color: C.textMuted }}>
                        {(SERVICE_LABEL[r.serviceType ?? ''] ?? r.serviceType ?? '')}{r.languageOrServiceSnapshot ? ` · ${r.languageOrServiceSnapshot}` : ''}
                      </div>
                    </td>
                    <td style={td}>{STATUS_LABEL[r.status] ?? r.status}</td>
                    <td style={td}>{dateVal(r.performanceStartDate) || '—'}</td>
                    <td style={td}>{dateVal(r.expectedPaymentDate) || '—'}</td>
                    <td style={{ ...td, color: C.textSecondary, fontVariantNumeric: 'tabular-nums' }}>{settlementSummary(r)}</td>
                  </tr>
                );
              })}
              {list.length === 0 && (
                <tr><td colSpan={6} style={{ ...td, textAlign: 'center', color: C.g400 }}>
                  등록된 수행정보가 없습니다. 「수행정보 수정 → 판매정보 불러오기」로 시작하세요.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ── 수정모드 ── */}
      {editMode && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
            <thead><tr>
              {['수행구분', '상품명', '상태', '수행일', '지급예정일', '비고', '제어'].map(h => <th key={h} style={th}>{h}</th>)}
            </tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const k = rowKey(r, i);
                const isOpen = !!expanded[k];
                return (
                  <React.Fragment key={k}>
                    <tr>
                      <td style={{ ...td, minWidth: 130 }}>
                        <ClickSelect value={r.performerCategory} onChange={(v: string) => patchRow(i, { performerCategory: v })}
                          triggerStyle={inp} options={CATEGORY_OPTS} />
                      </td>
                      <td style={{ ...td, minWidth: 160 }}>
                        <input style={inp} value={r.productNameSnapshot ?? ''} onChange={e => patchRow(i, { productNameSnapshot: e.target.value })}
                          placeholder="상품명" data-testid={`perf-name-${i}`} aria-label="상품명" />
                      </td>
                      <td style={{ ...td, minWidth: 120 }}>
                        <ClickSelect value={r.status} onChange={(v: string) => patchRow(i, { status: v })}
                          triggerStyle={inp} options={STATUS_OPTS} />
                      </td>
                      <td style={{ ...td, minWidth: 140 }}>
                        <input type="date" style={inp} value={dateVal(r.performanceStartDate)} onChange={e => patchRow(i, { performanceStartDate: e.target.value })}
                          data-testid={`perf-date-${i}`} aria-label="수행일" />
                      </td>
                      <td style={{ ...td, minWidth: 140 }}>
                        <input type="date" style={inp} value={dateVal(r.expectedPaymentDate)} onChange={e => patchRow(i, { expectedPaymentDate: e.target.value })}
                          data-testid={`perf-expected-${i}`} aria-label="지급예정일" />
                      </td>
                      <td style={{ ...td, minWidth: 140 }}>
                        <input style={inp} value={r.memo ?? ''} onChange={e => patchRow(i, { memo: e.target.value })}
                          placeholder="비고" data-testid={`perf-memo-${i}`} aria-label="비고" />
                      </td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        <button type="button" onClick={() => toggleExpand(k)} data-testid={`perf-expand-${i}`} aria-label="정산 상세"
                          style={{ fontSize: 11, padding: '4px 8px', marginRight: 4, border: `1px solid ${isOpen ? C.primary : C.g300}`, borderRadius: 6, background: isOpen ? C.primaryBg : C.bgCard, color: isOpen ? C.primaryText : C.textSecondary, cursor: 'pointer' }}>정산 {isOpen ? '▲' : '▼'}</button>
                        <button type="button" onClick={() => dupRow(i)} data-testid={`perf-dup-${i}`} aria-label="행 복제"
                          style={{ fontSize: 11, padding: '4px 8px', marginRight: 4, border: `1px solid ${C.g300}`, borderRadius: 6, background: C.bgCard, cursor: 'pointer' }}>복제</button>
                        <button type="button" onClick={() => removeRow(i)} data-testid={`perf-del-${i}`} aria-label="행 삭제"
                          style={{ fontSize: 11, padding: '4px 8px', border: '1px solid #fca5a5', borderRadius: 6, background: '#fff1f2', color: '#b91c1c', cursor: 'pointer' }}>삭제</button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr><td colSpan={7} style={{ padding: '0 8px 10px', borderBottom: BD.divider }}>{renderDetail(r, i)}</td></tr>
                    )}
                  </React.Fragment>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={7} style={{ ...td, textAlign: 'center', color: C.g400 }}>
                  「판매정보 불러오기」 또는 「+ 행 추가」로 수행정보를 추가하세요.
                </td></tr>
              )}
            </tbody>
          </table>
          <div style={{ ...TYPO.helper, marginTop: SP[3] }}>
            ※ 「정산 ▼」에서 수행자(통번역사/외주업체) 선택과 정산정보를 입력합니다. 저장 시 서버가 원천세·부가세를 재계산합니다.
          </div>
        </div>
      )}
    </Card>
  );
}
