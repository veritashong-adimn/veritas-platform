/**
 * ComparisonQuoteModal — 비교견적(고객 제출용 보조 문서) 생성/목록/수정/복사/삭제.
 *
 * 원본 VERITAS 견적(sourceQuoteId)을 SOURCE 로만 사용하며, 원본 quote/quote_items 를 절대 수정하지 않는다.
 * 판매전환·프로젝트·청구·정산과 무관(§10). 서버(comparison_quotes/items)와만 통신한다.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/constants';
import { ClickSelect } from '../ui';
import ComparisonQuotePdfPreviewModal from './ComparisonQuotePdfPreviewModal';
import { buildComparisonQuotePdfData, type ComparisonQuotePdfData } from '../../lib/comparisonQuotePdf';
import { toComparisonItemName } from '../../lib/comparisonItemName';

// 원본 견적 품목에서 복사해오는 초기 행(부모가 계산해 전달).
export interface ComparisonSeedRow {
  sourceQuoteItemId?: number | null;
  description: string;
  languagePair?: string | null;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  memo?: string | null;
}

interface ItemRow {
  sourceQuoteItemId: number | null;
  description: string;
  languagePair: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  amount: string;
  memo: string;
}

interface Props {
  sourceQuoteId: number;
  sourceTitle: string;
  seedRows: ComparisonSeedRow[];
  sourceTotal: number; // VERITAS 견적 총 공급가액(합계 기준선 표시용)
  token: string;
  onClose: () => void;
  onToast: (m: string) => void;
}

const fmt = (n: number) => (Number(n) || 0).toLocaleString('ko-KR');
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round0 = (n: number) => Math.round(n);

const inp: React.CSSProperties = { width: '100%', boxSizing: 'border-box', border: '1px solid #d1d5db', borderRadius: 7, padding: '8px 10px', fontSize: 13, background: '#fff' };
const lbl: React.CSSProperties = { fontSize: 11, color: '#6b7280', fontWeight: 600, display: 'block', marginBottom: 3 };
const cellInp: React.CSSProperties = { width: '100%', boxSizing: 'border-box', border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 7px', fontSize: 12, background: '#fff' };

function seedToRows(seed: ComparisonSeedRow[]): ItemRow[] {
  return seed.map((s) => ({
    sourceQuoteItemId: s.sourceQuoteItemId ?? null,
    // 비교견적용 초기 표현으로 변환(원본 quote_items 는 불변). 사용자가 이후 자유 수정 가능(§4).
    description: toComparisonItemName(s.description) || (s.description ?? ''),
    languagePair: s.languagePair ?? '',
    quantity: String(s.quantity ?? 1),
    unit: s.unit ?? '건',
    unitPrice: String(round0(s.unitPrice ?? 0)),
    amount: String(round0(s.amount ?? 0)),
    memo: s.memo ?? '',
  }));
}
const emptyRow = (): ItemRow => ({ sourceQuoteItemId: null, description: '', languagePair: '', quantity: '1', unit: '건', unitPrice: '0', amount: '0', memo: '' });

type ListItem = {
  id: number; companyName: string; displayNumber: string | null; quoteDate: string | null;
  vatMode: string; itemCount: number; supply: number; tax: number; total: number; createdAt: string;
};

// 비교견적 공급자(업체) Master 행
interface Vendor {
  id: number; companyName: string; representativeName: string | null; businessNumber: string | null;
  address: string | null; phone: string | null; email: string | null; website: string | null; isActive: boolean;
}

export default function ComparisonQuoteModal({ sourceQuoteId, sourceTitle, seedRows, sourceTotal, token, onClose, onToast }: Props) {
  const authH = { Authorization: `Bearer ${token}` };
  const [view, setView] = useState<'list' | 'form'>('list');
  const [list, setList] = useState<ListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pdfData, setPdfData] = useState<ComparisonQuotePdfData | null>(null);

  // form state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [companyName, setCompanyName] = useState('');
  const [representativeName, setRep] = useState('');
  const [businessNumber, setBiz] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [contactName, setContact] = useState('');
  const [displayNumber, setDisplayNumber] = useState('');
  const [quoteDate, setQuoteDate] = useState('');
  const [vatMode, setVatMode] = useState<'vat_10' | 'none'>('vat_10');
  const [memo, setMemo] = useState('');
  const [rows, setRows] = useState<ItemRow[]>([]);
  const [adjustPct, setAdjustPct] = useState('0');

  // 비교견적 공급자(업체) Master
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [selectedVendorId, setSelectedVendorId] = useState('');
  const [vendorBusy, setVendorBusy] = useState(false);

  const fetchVendors = useCallback(async () => {
    try {
      const res = await fetch(api('/api/admin/comparison-quote-vendors'), { headers: authH });
      const data = await res.json();
      if (res.ok) setVendors(Array.isArray(data) ? data : []);
    } catch { /* 목록 실패는 조용히 무시(직접 입력 가능) */ }
  }, [token]);

  useEffect(() => { fetchVendors(); }, [fetchVendors]);

  // 업체 선택 → 공급자 필드 자동 입력(Master 최신값). 이후 폼 수정은 Master 를 바꾸지 않는다.
  const applyVendor = (idStr: string) => {
    setSelectedVendorId(idStr);
    if (!idStr) return;
    const v = vendors.find((x) => String(x.id) === idStr);
    if (!v) return;
    setCompanyName(v.companyName ?? ''); setRep(v.representativeName ?? ''); setBiz(v.businessNumber ?? '');
    setAddress(v.address ?? ''); setPhone(v.phone ?? ''); setEmail(v.email ?? ''); setWebsite(v.website ?? '');
  };

  const vendorPayload = () => ({ companyName: companyName.trim(), representativeName, businessNumber, address, phone, email, website });

  const saveVendorNew = async () => {
    if (!companyName.trim()) { onToast('업체 상호명을 입력해 주세요.'); return; }
    setVendorBusy(true);
    try {
      const res = await fetch(api('/api/admin/comparison-quote-vendors'), { method: 'POST', headers: { ...authH, 'Content-Type': 'application/json' }, body: JSON.stringify(vendorPayload()) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(`오류: ${d.error ?? '업체 저장 실패'}`); return; }
      onToast('비교견적 업체를 저장했습니다.');
      await fetchVendors(); setSelectedVendorId(String(d.id));
    } catch { onToast('오류: 업체 저장 실패'); }
    finally { setVendorBusy(false); }
  };

  const updateVendor = async () => {
    if (!selectedVendorId) return;
    if (!companyName.trim()) { onToast('업체 상호명을 입력해 주세요.'); return; }
    setVendorBusy(true);
    try {
      const res = await fetch(api(`/api/admin/comparison-quote-vendors/${selectedVendorId}`), { method: 'PUT', headers: { ...authH, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...vendorPayload(), isActive: true }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(`오류: ${d.error ?? '업체 갱신 실패'}`); return; }
      onToast('업체 Master를 갱신했습니다. (기존 비교견적은 그대로)');
      await fetchVendors();
    } catch { onToast('오류: 업체 갱신 실패'); }
    finally { setVendorBusy(false); }
  };

  const deactivateVendor = async () => {
    if (!selectedVendorId) return;
    if (!window.confirm('이 업체를 선택목록에서 비활성화할까요? (기존 비교견적에는 영향 없음)')) return;
    setVendorBusy(true);
    try {
      const res = await fetch(api(`/api/admin/comparison-quote-vendors/${selectedVendorId}`), { method: 'PUT', headers: { ...authH, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...vendorPayload(), isActive: false }) });
      if (!res.ok) { onToast('오류: 업체 비활성화 실패'); return; }
      onToast('업체를 비활성화했습니다.');
      setSelectedVendorId(''); await fetchVendors();
    } catch { onToast('오류: 업체 비활성화 실패'); }
    finally { setVendorBusy(false); }
  };

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(api(`/api/admin/quotes/${sourceQuoteId}/comparison-quotes`), { headers: authH });
      const data = await res.json();
      if (res.ok) setList(Array.isArray(data) ? data : []);
    } catch { onToast('오류: 비교견적 조회 실패'); }
    finally { setLoading(false); }
  }, [sourceQuoteId, token]);

  useEffect(() => { fetchList(); }, [fetchList]);

  const totals = (() => {
    const supply = rows.reduce((a, r) => a + num(r.amount), 0);
    const tax = vatMode === 'vat_10' ? round0(supply * 0.1) : 0;
    return { supply, tax, total: supply + tax };
  })();

  const resetForm = () => {
    setEditingId(null); setCompanyName(''); setRep(''); setBiz(''); setAddress(''); setPhone(''); setEmail(''); setWebsite(''); setContact('');
    setDisplayNumber(''); setQuoteDate(''); setVatMode('vat_10'); setMemo(''); setAdjustPct('0'); setSelectedVendorId('');
  };

  const startCreate = () => { resetForm(); setRows(seedToRows(seedRows)); setView('form'); };

  const startEdit = async (id: number) => {
    try {
      const res = await fetch(api(`/api/admin/comparison-quotes/${id}`), { headers: authH });
      const d = await res.json();
      if (!res.ok) { onToast('오류: 비교견적 조회 실패'); return; }
      setEditingId(id);
      setCompanyName(d.companyName ?? ''); setRep(d.representativeName ?? ''); setBiz(d.businessNumber ?? '');
      setAddress(d.address ?? ''); setPhone(d.phone ?? ''); setEmail(d.email ?? ''); setWebsite(d.website ?? ''); setContact(d.contactName ?? '');
      setDisplayNumber(d.displayNumber ?? ''); setQuoteDate(d.quoteDate ?? ''); setVatMode(d.vatMode === 'none' ? 'none' : 'vat_10'); setMemo(d.memo ?? ''); setAdjustPct('0');
      setRows((d.items ?? []).map((it: Record<string, unknown>) => ({
        sourceQuoteItemId: (it.sourceQuoteItemId as number) ?? null,
        description: String(it.description ?? ''), languagePair: String(it.languagePair ?? ''),
        quantity: String(num(it.quantity)), unit: String(it.unit ?? '건'),
        unitPrice: String(round0(num(it.unitPrice))), amount: String(round0(num(it.amount))), memo: String(it.memo ?? ''),
      })));
      setView('form');
    } catch { onToast('오류: 비교견적 조회 실패'); }
  };

  // 금액 조정: 원본 seed 기준선 × (1+pct/100). 이후 개별 수정 자유.
  const applyAdjust = (pct: number) => {
    setRows(seedToRows(seedRows).map((r) => {
      const up = round0(num(r.unitPrice) * (1 + pct / 100));
      const amt = round0(num(r.amount) * (1 + pct / 100));
      return { ...r, unitPrice: String(up), amount: String(amt) };
    }));
  };

  const setRow = (i: number, patch: Partial<ItemRow>) => {
    setRows((prev) => prev.map((r, idx) => {
      if (idx !== i) return r;
      const next = { ...r, ...patch };
      // 수량/단가 변경 시 금액 자동 재계산(금액 직접 수정은 별도 유지).
      if (('quantity' in patch || 'unitPrice' in patch) && !('amount' in patch)) {
        next.amount = String(round0(num(next.quantity) * num(next.unitPrice)));
      }
      return next;
    }));
  };
  const addRow = () => setRows((p) => [...p, emptyRow()]);
  const removeRow = (i: number) => setRows((p) => p.filter((_, idx) => idx !== i));

  const save = async () => {
    if (!companyName.trim()) { onToast('상호명을 입력해 주세요.'); return; }
    setSaving(true);
    try {
      const body = {
        companyName: companyName.trim(), representativeName, businessNumber, address, phone, email, website, contactName,
        displayNumber, quoteDate: quoteDate || null, vatMode, memo,
        items: rows.filter((r) => r.description.trim()).map((r, i) => ({
          sourceQuoteItemId: r.sourceQuoteItemId, description: r.description.trim(), languagePair: r.languagePair || null,
          quantity: num(r.quantity), unit: r.unit || '건', unitPrice: num(r.unitPrice), amount: num(r.amount), memo: r.memo || null, sortOrder: i,
        })),
      };
      const url = editingId ? api(`/api/admin/comparison-quotes/${editingId}`) : api(`/api/admin/quotes/${sourceQuoteId}/comparison-quotes`);
      const res = await fetch(url, { method: editingId ? 'PUT' : 'POST', headers: { ...authH, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(`오류: ${d.error ?? '비교견적 저장 실패'}`); return; }
      onToast(editingId ? '비교견적이 수정되었습니다.' : '비교견적이 생성되었습니다.');
      resetForm(); setView('list'); fetchList();
    } catch { onToast('오류: 비교견적 저장 실패'); }
    finally { setSaving(false); }
  };

  const openPdf = async (id: number) => {
    try {
      const res = await fetch(api(`/api/admin/comparison-quotes/${id}`), { headers: authH });
      const d = await res.json();
      if (!res.ok) { onToast('오류: 비교견적 조회 실패'); return; }
      setPdfData(buildComparisonQuotePdfData(d));
    } catch { onToast('오류: 비교견적 조회 실패'); }
  };

  const duplicate = async (id: number) => {
    try {
      const res = await fetch(api(`/api/admin/comparison-quotes/${id}/duplicate`), { method: 'POST', headers: authH });
      if (!res.ok) { onToast('오류: 복사 실패'); return; }
      onToast('비교견적을 복사했습니다.'); fetchList();
    } catch { onToast('오류: 복사 실패'); }
  };

  const remove = async (id: number) => {
    if (!window.confirm('이 비교견적을 삭제할까요? (원본 견적에는 영향이 없습니다)')) return;
    try {
      const res = await fetch(api(`/api/admin/comparison-quotes/${id}`), { method: 'DELETE', headers: authH });
      if (!res.ok) { onToast('오류: 삭제 실패'); return; }
      onToast('비교견적을 삭제했습니다.'); fetchList();
    } catch { onToast('오류: 삭제 실패'); }
  };

  const smallBtn = (bg: string, color: string, border = 'transparent'): React.CSSProperties => ({ padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: `1px solid ${border}`, background: bg, color });

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 1500, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflowY: 'auto', padding: '40px 16px' }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div style={{ background: '#fff', borderRadius: 14, width: '96vw', maxWidth: 940, boxShadow: '0 20px 60px rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column', maxHeight: '90vh' }}>
          {/* 헤더 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 22px', borderBottom: '1px solid #eef2f7' }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 800, color: '#111827' }}>📊 비교견적</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>원본 견적: {sourceTitle || `#${sourceQuoteId}`} · 공급가액 {fmt(sourceTotal)}원 (VERITAS 실매출 아님 · 고객 제출용 보조문서)</div>
            </div>
            <button onClick={onClose} aria-label="닫기" style={{ background: 'transparent', border: 'none', fontSize: 22, color: '#9ca3af', cursor: 'pointer' }}>×</button>
          </div>

          <div style={{ padding: '18px 22px', overflowY: 'auto' }}>
            {view === 'list' ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#374151' }}>비교견적 목록 ({list.length})</div>
                  <button onClick={startCreate} data-testid="btn-comparison-new" style={smallBtn('#0f766e', '#fff')}>+ 새 비교견적</button>
                </div>
                {loading ? (
                  <div style={{ textAlign: 'center', color: '#9ca3af', fontSize: 13, padding: '28px 0' }}>불러오는 중…</div>
                ) : list.length === 0 ? (
                  <div style={{ textAlign: 'center', color: '#9ca3af', fontSize: 13, padding: '28px 0', border: '1px dashed #e5e7eb', borderRadius: 10 }}>
                    아직 생성된 비교견적이 없습니다. [+ 새 비교견적]으로 다른 상호의 비교견적서를 만들 수 있습니다.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {list.map((r) => (
                      <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 14px' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{r.companyName}{r.displayNumber ? <span style={{ color: '#9ca3af', fontWeight: 500, marginLeft: 6, fontSize: 11 }}>{r.displayNumber}</span> : null}</div>
                          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>합계 {fmt(r.total)}원 · {r.itemCount}개 품목{r.quoteDate ? ` · ${r.quoteDate}` : ''}</div>
                        </div>
                        <button onClick={() => openPdf(r.id)} style={smallBtn('#f0fdfa', '#0f766e', '#99f6e4')} data-testid="btn-comparison-view">보기</button>
                        <button onClick={() => startEdit(r.id)} style={smallBtn('#eff6ff', '#1d4ed8', '#bfdbfe')} data-testid="btn-comparison-edit">수정</button>
                        <button onClick={() => openPdf(r.id)} style={smallBtn('#0f766e', '#fff')} data-testid="btn-comparison-pdf">PDF</button>
                        <button onClick={() => duplicate(r.id)} style={smallBtn('#f9fafb', '#374151', '#d1d5db')} data-testid="btn-comparison-copy">복사</button>
                        <button onClick={() => remove(r.id)} style={smallBtn('#fef2f2', '#b91c1c', '#fecaca')} data-testid="btn-comparison-delete">삭제</button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                {/* 비교견적 업체(공급자 Master) 선택 */}
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap', marginBottom: 14, padding: '10px 12px', background: '#f0fdfa', border: '1px solid #99f6e4', borderRadius: 8 }}>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <label style={lbl}>비교견적 업체 <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>(선택 시 공급자 정보 자동 입력)</span></label>
                    <ClickSelect
                      value={selectedVendorId}
                      onChange={applyVendor}
                      placeholder="저장된 업체 선택 또는 직접 입력"
                      triggerStyle={inp}
                      aria-label="비교견적 업체 선택"
                      data-testid="cq-vendor-select"
                      options={[{ value: '', label: '직접 입력' }, ...vendors.map((v) => ({ value: String(v.id), label: v.companyName, sub: v.businessNumber ?? undefined }))]}
                    />
                  </div>
                  <button onClick={saveVendorNew} disabled={vendorBusy} style={smallBtn('#0f766e', '#fff')} data-testid="cq-vendor-save-new">+ 새 업체로 저장</button>
                  {selectedVendorId && (
                    <>
                      <button onClick={updateVendor} disabled={vendorBusy} style={smallBtn('#fff', '#0f766e', '#99f6e4')} data-testid="cq-vendor-update">선택 업체 갱신</button>
                      <button onClick={deactivateVendor} disabled={vendorBusy} style={smallBtn('#fef2f2', '#b91c1c', '#fecaca')} data-testid="cq-vendor-deactivate">비활성</button>
                    </>
                  )}
                </div>

                {/* 업체 정보 */}
                <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8 }}>비교업체 정보 <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>(VERITAS 정보는 표시되지 않습니다)</span></div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
                  <div><label style={lbl}>상호명 <span style={{ color: '#dc2626' }}>*</span></label><input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="예: ○○번역" style={inp} data-testid="cq-company-name" /></div>
                  <div><label style={lbl}>대표자명</label><input value={representativeName} onChange={(e) => setRep(e.target.value)} style={inp} /></div>
                  <div><label style={lbl}>사업자등록번호</label><input value={businessNumber} onChange={(e) => setBiz(e.target.value)} style={inp} /></div>
                  <div style={{ gridColumn: '1 / 3' }}><label style={lbl}>주소</label><input value={address} onChange={(e) => setAddress(e.target.value)} style={inp} /></div>
                  <div><label style={lbl}>담당자명</label><input value={contactName} onChange={(e) => setContact(e.target.value)} style={inp} /></div>
                  <div><label style={lbl}>전화번호</label><input value={phone} onChange={(e) => setPhone(e.target.value)} style={inp} /></div>
                  <div><label style={lbl}>이메일</label><input value={email} onChange={(e) => setEmail(e.target.value)} style={inp} /></div>
                  <div><label style={lbl}>홈페이지</label><input value={website} onChange={(e) => setWebsite(e.target.value)} style={inp} /></div>
                </div>

                {/* 문서 정보 */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
                  <div><label style={lbl}>견적번호 (표시용, 선택)</label><input value={displayNumber} onChange={(e) => setDisplayNumber(e.target.value)} placeholder="예: ABC-2026-001" style={inp} data-testid="cq-display-number" /></div>
                  <div><label style={lbl}>견적일자</label><input type="date" value={quoteDate} onChange={(e) => setQuoteDate(e.target.value)} style={inp} /></div>
                  <div><label style={lbl}>부가세</label>
                    <ClickSelect value={vatMode} onChange={(v) => setVatMode(v as 'vat_10' | 'none')} triggerStyle={inp}
                      options={[{ value: 'vat_10', label: '부가세 10%' }, { value: 'none', label: '부가세 없음' }]} />
                  </div>
                </div>

                {/* 금액 조정 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12, padding: '10px 12px', background: '#f8fafc', border: '1px solid #eef2f7', borderRadius: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>금액 조정</span>
                  <span style={{ fontSize: 11, color: '#9ca3af' }}>(원본 대비, 적용 후 개별 수정 가능)</span>
                  {[0, 5, 10, 15, 20].map((p) => (
                    <button key={p} onClick={() => applyAdjust(p)} style={smallBtn('#fff', '#0f766e', '#99f6e4')}>{p === 0 ? '원본가' : `+${p}%`}</button>
                  ))}
                  <input value={adjustPct} onChange={(e) => setAdjustPct(e.target.value)} style={{ ...inp, width: 70, padding: '6px 8px' }} aria-label="직접 비율" />
                  <span style={{ fontSize: 12, color: '#6b7280' }}>%</span>
                  <button onClick={() => applyAdjust(num(adjustPct))} style={smallBtn('#0f766e', '#fff')}>적용</button>
                </div>

                {/* 품목 */}
                <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 6 }}>품목</div>
                <div style={{ border: '1px solid #eef2f7', borderRadius: 8, overflow: 'hidden', marginBottom: 8 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '2.4fr 0.8fr 0.7fr 1fr 1.1fr 28px', gap: 6, padding: '7px 10px', background: '#f8fafc', fontSize: 11, fontWeight: 700, color: '#6b7280' }}>
                    <div>상품/업무 · 내역</div><div style={{ textAlign: 'right' }}>수량</div><div>단위</div><div style={{ textAlign: 'right' }}>단가</div><div style={{ textAlign: 'right' }}>금액</div><div />
                  </div>
                  {rows.map((r, i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '2.4fr 0.8fr 0.7fr 1fr 1.1fr 28px', gap: 6, padding: '6px 10px', borderTop: '1px solid #f1f5f9', alignItems: 'center' }}>
                      <div>
                        <input value={r.description} onChange={(e) => setRow(i, { description: e.target.value })} placeholder="상품/업무명" style={cellInp} />
                        <input value={r.memo} onChange={(e) => setRow(i, { memo: e.target.value })} placeholder="비고" style={{ ...cellInp, marginTop: 4, fontSize: 11, color: '#6b7280' }} />
                      </div>
                      <input value={r.quantity} onChange={(e) => setRow(i, { quantity: e.target.value })} inputMode="decimal" style={{ ...cellInp, textAlign: 'right' }} />
                      <input value={r.unit} onChange={(e) => setRow(i, { unit: e.target.value })} style={cellInp} />
                      <input value={r.unitPrice} onChange={(e) => setRow(i, { unitPrice: e.target.value })} inputMode="numeric" style={{ ...cellInp, textAlign: 'right' }} />
                      <input value={r.amount} onChange={(e) => setRow(i, { amount: e.target.value })} inputMode="numeric" style={{ ...cellInp, textAlign: 'right', fontWeight: 600 }} data-testid="cq-amount" />
                      <button onClick={() => removeRow(i)} aria-label="행 삭제" style={{ background: 'transparent', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 16 }}>×</button>
                    </div>
                  ))}
                  <div style={{ padding: '8px 10px', borderTop: '1px solid #f1f5f9' }}>
                    <button onClick={addRow} style={smallBtn('#f9fafb', '#374151', '#d1d5db')}>+ 행 추가</button>
                  </div>
                </div>

                {/* 합계 */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, alignItems: 'center', marginBottom: 12, fontSize: 13 }}>
                  <span style={{ color: '#6b7280' }}>공급가액 <b style={{ color: '#111827' }}>{fmt(totals.supply)}</b></span>
                  <span style={{ color: '#6b7280' }}>부가세 <b style={{ color: '#111827' }}>{fmt(totals.tax)}</b></span>
                  <span style={{ color: '#0f766e', fontWeight: 800, fontSize: 15 }}>합계 {fmt(totals.total)}원</span>
                </div>

                <div><label style={lbl}>비고 (PDF 하단 표시)</label><textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} style={{ ...inp, resize: 'vertical' }} /></div>
              </>
            )}
          </div>

          {/* 푸터 */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '14px 22px', borderTop: '1px solid #eef2f7' }}>
            {view === 'form' ? (
              <>
                <button onClick={() => { resetForm(); setView('list'); }} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>목록으로</button>
                <button onClick={save} disabled={saving} style={{ padding: '9px 22px', borderRadius: 8, border: 'none', background: '#0f766e', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.6 : 1 }} data-testid="cq-save">
                  {saving ? '저장 중…' : (editingId ? '수정 저장' : '비교견적 생성')}
                </button>
              </>
            ) : (
              <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>닫기</button>
            )}
          </div>
        </div>
      </div>

      {pdfData && <ComparisonQuotePdfPreviewModal data={pdfData} onClose={() => setPdfData(null)} />}
    </>
  );
}
