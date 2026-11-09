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
import {
  buildComparisonQuotePdfData, cleanTerms, normalizeDesign, DEFAULT_COMPARISON_ACCENT, DEFAULT_COMPARISON_DOC_TITLE,
  type ComparisonQuotePdfData, type ComparisonTerms, type ComparisonIssueType,
} from '../../lib/comparisonQuotePdf';
import { toComparisonItemName, toCustomerFacingNote, hasInternalText, toLanguageDirectionLabel } from '../../lib/comparisonItemName';
import { IssueTypeSelector, TermsEditor, BrandingPanel, type ImgState } from './ComparisonQuoteExtras';

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
    // 품목 설명 초기값 — 원본 메모에서 내부 관리 문구(단가 확인 필요·파일/단어수 등)를 뺀 고객용 문구만. 원본 quote_items 는 불변.
    memo: toCustomerFacingNote(s.memo),
  }));
}
const emptyRow = (): ItemRow => ({ sourceQuoteItemId: null, description: '', languagePair: '', quantity: '1', unit: '건', unitPrice: '0', amount: '0', memo: '' });

type ListItem = {
  id: number; companyName: string; displayNumber: string | null; quoteDate: string | null;
  vatMode: string; itemCount: number; supply: number; tax: number; total: number; createdAt: string;
  issueType?: ComparisonIssueType | null;
};

// 비교견적 공급자(업체) Master 행
interface Vendor {
  id: number; companyName: string; representativeName: string | null; businessNumber: string | null;
  address: string | null; phone: string | null; email: string | null; website: string | null; isActive: boolean;
  contactName?: string | null; hasLogo?: boolean; hasStamp?: boolean;
  designSettings?: { accentColor?: string | null; docTitle?: string | null } | null;
}

const todayKst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const NO_IMG: ImgState = { action: 'keep', preview: null };
const DEFAULT_DESIGN = { accentColor: DEFAULT_COMPARISON_ACCENT, docTitle: DEFAULT_COMPARISON_DOC_TITLE };

export default function ComparisonQuoteModal({ sourceQuoteId, sourceTitle, seedRows, sourceTotal, token, onClose, onToast }: Props) {
  const authH = { Authorization: `Bearer ${token}` };
  const [view, setView] = useState<'list' | 'form'>('list');
  const [list, setList] = useState<ListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pdfData, setPdfData] = useState<ComparisonQuotePdfData | null>(null);
  const [pdfImageError, setPdfImageError] = useState<string | null>(null);

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
  // v2 — 발행 구분('' = 미지정: 기존 데이터. 새 비교견적은 저장 전 선택 필수) / 견적 조건 / 디자인 / 로고·직인
  const [issueType, setIssueType] = useState<ComparisonIssueType | ''>('');
  const [legacyUnset, setLegacyUnset] = useState(false);
  const [terms, setTerms] = useState<ComparisonTerms>({});
  const [design, setDesign] = useState(DEFAULT_DESIGN);
  const [logoImg, setLogoImg] = useState<ImgState>(NO_IMG);
  const [stampImg, setStampImg] = useState<ImgState>(NO_IMG);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  // 수신처 스냅샷(미리보기 표시용 — 저장은 서버가 원본 견적에서 해결/보존. 여기서 보내지 않음)
  type Customer = { customerCompanyName?: string | null; customerRepresentativeName?: string | null; customerContactName?: string | null; customerPhone?: string | null; customerEmail?: string | null };
  const [customer, setCustomer] = useState<Customer>({});

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
    // v2 — 등록된 정보만 불러온다(없는 항목은 비워 둠 · 임의 생성 없음)
    setContact(v.contactName ?? '');
    setDesign(normalizeDesign(v.designSettings));
    void loadVendorImages(v.id);
  };

  // 업체 Master 의 실제 등록 로고·직인 → 이 비교견적 스냅샷으로 사용(action 'vendor'). 없으면 미출력.
  const loadVendorImages = async (vendorId: number) => {
    try {
      const res = await fetch(api(`/api/admin/comparison-quote-vendors/${vendorId}/images`), { headers: authH });
      const d = await res.json().catch(() => ({}));
      setLogoImg({ action: 'vendor', preview: res.ok ? d.logoDataUrl ?? null : null });
      setStampImg({ action: 'vendor', preview: res.ok ? d.stampDataUrl ?? null : null });
      if (res.ok && d.error) onToast(`주의: ${d.error}`);
    } catch {
      setLogoImg({ action: 'vendor', preview: null }); setStampImg({ action: 'vendor', preview: null });
    }
  };

  const uploadVendorImage = async (kind: 'logo' | 'stamp', file: File) => {
    if (!selectedVendorId) { onToast('저장된 업체를 먼저 선택해 주세요.'); return; }
    if (file.size > 2 * 1024 * 1024) { onToast('이미지는 2MB 이하만 등록할 수 있습니다.'); return; }
    setVendorBusy(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const res = await fetch(api(`/api/admin/comparison-quote-vendors/${selectedVendorId}/images/${kind}`), { method: 'POST', headers: authH, body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(`오류: ${d.error ?? '이미지 등록 실패'}`); return; }
      onToast(kind === 'logo' ? '업체 로고를 등록했습니다.' : '업체 직인/서명을 등록했습니다.');
      await loadVendorImages(Number(selectedVendorId)); fetchVendors();
    } catch { onToast('오류: 이미지 등록 실패'); }
    finally { setVendorBusy(false); }
  };

  const deleteVendorImage = async (kind: 'logo' | 'stamp') => {
    if (!selectedVendorId) return;
    if (!window.confirm('업체 Master 에서 이 이미지를 삭제할까요? (이미 생성된 비교견적에는 영향 없음)')) return;
    setVendorBusy(true);
    try {
      const res = await fetch(api(`/api/admin/comparison-quote-vendors/${selectedVendorId}/images/${kind}`), { method: 'DELETE', headers: authH });
      if (!res.ok) { onToast('오류: 이미지 삭제 실패'); return; }
      await loadVendorImages(Number(selectedVendorId)); fetchVendors();
    } catch { onToast('오류: 이미지 삭제 실패'); }
    finally { setVendorBusy(false); }
  };

  const vendorPayload = () => ({
    companyName: companyName.trim(), representativeName, businessNumber, address, phone, email, website,
    contactName, designSettings: design,
  });

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
    setIssueType(''); setLegacyUnset(false); setTerms({}); setDesign(DEFAULT_DESIGN); setLogoImg(NO_IMG); setStampImg(NO_IMG); setCreatedAt(null);
  };

  // 새 비교견적 — 발행일 기본값은 오늘(수정 가능). 견적번호는 임의 생성하지 않는다.
  const startCreate = () => {
    resetForm(); setQuoteDate(todayKst()); setRows(seedToRows(seedRows)); setView('form');
    setCustomer({});
    fetch(api(`/api/admin/quotes/${sourceQuoteId}/customer-info`), { headers: authH })
      .then((r) => (r.ok ? r.json() : {})).then((c) => setCustomer(c ?? {})).catch(() => { /* 미리보기 수신처 생략 */ });
  };

  const startEdit = async (id: number) => {
    try {
      const res = await fetch(api(`/api/admin/comparison-quotes/${id}`), { headers: authH });
      const d = await res.json();
      if (!res.ok) { onToast('오류: 비교견적 조회 실패'); return; }
      setEditingId(id);
      setCompanyName(d.companyName ?? ''); setRep(d.representativeName ?? ''); setBiz(d.businessNumber ?? '');
      setAddress(d.address ?? ''); setPhone(d.phone ?? ''); setEmail(d.email ?? ''); setWebsite(d.website ?? ''); setContact(d.contactName ?? '');
      setDisplayNumber(d.displayNumber ?? ''); setQuoteDate(d.quoteDate ?? ''); setVatMode(d.vatMode === 'none' ? 'none' : 'vat_10'); setMemo(d.memo ?? ''); setAdjustPct('0');
      // v2 — 기존 값 그대로 로드(미지정은 미지정 유지). 견적번호·발행일은 저장값 보존.
      const it0 = d.issueType === 'vendor_confirmed' || d.issueType === 'internal_simulation' ? d.issueType : '';
      setIssueType(it0); setLegacyUnset(it0 === '');
      setTerms(cleanTerms(d.terms)); setDesign(normalizeDesign(d.designSettings)); setCreatedAt(d.createdAt ?? null);
      setLogoImg({ action: 'keep', preview: d.logoDataUrl ?? null }); setStampImg({ action: 'keep', preview: d.stampDataUrl ?? null });
      setSelectedVendorId('');
      setCustomer({ customerCompanyName: d.customerCompanyName, customerRepresentativeName: d.customerRepresentativeName, customerContactName: d.customerContactName, customerPhone: d.customerPhone, customerEmail: d.customerEmail });
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

  // 저장/미리보기 공용 품목 페이로드
  const itemPayload = () => rows.filter((r) => r.description.trim()).map((r, i) => ({
    sourceQuoteItemId: r.sourceQuoteItemId, description: r.description.trim(), languagePair: r.languagePair || null,
    quantity: num(r.quantity), unit: r.unit || '건', unitPrice: num(r.unitPrice), amount: num(r.amount), memo: r.memo || null, sortOrder: i,
  }));

  // 작성 중인 내용 그대로 미리보기(저장 전) — 저장 후 PDF 와 같은 렌더러.
  const previewDraft = () => {
    if (!companyName.trim()) { onToast('상호명을 입력해 주세요.'); return; }
    setPdfImageError(null);
    setPdfData(buildComparisonQuotePdfData({
      companyName: companyName.trim(), representativeName, businessNumber, address, phone, email, website, contactName,
      displayNumber, quoteDate: quoteDate || null, vatMode, memo, items: itemPayload(),
      customerCompanyName: customer.customerCompanyName, customerRepresentativeName: customer.customerRepresentativeName,
      customerContactName: customer.customerContactName, customerPhone: customer.customerPhone, customerEmail: customer.customerEmail,
      issueType: issueType || null, terms, designSettings: design,
      logoDataUrl: logoImg.preview, stampDataUrl: stampImg.preview, createdAt,
    }));
  };

  const save = async () => {
    if (!companyName.trim()) { onToast('상호명을 입력해 주세요.'); return; }
    // 새 비교견적은 발행 구분을 반드시 직접 선택(자동 확정 금지). 기존 미지정 건은 미지정 그대로 저장 가능.
    if (!editingId && !issueType) { onToast('발행 구분(실제 업체 견적 / 내부 비교용)을 선택해 주세요.'); return; }
    setSaving(true);
    try {
      const body = {
        companyName: companyName.trim(), representativeName, businessNumber, address, phone, email, website, contactName,
        displayNumber, quoteDate: quoteDate || null, vatMode, memo,
        issueType: issueType || null, terms: cleanTerms(terms), designSettings: design,
        vendorId: selectedVendorId ? Number(selectedVendorId) : null,
        logoAction: logoImg.action, stampAction: stampImg.action,
        items: itemPayload(),
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
      setPdfImageError(d.imageError ?? null);
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
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>
                            <span data-testid="cq-list-issue-badge" style={{ fontSize: 10.5, fontWeight: 800, borderRadius: 999, padding: '1px 8px', marginRight: 6, verticalAlign: 1,
                              background: r.issueType === 'vendor_confirmed' ? '#dcfce7' : '#fef3c7', color: r.issueType === 'vendor_confirmed' ? '#166534' : '#92400e' }}>
                              {r.issueType === 'vendor_confirmed' ? '실제 업체 견적' : r.issueType === 'internal_simulation' ? '내부 비교용' : '내부 비교용 · 미지정'}
                            </span>
                            {r.companyName}{r.displayNumber ? <span style={{ color: '#9ca3af', fontWeight: 500, marginLeft: 6, fontSize: 11 }}>{r.displayNumber}</span> : null}
                          </div>
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
                <IssueTypeSelector value={issueType} onChange={setIssueType} legacyUnset={legacyUnset} />

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
                      options={[{ value: '', label: '직접 입력' }, ...vendors.map((v) => ({ value: String(v.id), label: v.companyName, sub: [`#${v.id}`, v.phone, v.email, v.businessNumber].filter(Boolean).join(' · ') }))]}
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
                  {/* 표시 순서 = PDF 공급자(FROM) 순서: 상호 · 대표자 · 사업자등록번호 · 연락처 · 이메일 → 주소 · 홈페이지 · 담당자 */}
                  <div><label style={lbl}>대표자명</label><input value={representativeName} onChange={(e) => setRep(e.target.value)} style={inp} aria-label="대표자명" data-testid="cq-rep-name" /></div>
                  <div><label style={lbl}>사업자등록번호</label><input value={businessNumber} onChange={(e) => setBiz(e.target.value)} style={inp} aria-label="사업자등록번호" data-testid="cq-business-number" /></div>
                  <div><label style={lbl}>연락처</label><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="예: 1600-0000" style={inp} aria-label="연락처" data-testid="cq-phone" /></div>
                  <div><label style={lbl}>이메일</label><input value={email} onChange={(e) => setEmail(e.target.value)} style={inp} aria-label="이메일" data-testid="cq-email" /></div>
                  <div><label style={lbl}>담당자명</label><input value={contactName} onChange={(e) => setContact(e.target.value)} style={inp} aria-label="담당자명" data-testid="cq-contact-name" /></div>
                  <div style={{ gridColumn: '1 / 3' }}><label style={lbl}>주소</label><input value={address} onChange={(e) => setAddress(e.target.value)} style={inp} aria-label="주소" data-testid="cq-address" /></div>
                  <div><label style={lbl}>홈페이지</label><input value={website} onChange={(e) => setWebsite(e.target.value)} style={inp} aria-label="홈페이지" data-testid="cq-website" /></div>
                </div>

                <BrandingPanel
                  vendorSelected={!!selectedVendorId} isSimulation={issueType !== 'vendor_confirmed'}
                  logo={logoImg} stamp={stampImg} busy={vendorBusy}
                  onRemove={(k) => (k === 'logo' ? setLogoImg({ action: 'clear', preview: null }) : setStampImg({ action: 'clear', preview: null }))}
                  onUpload={uploadVendorImage} onDeleteFromVendor={deleteVendorImage}
                  design={design} onDesign={setDesign}
                />

                {/* 문서 정보 */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
                  <div><label style={lbl}>견적번호 (표시용, 선택)</label><input value={displayNumber} onChange={(e) => setDisplayNumber(e.target.value)} placeholder="예: ABC-2026-001" style={inp} data-testid="cq-display-number" /></div>
                  <div><label style={lbl}>발행일</label><input type="date" value={quoteDate} onChange={(e) => setQuoteDate(e.target.value)} style={inp} /></div>
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
                        <input value={r.description} onChange={(e) => setRow(i, { description: e.target.value })} placeholder="품목명 (예: 영한번역)" style={cellInp}
                          aria-label={`${i + 1}번 품목명`} data-testid={`cq-item-name-${i}`} />
                        <input value={r.memo} onChange={(e) => setRow(i, { memo: e.target.value })} placeholder="품목 설명 (고객에게 표시)" style={{ ...cellInp, marginTop: 4, fontSize: 11, color: '#6b7280' }}
                          aria-label={`${i + 1}번 품목 설명`} data-testid={`cq-item-desc-${i}`} />
                        {(toLanguageDirectionLabel(r.description) || hasInternalText(r.memo)) && (
                          <div style={{ fontSize: 10.5, marginTop: 3, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {toLanguageDirectionLabel(r.description) && <span style={{ color: '#0f766e' }}>언어: {toLanguageDirectionLabel(r.description)}</span>}
                            {hasInternalText(r.memo) && (
                              <span style={{ color: '#b45309' }} data-testid={`cq-item-internal-${i}`}>
                                내부 관리 문구는 PDF 미출력 → {toCustomerFacingNote(r.memo) ? `"${toCustomerFacingNote(r.memo)}"만 출력` : '설명 출력 없음'}
                              </span>
                            )}
                          </div>
                        )}
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

                <TermsEditor terms={terms} onChange={setTerms} />

                <div><label style={lbl}>비고 (PDF 하단 표시)</label><textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} style={{ ...inp, resize: 'vertical' }} /></div>
              </>
            )}
          </div>

          {/* 푸터 */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '14px 22px', borderTop: '1px solid #eef2f7' }}>
            {view === 'form' ? (
              <>
                <button onClick={() => { resetForm(); setView('list'); }} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>목록으로</button>
                <button onClick={previewDraft} aria-label="작성 중인 비교견적 미리보기" data-testid="cq-preview-draft"
                  style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #99f6e4', background: '#f0fdfa', color: '#0f766e', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>미리보기</button>
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

      {pdfData && <ComparisonQuotePdfPreviewModal data={pdfData} imageError={pdfImageError} onClose={() => setPdfData(null)} />}
    </>
  );
}
