/**
 * InquiryDetailTab — 의뢰건 상세
 *
 * 접수 원문 표시 + 기존 거래처/담당자 확정 연결 + [견적서 작성](의뢰정보 프리필 전달) + [견적 없이 종결](사유 필수).
 * 처리/견적 상태는 서버 파생값을 표시(중복 저장 없음). 기존 거래처/담당자 검색·생성 흐름을 재사용한다.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/constants';
import { CHANNEL_LABEL, SERVICE_LABEL, PROCESSING_META, QUOTE_PROGRESS_META, INQUIRY_CLOSE_REASONS, CLOSE_REASON_LABEL, EquipmentRow } from '../../lib/inquiryMeta';
import { setQuoteHandoff, buildHandoffItems, parseEquipmentJson } from '../../lib/inquiryHandoff';
import { InquiryFormFields, InquiryFormState, inquiryFormFromDetail, buildInquiryPayload } from './InquiryFormFields';

const th: React.CSSProperties = { padding: '7px 10px', textAlign: 'left', fontSize: 12, color: '#6b7280', fontWeight: 600, width: 130, verticalAlign: 'top', whiteSpace: 'nowrap' };
const tdv: React.CSSProperties = { padding: '7px 10px', fontSize: 13, color: '#111827' };
const badge = (m: { label: string; color: string; bg: string; border: string }): React.CSSProperties => ({ display: 'inline-block', fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 6, background: m.bg, color: m.color, border: `1px solid ${m.border}` });
const btn = (bg: string, color = '#fff', border = 'none'): React.CSSProperties => ({ padding: '8px 16px', fontSize: 13, fontWeight: 700, borderRadius: 8, border, background: bg, color, cursor: 'pointer' });
const fmtDateTime = (s: string | null) => s ? new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '—';

interface Detail {
  id: number; inquiryNumber: string | null; receivedAt: string; channel: string; status: string;
  assignedPmId: number | null; pmName: string | null;
  customerCompanyName: string | null; contactName: string | null; department: string | null; contactPosition: string | null; contactPhone: string | null; contactMobile: string | null; contactEmail: string | null;
  companyId: number | null; contactId: number | null; divisionId: number | null;
  companyName: string | null; contactNameLinked: string | null; divisionName: string | null;
  serviceType: string | null; languageFrom: string | null; languageTo: string | null;
  scheduleFrom: string | null; scheduleTo: string | null; place: string | null; volume: string | null; subject: string | null; requirements: string | null;
  quoteDueDate: string | null; interpretType: string | null; interpretDuration: string | null;
  documentType: string | null; documentUsage: string | null; desiredCompletionDate: string | null;
  equipmentJson: string | null;
  rawSource: string | null; attachmentsJson: string | null;
  quoteId: number | null; quoteNumber: string | null; quoteProgress: string; saleConverted: boolean; processingStatus: string; quotePrice: number | null; quoteIssueDate: string | null;
  closeReasonCode: string | null; closeReasonDetail: string | null; closedAt: string | null;
}

export function InquiryDetailTab({ token, inquiryId, onBack, onToast, onNavigateQuoteRegister, onOpenQuote, adminUsers = [] }: {
  token: string; inquiryId: number; onBack: () => void; onToast: (m: string) => void;
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
      kind: r.kind ?? '', quantity: r.quantity ?? '1', unit: r.unit ?? '세트', location: r.location ?? '', note: r.note ?? '',
    }));
    setEditEquip(eq);
    setEditAttach((() => { try { return d.attachmentsJson ? JSON.parse(d.attachmentsJson) : []; } catch { return []; } })());
    setForm(inquiryFormFromDetail(d, eq));
    setEditing(true);
  };
  const cancelEdit = () => { setEditing(false); setForm(null); };
  const setField = (k: keyof InquiryFormState, v: string | boolean) => setForm(prev => (prev ? { ...prev, [k]: v } : prev));
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
  const goQuote = () => {
    if (!d) return;
    const isInterp = d.serviceType === 'interpretation';
    const isTrans = d.serviceType === 'translation';
    const noteLines = [
      `[의뢰 접수 ${d.inquiryNumber ?? ''}]`,
      d.serviceType ? `서비스: ${SERVICE_LABEL[d.serviceType] ?? d.serviceType}` : '',
      (d.languageFrom || d.languageTo) ? `언어: ${[d.languageFrom, d.languageTo].filter(Boolean).join('→')}` : '',
      // 통역
      isInterp && d.interpretType ? `통역형태: ${d.interpretType}` : '',
      isInterp && (d.scheduleFrom || d.scheduleTo) ? `일정: ${[fmtDateTime(d.scheduleFrom), fmtDateTime(d.scheduleTo)].filter(x => x !== '—').join(' ~ ')}` : '',
      isInterp && d.interpretDuration ? `1일 통역시간: ${d.interpretDuration}` : '',
      isInterp && d.place ? `장소: ${d.place}` : '',
      // 번역
      isTrans && d.documentType ? `원문서 형태: ${d.documentType}` : '',
      isTrans && d.volume ? `분량: ${d.volume}` : '',
      isTrans && d.documentUsage ? `사용처: ${d.documentUsage}` : '',
      isTrans && d.desiredCompletionDate ? `완료 희망일: ${fmtDateTime(d.desiredCompletionDate)}` : '',
      // 공통
      d.subject ? `주제: ${d.subject}` : '',
      d.requirements ? `요구사항: ${d.requirements}` : '',
      d.quoteDueDate ? `견적서 수령 희망일: ${fmtDateTime(d.quoteDueDate)}` : '',
    ].filter(Boolean);
    setQuoteHandoff({
      inquiryId: d.id, inquiryNumber: d.inquiryNumber,
      companyId: d.companyId, contactId: d.contactId, divisionId: d.divisionId,
      title: d.subject ?? (d.companyName ?? d.customerCompanyName ?? '') , note: noteLines.join('\n'),
      // 서비스별 견적항목 시드(통역/통역+장비/번역/장비). 기타는 항목 없이 고객정보·메모만 전달.
      items: buildHandoffItems(d),
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
  const qm = QUOTE_PROGRESS_META[d.quoteProgress] ?? QUOTE_PROGRESS_META.none;
  const closed = d.processingStatus === 'closed_no_quote';
  const attachments: Array<{ name: string; url: string }> = (() => { try { return d.attachmentsJson ? JSON.parse(d.attachmentsJson) : []; } catch { return []; } })();
  const equipmentRows = parseEquipmentJson(d.equipmentJson);

  return (
    <div data-testid="inquiry-detail-tab" style={{ maxWidth: 920 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <button type="button" onClick={onBack} data-testid="inq-detail-back" style={{ ...btn('#f9fafb', '#374151', '1px solid #d1d5db') }}>← 목록</button>
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
      </div>

      {editing && form && (
        <div data-testid="inq-edit-form" style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '18px 22px', marginBottom: 8 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#111827', marginBottom: 4 }}>의뢰 내용 수정</div>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 8px' }}>서비스 유형·통역/번역/장비/기타 정보를 수정합니다.{d.quoteId ? ' 연결된 견적서 내용은 자동으로 변경되지 않습니다.' : ''}</p>
          <InquiryFormFields
            f={form} set={setField}
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
              ['접수일시', fmtDateTime(d.receivedAt)],
              ['접수경로', CHANNEL_LABEL[d.channel] ?? d.channel],
              ['담당 PM', d.pmName ?? '미지정'],
              ['서비스', d.serviceType ? (SERVICE_LABEL[d.serviceType] ?? d.serviceType) : '—'],
              ['견적서 수령 희망일', fmtDateTime(d.quoteDueDate)],
              // 언어는 통역/번역만 표시
              ...((d.serviceType === 'interpretation' || d.serviceType === 'translation') ? [
                ['언어', [d.languageFrom, d.languageTo].filter(Boolean).join('→') || '—'],
              ] : []),
              // 통역 전용
              ...(d.serviceType === 'interpretation' ? [
                ['통역 형태', d.interpretType ?? '—'],
                ['통역 일시', [fmtDateTime(d.scheduleFrom), fmtDateTime(d.scheduleTo)].filter(x => x !== '—').join(' ~ ') || '—'],
                ['1일 통역시간', d.interpretDuration ?? '—'],
                ['통역 장소', d.place ?? '—'],
              ] : []),
              // 번역 전용
              ...(d.serviceType === 'translation' ? [
                ['원문서 형태', d.documentType ?? '—'],
                ['번역 분량', d.volume ?? '—'],
                ['문서 사용처', d.documentUsage ?? '—'],
                ['완료 희망일', fmtDateTime(d.desiredCompletionDate)],
              ] : []),
              // 장비 단독 전용
              ...(d.serviceType === 'equipment' ? [
                ['장비 사용기간', [fmtDateTime(d.scheduleFrom), fmtDateTime(d.scheduleTo)].filter(x => x !== '—').join(' ~ ') || '—'],
                ['사용 장소', d.place ?? '—'],
              ] : []),
              // 기타 전용
              ...(d.serviceType === 'other' ? [
                ['희망 일정', [fmtDateTime(d.scheduleFrom), fmtDateTime(d.scheduleTo)].filter(x => x !== '—').join(' ~ ') || '—'],
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
                    <td style={{ padding: '5px 8px', color: '#374151', whiteSpace: 'nowrap' }}>{[r.quantity, r.unit].filter(Boolean).join(' ') || '—'}</td>
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
