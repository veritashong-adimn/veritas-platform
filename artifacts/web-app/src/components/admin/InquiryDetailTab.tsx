/**
 * InquiryDetailTab — 의뢰건 상세
 *
 * 접수 원문 표시 + 기존 거래처/담당자 확정 연결 + [견적서 작성](의뢰정보 프리필 전달) + [견적 없이 종결](사유 필수).
 * 처리/견적 상태는 서버 파생값을 표시(중복 저장 없음). 기존 거래처/담당자 검색·생성 흐름을 재사용한다.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { confirmAndDeleteInquiry } from './inquiryDeleteFlow';
import { api } from '../../lib/constants';
import { CHANNEL_LABEL, PROCESSING_META, QUOTE_PROGRESS_META, INQUIRY_CLOSE_REASONS, CLOSE_REASON_LABEL, EquipmentRow, inquiryServiceTypes, inquiryServiceLabel, parseDocumentTypes, formatDocumentTypes } from '../../lib/inquiryMeta';
import { setQuoteHandoff, buildHandoffItems, parseEquipmentJson, buildInquiryQuoteNote, buildProductHints, additionalLanguagesOf } from '../../lib/inquiryHandoff';
import { InquiryFormFields, InquiryFormState, inquiryFormFromDetail, buildInquiryPayload, validateInquiryServices } from './InquiryFormFields';
import { BackToListButton } from './BackToListButton';

const th: React.CSSProperties = { padding: '7px 10px', textAlign: 'left', fontSize: 12, color: '#6b7280', fontWeight: 600, width: 130, verticalAlign: 'top', whiteSpace: 'nowrap' };
const tdv: React.CSSProperties = { padding: '7px 10px', fontSize: 13, color: '#111827' };
const badge = (m: { label: string; color: string; bg: string; border: string }): React.CSSProperties => ({ display: 'inline-block', fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 6, background: m.bg, color: m.color, border: `1px solid ${m.border}` });
const btn = (bg: string, color = '#fff', border = 'none'): React.CSSProperties => ({ padding: '8px 16px', fontSize: 13, fontWeight: 700, borderRadius: 8, border, background: bg, color, cursor: 'pointer' });
const fmtDateTime = (s: string | null) => s ? new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '—';
// 고객 접수일시 — 날짜/시각/확인 상태. 상태가 없으면 기존 자료(미분류): received_at 을 고객 접수일시로 표시하지 않는다.
const CR_STATUS_LABEL: Record<string, string> = { confirmed: '확정', needs_review: '확인 필요', not_provided: '미기재' };
const CR_SOURCE_LABEL: Record<string, string> = { homepage: '홈페이지 고객 제출', email_received: '메일 수신일시', email_sent: '메일 발송일시', manual: '직원 입력', unknown: '출처 미상' };
const fmtCustomerReceived = (d: { customerReceivedDate?: string | null; customerReceivedTime?: string | null; customerReceivedStatus?: string | null; customerReceivedSource?: string | null }) => {
  if (!d.customerReceivedStatus) return '기존 자료(미분류)';
  const when = d.customerReceivedDate
    ? `${d.customerReceivedDate.replace(/-/g, '. ')}.${d.customerReceivedTime ? ' ' + d.customerReceivedTime.slice(0, 5) : ' (시각 미기재)'}`
    : '공란';
  const src = d.customerReceivedSource && d.customerReceivedSource !== 'unknown' ? ` · ${CR_SOURCE_LABEL[d.customerReceivedSource] ?? d.customerReceivedSource}` : '';
  return `${when} [${CR_STATUS_LABEL[d.customerReceivedStatus] ?? d.customerReceivedStatus}]${src}`;
};
// 날짜만 있는 항목(견적서 수령 희망일·완료 희망일) — 시각을 표시하지 않는다(저장값의 00:00 UTC가 "오전 9:00"으로 보이던 문제)
const fmtDate = (s: string | null) => s ? new Date(s).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' }) : '—';
// 일정: 시간 미정은 00:00(KST)으로 저장된다(InquiryFormFields) → 날짜만 + "시간 미정" 표시
const fmtSchedule = (s: string | null) => {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '—';
  const hm = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' });
  return hm === '00:00' ? `${d.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })} (시간 미정)` : fmtDateTime(s);
};

interface Detail {
  id: number; inquiryNumber: string | null; receivedAt: string; channel: string; status: string;
  createdAt?: string | null;   // 시스템 등록일시
  customerReceivedDate?: string | null; customerReceivedTime?: string | null; customerReceivedStatus?: string | null; customerReceivedSource?: string | null;
  assignedPmId: number | null; pmName: string | null;
  customerCompanyName: string | null; contactName: string | null; department: string | null; contactPosition: string | null; contactPhone: string | null; contactMobile: string | null; contactEmail: string | null;
  companyId: number | null; contactId: number | null; divisionId: number | null;
  companyName: string | null; contactNameLinked: string | null; divisionName: string | null;
  contactEmailLinked?: string | null; contactPhoneLinked?: string | null; contactMobileLinked?: string | null;   // 연결 담당자 Master 연락처
  serviceType: string | null; languageFrom: string | null; languageTo: string | null;
  serviceTypes?: string[] | null; otherServices?: string[] | null;   // 복수 선택(없으면 serviceType 1개)
  scheduleFrom: string | null; scheduleTo: string | null; place: string | null; volume: string | null; subject: string | null; requirements: string | null;
  quoteDueDate: string | null; interpretType: string | null; interpretDuration: string | null;
  documentType: string | null; documentUsage: string | null; desiredCompletionDate: string | null;
  equipmentJson: string | null;
  rawSource: string | null; attachmentsJson: string | null;
  quoteId: number | null; quoteNumber: string | null; quoteProgress: string; saleConverted: boolean; processingStatus: string; quotePrice: number | null; quoteIssueDate: string | null;
  closeReasonCode: string | null; closeReasonDetail: string | null; closedAt: string | null;
}

export function InquiryDetailTab({ token, inquiryId, onBack, onToast, onNavigateQuoteRegister, onOpenQuote, adminUsers = [], canDelete = false, onDeleted }: {
  token: string; inquiryId: number; onBack: () => void; onToast: (m: string) => void;
  /** 의뢰건 삭제 권한 — [의뢰건 삭제] 표시(서버에서도 검증). 삭제 성공 시 onDeleted(목록으로 이동) */
  canDelete?: boolean; onDeleted?: () => void;
  onNavigateQuoteRegister: () => void; onOpenQuote?: (quoteId: number) => void;
  adminUsers?: Array<{ id: number; name?: string | null; email: string }>;
}) {
  const authH = { Authorization: `Bearer ${token}` };
  const [d, setD] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeCode, setCloseCode] = useState('');
  const [closeDetail, setCloseDetail] = useState('');
  // 인라인 수정 모드 — 서비스 유형별 접수정보 전체 편집
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<InquiryFormState | null>(null);
  const [editEquip, setEditEquip] = useState<EquipmentRow[]>([]);
  const [editAttach, setEditAttach] = useState<Array<{ name: string; url: string }>>([]);
  const [uploading, setUploading] = useState(false);
  // 거래처/담당자 연결 검색
  const [linkOpen, setLinkOpen] = useState(false);
  const [companyQ, setCompanyQ] = useState('');
  const [companyResults, setCompanyResults] = useState<Array<{ id: number; name: string }>>([]);
  const [contactResults, setContactResults] = useState<Array<{ id: number; name: string; department?: string | null; position?: string | null }>>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(api(`/api/admin/inquiries/${inquiryId}`), { headers: authH });
      const data = await res.json().catch(() => null);
      if (!res.ok) { onToast(data?.error ?? '의뢰건 조회 실패'); setD(null); return; }
      setD(data);
    } catch { onToast('의뢰건 조회 중 오류'); setD(null); }
    finally { setLoading(false); }
  }, [inquiryId, token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const patch = async (body: any, okMsg?: string) => {
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/inquiries/${inquiryId}`), { method: 'PATCH', headers: { ...authH, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? '수정 실패'); return false; }
      if (okMsg) onToast(okMsg);
      await load();
      return true;
    } catch { onToast('수정 중 오류'); return false; }
    finally { setBusy(false); }
  };

  // ── 인라인 수정(서비스별 접수정보 전체) ──────────────────────────────────────
  const startEdit = () => {
    if (!d) return;
    const eq: EquipmentRow[] = parseEquipmentJson(d.equipmentJson).map(r => ({
      kind: r.kind ?? '', quantity: r.quantity ?? '1', unit: r.unit ?? '세트', location: r.location ?? '', note: r.note ?? '', days: r.days ?? '',
      // 원본 참고단가는 화면에서 수정하지 않지만 다시 저장할 때 지워지지 않게 그대로 둔다
      ...(r.refUnitPrice ? { refUnitPrice: r.refUnitPrice } : {}), ...(r.refAmount ? { refAmount: r.refAmount } : {}),
    }));
    setEditEquip(eq);
    setEditAttach((() => { try { return d.attachmentsJson ? JSON.parse(d.attachmentsJson) : []; } catch { return []; } })());
    setForm(inquiryFormFromDetail(d, eq));
    setEditing(true);
  };
  const cancelEdit = () => { setEditing(false); setForm(null); };
  const setField = (k: keyof InquiryFormState, v: string | boolean | string[]) => setForm(prev => (prev ? { ...prev, [k]: v } : prev));
  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData(); fd.append('file', file);
        const res = await fetch(api('/api/upload'), { method: 'POST', headers: authH, body: fd });
        const dt = await res.json().catch(() => ({}));
        if (!res.ok) { onToast(dt.error ?? '첨부 업로드 실패'); continue; }
        setEditAttach(prev => [...prev, { name: file.name, url: dt.fileUrl }]);
      }
    } finally { setUploading(false); }
  };
  const saveEdit = async () => {
    if (!form) return;
    const svcErr = validateInquiryServices(form);
    if (svcErr) { onToast(svcErr); return; }
    // 견적 연결 여부와 무관하게 의뢰건 원본만 수정한다(연결된 견적서 내용은 자동으로 덮어쓰지 않음).
    const ok = await patch(buildInquiryPayload(form, editEquip, editAttach), '수정 내용이 저장되었습니다.');
    if (ok) { setEditing(false); setForm(null); }
  };

  // 거래처 검색 (기존 목록 API 재사용, 클라이언트 필터)
  const searchCompanies = async (q: string) => {
    setCompanyQ(q);
    if (!q.trim()) { setCompanyResults([]); return; }
    try {
      const res = await fetch(api('/api/admin/companies'), { headers: authH });
      const arr = await res.json().catch(() => []);
      const list = (Array.isArray(arr) ? arr : []).filter((c: any) => (c.name ?? '').toLowerCase().includes(q.toLowerCase())).slice(0, 8);
      setCompanyResults(list.map((c: any) => ({ id: c.id, name: c.name })));
    } catch { setCompanyResults([]); }
  };
  const loadContacts = async (companyId: number) => {
    try {
      const res = await fetch(api(`/api/admin/contacts?companyId=${companyId}`), { headers: authH });
      const arr = await res.json().catch(() => []);
      const list = Array.isArray(arr) ? arr : (arr?.rows ?? []);
      setContactResults(list.map((c: any) => ({ id: c.id, name: c.name, department: c.department, position: c.position })));
    } catch { setContactResults([]); }
  };
  const linkCompany = async (c: { id: number; name: string }) => {
    if (await patch({ companyId: c.id, contactId: null }, `거래처 '${c.name}' 연결됨`)) { loadContacts(c.id); }
  };

  // [견적서 작성] → 의뢰정보 프리필 handoff 저장 후 견적 등록 화면으로 이동
  // [견적서 작성] → 의뢰정보 프리필 handoff 저장 후 견적 등록 화면으로 이동
  //  · 견적서명: 거래처명 + 언어 + 서비스 형태(공통 규칙, 통역 주제는 쓰지 않음)
  //  · 거래처/담당자: Master 연결값(ID)은 그대로, 미연결이면 의뢰건 원문 정보를 inquiryContext 로 전달(견적 화면에서 검색·연결)
  //  · 상품 행: 수행일·장소·통역시간을 행의 정식 필드로, 상품은 productHints 로 견적 화면이 상품 Master 에서 추천
  //  · 메모: 정식 필드로 전달되는 값은 빼고, 견적서에 담을 필드가 없는 정보만
  const goQuote = () => {
    if (!d) return;
    const types = inquiryServiceTypes(d);
    const isTrans = types.includes('translation');
    const items = buildHandoffItems(d);
    // 견적 비고(고객 PDF 출력) — 요청사항·추가 언어·정식 필드가 없는 번역 정보만
    const note = buildInquiryQuoteNote(d, [
      isTrans && d.documentUsage ? `문서 사용처: ${d.documentUsage}` : '',
      isTrans && d.desiredCompletionDate ? `번역 완료 희망일: ${fmtDate(d.desiredCompletionDate)}` : '',
    ]);
    setQuoteHandoff({
      inquiryId: d.id, inquiryNumber: d.inquiryNumber,
      companyId: d.companyId, contactId: d.contactId, divisionId: d.divisionId,
      // 견적서명은 견적 화면의 플랫폼 표준 규칙(거래처명_대표상품_YYYYMMDD)으로 자동 생성 — 여기서 보내지 않는다(통역 주제 사용 금지)
      note,
      // 서비스별 견적항목 시드(통역/장비/번역 — 복수 선택 시 각각, 금액 없음). 기타 세부 서비스는 메모로만 전달(항목·금액 자동 생성 없음).
      items,
      productHints: buildProductHints(d, items),
      inquiryContext: {
        customerCompanyName: d.customerCompanyName, companyNameLinked: d.companyName,
        contact: { name: d.contactName, position: d.contactPosition, department: d.department, phone: d.contactPhone, mobile: d.contactMobile, email: d.contactEmail },
        contactNameLinked: d.contactNameLinked,
        additionalLanguages: additionalLanguagesOf(d.requirements),
        quoteDueDate: d.quoteDueDate ? new Date(new Date(d.quoteDueDate).getTime() + 9 * 3600_000).toISOString().slice(0, 10) : null,
      },
    });
    onNavigateQuoteRegister();
  };

  const doClose = async () => {
    if (!closeCode) { onToast('종결 사유를 선택해 주세요.'); return; }
    if (closeCode === 'other' && !closeDetail.trim()) { onToast('기타 선택 시 상세 사유를 입력해 주세요.'); return; }
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/inquiries/${inquiryId}/close`), { method: 'POST', headers: { ...authH, 'Content-Type': 'application/json' }, body: JSON.stringify({ reasonCode: closeCode, reasonDetail: closeDetail || null }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? '종결 실패'); return; }
      onToast('견적 없이 종결 처리되었습니다.');
      setCloseOpen(false); setCloseCode(''); setCloseDetail('');
      await load();
    } catch { onToast('종결 중 오류'); }
    finally { setBusy(false); }
  };

  if (!d) return <div style={{ padding: 24, color: '#9ca3af' }}>{loading ? '불러오는 중…' : '의뢰건을 찾을 수 없습니다.'}</div>;

  const pm = PROCESSING_META[d.processingStatus] ?? PROCESSING_META.new;
  const svc = inquiryServiceTypes(d);   // 복수 선택(없으면 기존 단일 serviceType)
  const qm = QUOTE_PROGRESS_META[d.quoteProgress] ?? QUOTE_PROGRESS_META.none;
  const closed = d.processingStatus === 'closed_no_quote';
  const attachments: Array<{ name: string; url: string }> = (() => { try { return d.attachmentsJson ? JSON.parse(d.attachmentsJson) : []; } catch { return []; } })();
  const equipmentRows = parseEquipmentJson(d.equipmentJson);

  return (
    <div data-testid="inquiry-detail-tab" style={{ maxWidth: 920 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <BackToListButton onClick={onBack} variant="subtle" label="뒤로가기" testId="inq-detail-back" />
        <h1 style={{ fontSize: 20, fontWeight: 800, color: '#111827', margin: 0 }}>{d.inquiryNumber ?? `의뢰건 #${d.id}`}</h1>
        <span style={badge(pm)}>{pm.label}</span>
        <span style={badge(qm)}>{qm.label}</span>
        {d.saleConverted && <span style={badge({ label: '판매전환', color: '#065f46', bg: '#d1fae5', border: '#6ee7b7' })}>판매전환</span>}
        <div style={{ flex: 1 }} />
        {/* 액션 (수정 모드에서는 숨김) */}
        {!closed && !editing && <button type="button" onClick={startEdit} data-testid="inq-edit-open" style={btn('#f5f3ff', '#7c3aed', '1px solid #ddd6fe')}>수정</button>}
        {!closed && !editing && d.status === 'new' && <button type="button" onClick={() => patch({ status: 'reviewing' }, '확인중으로 변경')} disabled={busy} data-testid="inq-mark-reviewing" style={btn('#eff6ff', '#2563eb', '1px solid #bfdbfe')}>확인중으로</button>}
        {!closed && !editing && <button type="button" onClick={goQuote} data-testid="inq-to-quote" style={btn('#2563eb')}>견적서 작성</button>}
        {!closed && !editing && !d.quoteId && <button type="button" onClick={() => setCloseOpen(true)} data-testid="inq-close-open" style={btn('#fef2f2', '#dc2626', '1px solid #fecaca')}>견적 없이 종결</button>}
        {!editing && d.quoteId && d.quoteNumber && (
          <button type="button" onClick={() => onOpenQuote?.(d.quoteId!)} data-testid="inq-open-quote" style={btn('#ecfdf5', '#059669', '1px solid #a7f3d0')}>연결 견적 {d.quoteNumber}</button>
        )}
        {canDelete && onDeleted && !editing && (
          <button type="button" disabled={busy} data-testid="inq-delete" aria-label="의뢰건 삭제"
            onClick={async () => {
              setBusy(true);
              try {
                const out = await confirmAndDeleteInquiry(token, d.id);
                if (out.deleted) { onToast(out.message!); onDeleted(); }
              } finally { setBusy(false); }
            }}
            style={btn('#fff', '#dc2626', '1px solid #fecaca')}>의뢰건 삭제</button>
        )}
      </div>

      {editing && form && (
        <div data-testid="inq-edit-form" style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '18px 22px', marginBottom: 8 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#111827', marginBottom: 4 }}>의뢰 내용 수정</div>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 8px' }}>서비스 유형·통역/번역/장비/기타 정보를 수정합니다.{d.quoteId ? ' 연결된 견적서 내용은 자동으로 변경되지 않습니다.' : ''}</p>
          <InquiryFormFields
            f={form} set={setField} systemRegisteredAt={d.createdAt ?? null}
            equipment={editEquip} setEquipment={setEditEquip}
            adminUsers={adminUsers}
            attachments={editAttach} onUpload={handleUpload} onRemoveAttachment={(i) => setEditAttach(prev => prev.filter((_, j) => j !== i))} uploading={uploading}
          />
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 22 }}>
            <button type="button" onClick={cancelEdit} disabled={busy} data-testid="inq-edit-cancel" style={btn('#f9fafb', '#374151', '1px solid #d1d5db')}>취소</button>
            <button type="button" onClick={saveEdit} disabled={busy} data-testid="inq-edit-save" style={btn(busy ? '#93c5fd' : '#2563eb')}>{busy ? '저장 중…' : '저장'}</button>
          </div>
        </div>
      )}

      {!editing && (
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {/* 접수/의뢰 내용 */}
        <div style={{ flex: '1 1 440px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px', fontWeight: 800, fontSize: 13, borderBottom: '1px solid #f1f5f9', color: '#111827' }}>접수 · 의뢰 내용</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}><tbody>
            {([
              ['고객 접수일시', fmtCustomerReceived(d)],
              ['시스템 등록일시', fmtDateTime(d.createdAt ?? null)],
              ['접수경로', CHANNEL_LABEL[d.channel] ?? d.channel],
              ['담당 PM', d.pmName ?? '미지정'],
              ['서비스 유형', inquiryServiceLabel(d) || '—'],
              ['견적서 수령 희망일', fmtDate(d.quoteDueDate)],
              // 언어는 통역/번역만 표시
              ...((svc.includes('interpretation') || svc.includes('translation')) ? [
                ['언어', [d.languageFrom, d.languageTo].filter(Boolean).join('→') || '—'],
              ] : []),
              // 통역 전용
              ...(svc.includes('interpretation') ? [
                ['통역 형태', d.interpretType ?? '—'],
                ['통역 일시', [fmtSchedule(d.scheduleFrom), fmtSchedule(d.scheduleTo)].filter(x => x !== '—').join(' ~ ') || '—'],
                ['1일 통역시간', d.interpretDuration ?? '—'],
                ['통역 장소', d.place ?? '—'],
              ] : []),
              // 번역 전용
              ...(svc.includes('translation') ? [
                ['원문서 형태', d.documentType ? formatDocumentTypes(parseDocumentTypes(d.documentType)) : '—'],   // 구 값(한글·PowerPoint)도 현재 항목명으로
                ['번역 분량', d.volume ?? '—'],
                ['문서 사용처', d.documentUsage ?? '—'],
                ['완료 희망일', fmtDate(d.desiredCompletionDate)],
              ] : []),
              // 장비(통역과 함께면 일정·장소는 통역 항목과 동일 — 중복 표시 생략)
              ...(svc.includes('equipment') && !svc.includes('interpretation') ? [
                ['장비 사용기간', [fmtSchedule(d.scheduleFrom), fmtSchedule(d.scheduleTo)].filter(x => x !== '—').join(' ~ ') || '—'],
                ['사용 장소', d.place ?? '—'],
              ] : []),
              // 기타(통역·장비가 없을 때만 일정·장소 표시)
              ...(svc.includes('other') && !svc.includes('interpretation') && !svc.includes('equipment') ? [
                ['희망 일정', [fmtSchedule(d.scheduleFrom), fmtSchedule(d.scheduleTo)].filter(x => x !== '—').join(' ~ ') || '—'],
                ['장소', d.place ?? '—'],
              ] : []),
              ['주제/내용', d.subject ?? '—'],
              ['요구사항', d.requirements ?? '—'],
            ] as [string, string][]).map(([k, v]) => <tr key={k} style={{ borderBottom: '1px solid #f6f8fa' }}><th style={th}>{k}</th><td style={tdv}>{v}</td></tr>)}
            <tr><th style={th}>담당 PM 지정</th><td style={tdv}>
              <select value={d.assignedPmId ?? ''} onChange={e => patch({ assignedPmId: e.target.value ? Number(e.target.value) : null }, 'PM 변경됨')} disabled={busy || closed} data-testid="inq-detail-pm" style={{ padding: '5px 8px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 6 }}>
                <option value="">미지정</option>
                {adminUsers.map(u => <option key={u.id} value={u.id}>{u.name ?? u.email}</option>)}
              </select>
            </td></tr>
          </tbody></table>
          {equipmentRows.length > 0 && (
            <div style={{ padding: '10px 14px', borderTop: '1px solid #f1f5f9' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 6 }}>통역장비 · {equipmentRows.length}건</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}><tbody>
                {equipmentRows.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #f6f8fa' }}>
                    <td style={{ padding: '5px 8px', fontWeight: 700, color: '#111827', whiteSpace: 'nowrap' }}>{r.kind || '—'}</td>
                    <td style={{ padding: '5px 8px', color: '#374151', whiteSpace: 'nowrap' }}>{[r.quantity, r.unit].filter(Boolean).join(' ') || '—'}{r.days ? ` × ${r.days}일` : ''}</td>
                    <td style={{ padding: '5px 8px', color: '#6b7280' }}>{r.location || ''}</td>
                    <td style={{ padding: '5px 8px', color: '#6b7280' }}>{r.note || ''}</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          )}
          {attachments.length > 0 && (
            <div style={{ padding: '10px 14px', borderTop: '1px solid #f1f5f9' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 }}>첨부파일</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>{attachments.map((a, i) => <li key={i}><a href={a.url} target="_blank" rel="noreferrer" style={{ color: '#2563eb' }}>{a.name}</a></li>)}</ul>
            </div>
          )}
        </div>

        {/* 고객/연결 */}
        <div style={{ flex: '1 1 380px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden', alignSelf: 'flex-start' }}>
          <div style={{ padding: '10px 14px', fontWeight: 800, fontSize: 13, borderBottom: '1px solid #f1f5f9', color: '#111827', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>고객 · 거래처 연결</span>
            {!closed && <button type="button" onClick={() => { setLinkOpen(o => !o); if (d.companyId) loadContacts(d.companyId); }} data-testid="inq-link-toggle" style={{ fontSize: 12, fontWeight: 700, color: '#2563eb', border: 'none', background: 'none', cursor: 'pointer' }}>{linkOpen ? '닫기' : '연결/변경'}</button>}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}><tbody>
            {[
              ['원문 회사명', d.customerCompanyName ?? '—'],
              ['원문 담당자', d.contactName ?? '—'],
              ['부서', d.department ?? '—'],
              ['직함', d.contactPosition ?? '—'],
              ['전화번호', d.contactPhone ?? '—'],
              ['휴대폰', d.contactMobile ?? '—'],
              ['이메일', d.contactEmail ?? '—'],
            ].map(([k, v]) => <tr key={k} style={{ borderBottom: '1px solid #f6f8fa' }}><th style={th}>{k}</th><td style={tdv}>{v}</td></tr>)}
            <tr style={{ borderBottom: '1px solid #f6f8fa' }}><th style={th}>확정 거래처</th><td style={tdv}>{d.companyName ? <b>{d.companyName}</b> : <span style={{ color: '#9ca3af' }}>미연결</span>}</td></tr>
            <tr><th style={th}>확정 담당자</th><td style={tdv}>{d.contactNameLinked ? <b>{d.contactNameLinked}</b> : <span style={{ color: '#9ca3af' }}>미연결</span>}</td></tr>
          </tbody></table>

          {linkOpen && !closed && (
            <div style={{ padding: '12px 14px', borderTop: '1px solid #f1f5f9', background: '#fafbfc' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 }}>거래처 검색·연결</div>
              <input value={companyQ} onChange={e => searchCompanies(e.target.value)} placeholder="거래처명 검색" data-testid="inq-company-search"
                style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 8 }} />
              {companyResults.length > 0 && (
                <div style={{ marginTop: 6, border: '1px solid #e5e7eb', borderRadius: 8, maxHeight: 160, overflow: 'auto', background: '#fff' }}>
                  {companyResults.map(c => (
                    <div key={c.id} onClick={() => linkCompany(c)} data-testid={`inq-company-opt-${c.id}`}
                      style={{ padding: '7px 10px', fontSize: 13, cursor: 'pointer', borderBottom: '1px solid #f6f8fa' }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')} onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>{c.name}</div>
                  ))}
                </div>
              )}
              {d.companyId && (
                <>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', margin: '12px 0 6px' }}>담당자 연결 (연결된 거래처 소속)</div>
                  {contactResults.length === 0 ? <div style={{ fontSize: 12, color: '#9ca3af' }}>담당자가 없습니다. 거래처 관리에서 등록 후 연결하세요.</div> : (
                    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, maxHeight: 160, overflow: 'auto', background: '#fff' }}>
                      {contactResults.map(c => (
                        <div key={c.id} onClick={() => patch({ contactId: c.id }, `담당자 '${c.name}' 연결됨`)} data-testid={`inq-contact-opt-${c.id}`}
                          style={{ padding: '7px 10px', fontSize: 13, cursor: 'pointer', borderBottom: '1px solid #f6f8fa' }}
                          onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')} onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>
                          {c.name} <span style={{ color: '#9ca3af', fontSize: 11 }}>{[c.department, c.position].filter(Boolean).join(' / ')}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
              <p style={{ fontSize: 11, color: '#9ca3af', margin: '10px 0 0' }}>※ 신규 거래처/담당자는 「고객·거래처」 메뉴에서 등록 후 여기서 연결하세요.</p>
            </div>
          )}

          {closed && (
            <div style={{ padding: '12px 14px', borderTop: '1px solid #f1f5f9', background: '#f9fafb' }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: '#6b7280', marginBottom: 4 }}>견적 없이 종결</div>
              <div style={{ fontSize: 13, color: '#111827' }}>{d.closeReasonCode ? (CLOSE_REASON_LABEL[d.closeReasonCode] ?? d.closeReasonCode) : '—'}</div>
              {d.closeReasonDetail && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{d.closeReasonDetail}</div>}
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>종결일시: {fmtDateTime(d.closedAt)}</div>
            </div>
          )}
        </div>
      </div>
      )}

      {/* 견적 없이 종결 모달 */}
      {closeOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => { if (!busy) setCloseOpen(false); }}>
          <div onClick={e => e.stopPropagation()} data-testid="inq-close-modal"
            style={{ background: '#fff', borderRadius: 14, padding: '24px 28px', width: 460, maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,0.25)', borderTop: '4px solid #dc2626' }}>
            <h2 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 800, color: '#111827' }}>견적 없이 종결</h2>
            <p style={{ margin: '0 0 14px', fontSize: 13, color: '#6b7280' }}>종결 사유는 영업분석을 위해 반드시 기록됩니다. 종결된 건은 삭제되지 않습니다.</p>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 }}>종결 사유 <span style={{ color: '#dc2626' }}>*</span></label>
            <select value={closeCode} onChange={e => setCloseCode(e.target.value)} data-testid="inq-close-code"
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 8, marginBottom: 12 }}>
              <option value="">사유 선택</option>
              {INQUIRY_CLOSE_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 }}>상세 사유 {closeCode === 'other' ? <span style={{ color: '#dc2626' }}>*</span> : <span style={{ color: '#9ca3af', fontWeight: 400 }}>(선택)</span>}</label>
            <textarea value={closeDetail} onChange={e => setCloseDetail(e.target.value)} rows={3} data-testid="inq-close-detail"
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 8, resize: 'vertical', marginBottom: 16 }} />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setCloseOpen(false)} disabled={busy} data-testid="inq-close-cancel" style={btn('#f9fafb', '#374151', '1px solid #d1d5db')}>취소</button>
              <button onClick={doClose} disabled={busy} data-testid="inq-close-confirm" style={btn(busy ? '#fca5a5' : '#dc2626')}>{busy ? '처리 중…' : '견적 없이 종결'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default InquiryDetailTab;
