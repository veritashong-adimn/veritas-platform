// ─── 판매상세 A. 기본정보 수정 ─────────────────────────────────────────────────────
// 서버: GET/PATCH /api/admin/sales/:id/basic-info (routes/saleBasicInfo.ts)
//  · 담당자 연락처·이메일 수정 범위: 기본 '이 판매건만'(견적서 수신자 고정값). 담당자 Master 동시 수정은 사용자가 명시 선택.
//  · 담당자 변경은 이 판매 거래처 소속 Master 에서만 선택. 신규 담당자 등록은 기존 담당자 보완 화면(SaleContactPicker) 재사용.
//  · 수정 사유 필수 — 변경 전후·사유·Master 동시 수정 여부는 감사 로그(logs)에 남는다.
//  · 수행·지급·청구·수금·정산 정보는 이 화면에서 바꾸지 않는다.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/constants';
import { GhostBtn, PrimaryBtn } from '../ui';
import { fmtPhone } from './SaleContactInfoPanel';
import { SaleContactPicker } from './SaleContactPicker';

type Contact = { id: number; name: string; position: string | null; department: string | null; phone: string | null; mobile: string | null; officePhone: string | null; email: string | null };
type HistoryEntry = { id: number; by: string | null; at: string; reason?: string; contactScope?: string; masterUpdated?: boolean;
  changes?: Array<{ field: string; label: string; before: unknown; after: unknown }> };
export type BasicInfoView = {
  projectId: number; saleNo: string | null; status: string;
  company: { id: number; name: string | null } | null;
  quote: { id: number; quoteNumber: string | null } | null;
  current: { contactId: number | null; contactName: string | null; phone: string | null; mobile: string | null; email: string | null; adminId: number | null; title: string | null; issueDate: string | null; fixed: boolean };
  master: { id: number; name: string; phone: string | null; mobile: string | null; officePhone: string | null; email: string | null; deleted: boolean } | null;
  diffs: Array<{ field: string; label: string; sale: string | null; master: string | null }>;
  contacts: Contact[];
  staff: Array<{ id: number; name: string | null; email: string; role: string }>;
  history: HistoryEntry[];
};

const inp: React.CSSProperties = { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, width: '100%', boxSizing: 'border-box', background: '#fff' };
const lbl: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 };
const hint: React.CSSProperties = { fontSize: 11, color: '#6b7280', marginTop: 4, lineHeight: 1.5 };
const show = (v: unknown) => {
  if (v == null || v === '') return '—';
  if (typeof v === 'object') return (v as any).name ?? JSON.stringify(v);
  return String(v);
};
const contactLine = (c: Contact) => [c.position, fmtPhone(c.mobile), fmtPhone(c.phone || c.officePhone), c.email].filter(Boolean).join(' · ') || '연락처 정보 없음';

/** 조회 모드에서도 보이는 '이 판매건 ↔ 담당자 Master' 차이 안내 + 변경 이력 */
export function SaleBasicInfoNotes({ view }: { view: BasicInfoView | null }) {
  if (!view) return null;
  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {view.diffs.length > 0 && (
        <div data-testid="sale-basic-master-diff" style={{ padding: '8px 12px', borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a', fontSize: 12, color: '#92400e', lineHeight: 1.6 }}>
          <b>이 판매건(견적서 출력) 값과 현재 담당자 Master 값이 다릅니다.</b> 판매건은 당시 확정 정보를 유지하며 자동으로 바뀌지 않습니다.
          {view.diffs.map(d => (
            <div key={d.field} style={{ color: '#374151' }}>· {d.label}: 이 판매건 <b>{d.sale ?? '—'}</b> / Master <b>{d.master ?? '—'}</b></div>
          ))}
        </div>
      )}
      {view.history.length > 0 && (
        <details data-testid="sale-basic-history">
          <summary style={{ cursor: 'pointer', fontSize: 12, color: '#6b7280' }}>기본정보 변경 이력 ({view.history.length})</summary>
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {view.history.map(h => (
              <div key={h.id} style={{ fontSize: 12, padding: '6px 10px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, lineHeight: 1.6 }}>
                <div style={{ color: '#6b7280' }}>
                  {new Date(h.at).toLocaleString('ko-KR')} · {h.by ?? '-'} · {h.contactScope === 'sale_and_master' ? '판매건 + 담당자 Master 수정' : '이 판매건만 수정'}
                  {h.masterUpdated ? ' · Master 변경됨' : ''}
                </div>
                {(h.changes ?? []).map((c, i) => (
                  <div key={i}>{c.label}: <span style={{ color: '#9ca3af' }}>{show(c.before)}</span> → <b>{show(c.after)}</b></div>
                ))}
                {h.reason && <div style={{ color: '#374151' }}>사유: {h.reason}</div>}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export function SaleBasicInfoEditor({ saleId, token, view, onCancel, onSaved, onReload }: {
  saleId: number; token: string; view: BasicInfoView;
  onCancel: () => void; onSaved: (msg: string, next: BasicInfoView) => void; onReload: () => Promise<void> | void;
}) {
  const cur = view.current;
  const [contactId, setContactId] = useState<number | null>(cur.contactId);
  const [mobile, setMobile] = useState(cur.mobile ?? '');
  const [phone, setPhone] = useState(cur.phone ?? '');
  const [email, setEmail] = useState(cur.email ?? '');
  const [applyToMaster, setApplyToMaster] = useState(false);
  const [adminId, setAdminId] = useState<number | null>(cur.adminId);
  const [title, setTitle] = useState(cur.title ?? '');
  const [issueDate, setIssueDate] = useState(cur.issueDate ?? '');
  const [reason, setReason] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  // 서버 값이 바뀌면(신규 담당자 등록 후 등) 폼 기준값을 다시 맞춘다
  useEffect(() => {
    setContactId(view.current.contactId); setMobile(view.current.mobile ?? ''); setPhone(view.current.phone ?? ''); setEmail(view.current.email ?? '');
  }, [view.current.contactId]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const k = filter.replace(/\s/g, '').toLowerCase();
    return k ? view.contacts.filter(c => [c.name, c.email, c.mobile, c.phone, c.department].some(v => (v ?? '').replace(/\s/g, '').toLowerCase().includes(k))) : view.contacts;
  }, [view.contacts, filter]);

  // 담당자 선택 시 그 담당자 Master 연락처·이메일을 이 판매건 값으로 미리 채운다(거래처 이메일로 대체하지 않음)
  const pickContact = (id: number) => {
    setContactId(id);
    const c = view.contacts.find(x => x.id === id);
    if (c && id !== cur.contactId) { setMobile(c.mobile ?? ''); setPhone(c.phone || (c.mobile ? '' : c.officePhone) || ''); setEmail(c.email ?? ''); }
    if (id === cur.contactId) { setMobile(cur.mobile ?? ''); setPhone(cur.phone ?? ''); setEmail(cur.email ?? ''); }
  };
  const selected = view.contacts.find(c => c.id === contactId) ?? null;

  const t = (v: string) => v.trim();
  const body: Record<string, unknown> = {};
  if (contactId !== cur.contactId && contactId != null) body.contactId = contactId;
  // 담당자를 바꾸면 서버가 새 담당자 Master 값으로 채운 뒤 입력값을 적용하므로, 입력칸 값은 항상 보낸다(그 경우)
  const contactChanged = body.contactId !== undefined;
  if (contactChanged || t(mobile) !== (cur.mobile ?? '')) body.contactMobile = t(mobile) || null;
  if (contactChanged || t(phone) !== (cur.phone ?? '')) body.contactPhone = t(phone) || null;
  if (contactChanged || t(email).toLowerCase() !== (cur.email ?? '').toLowerCase()) body.contactEmail = t(email) || null;
  if (adminId !== cur.adminId) body.adminId = adminId;
  if (t(title) !== (cur.title ?? '')) body.title = t(title);
  if (issueDate !== (cur.issueDate ?? '')) body.issueDate = issueDate;
  const contactFieldsTouched = 'contactMobile' in body || 'contactPhone' in body || 'contactEmail' in body;
  const dirty = Object.keys(body).length > 0;

  const save = async () => {
    setError('');
    if (!dirty) { setError('변경된 항목이 없습니다.'); return; }
    if (!reason.trim()) { setError('수정 사유를 입력하세요.'); return; }
    if (t(email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t(email))) { setError('이메일 형식이 올바르지 않습니다.'); return; }
    if (applyToMaster && !(contactId)) { setError('담당자 Master 를 함께 수정하려면 담당자를 선택하세요.'); return; }
    if (applyToMaster && !window.confirm(`담당자 Master(${selected?.name ?? ''})의 연락처·이메일도 함께 바꿉니다.\n다른 판매건의 견적서 출력값은 바뀌지 않도록 먼저 고정됩니다. 계속할까요?`)) return;
    setBusy(true);
    try {
      const r = await fetch(api(`/api/admin/sales/${saleId}/basic-info`), {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, applyToMaster: applyToMaster && contactFieldsTouched, reason: reason.trim(), expectedQuoteId: view.quote?.id ?? null }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d?.error ?? `저장 실패 (${r.status})`); return; }
      onSaved(d.masterUpdated ? '기본정보와 담당자 Master 가 수정되었습니다.' : '기본정보가 수정되었습니다(이 판매건만).', d.view);
    } catch { setError('저장 중 오류가 발생했습니다.'); }
    finally { setBusy(false); }
  };

  return (
    <div data-testid="sale-basic-editor" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px 20px' }}>
        <div>
          <label style={lbl}>거래처</label>
          <div style={{ ...inp, background: '#f9fafb' }}>{view.company?.name ?? '—'}</div>
        </div>
        <div style={{ gridColumn: 'span 2', minWidth: 0 }}>
          <label style={lbl} htmlFor="sale-basic-contact">거래처 담당자</label>
          {view.company ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="이름·이메일·전화 검색" style={{ ...inp, flex: '1 1 160px' }}
                data-testid="input-sale-basic-contact-search" aria-label="담당자 검색" />
              <select id="sale-basic-contact" value={contactId ?? ''} onChange={e => e.target.value && pickContact(Number(e.target.value))} style={{ ...inp, flex: '2 1 240px' }}
                data-testid="select-sale-basic-contact" aria-label="거래처 담당자 선택">
                {contactId == null && <option value="">— 담당자 선택 —</option>}
                {contactId != null && !shown.some(c => c.id === contactId) && selected && <option value={selected.id}>{selected.name}</option>}
                {contactId != null && !selected && <option value={contactId}>{cur.contactName ?? `#${contactId}`} (비활성·다른 상태)</option>}
                {shown.map(c => <option key={c.id} value={c.id}>{c.name} — {contactLine(c)}</option>)}
              </select>
              {view.saleNo ? (
                <GhostBtn onClick={() => setPickerOpen(true)} style={{ fontSize: 12, padding: '6px 10px' }} data-testid="btn-sale-basic-contact-create" aria-label="신규 담당자 등록">+ 신규 담당자</GhostBtn>
              ) : null}
            </div>
          ) : <div style={{ ...hint, color: '#b91c1c' }}>판매에 거래처가 연결되어 있지 않아 담당자를 선택할 수 없습니다.</div>}
          <div style={hint}>
            이 판매 거래처에 등록된 담당자만 선택할 수 있습니다(다른 거래처 담당자 자동 연결 없음).
            {!view.saleNo && ' 신규 담당자는 고객관리 > 거래처 > 담당자 등록에서 등록한 뒤 다시 열어 선택하세요.'}
          </div>
        </div>
        <div>
          <label style={lbl} htmlFor="sale-basic-mobile">담당자 휴대전화</label>
          <input id="sale-basic-mobile" value={mobile} onChange={e => setMobile(e.target.value)} style={inp} data-testid="input-sale-basic-mobile" aria-label="담당자 휴대전화" />
        </div>
        <div>
          <label style={lbl} htmlFor="sale-basic-phone">담당자 일반전화</label>
          <input id="sale-basic-phone" value={phone} onChange={e => setPhone(e.target.value)} style={inp} data-testid="input-sale-basic-phone" aria-label="담당자 일반전화" />
        </div>
        <div>
          <label style={lbl} htmlFor="sale-basic-email">담당자 이메일</label>
          <input id="sale-basic-email" value={email} onChange={e => setEmail(e.target.value)} style={inp} data-testid="input-sale-basic-email" aria-label="담당자 이메일" />
          {selected && <div style={hint}>담당자 Master: {selected.email || '이메일 없음'}{selected.mobile ? ` · ${fmtPhone(selected.mobile)}` : ''}</div>}
        </div>
      </div>

      {/* 연락처·이메일 수정 범위 — 기본은 이 판매건만 */}
      <fieldset style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 12px', margin: 0 }} data-testid="sale-basic-scope">
        <legend style={{ fontSize: 12, fontWeight: 700, color: '#374151', padding: '0 4px' }}>연락처·이메일 수정 범위</legend>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
          <input type="radio" name="sale-basic-scope" checked={!applyToMaster} onChange={() => setApplyToMaster(false)} data-testid="radio-scope-sale-only" aria-label="이 판매건만 수정" />
          <span><b>이 판매건만 수정</b> (기본) — 이 판매의 견적서 출력값만 바뀝니다. 담당자 Master·다른 판매건은 그대로입니다.</span>
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: contactId ? 'pointer' : 'not-allowed', marginTop: 6, opacity: contactId ? 1 : 0.5 }}>
          <input type="radio" name="sale-basic-scope" checked={applyToMaster} disabled={!contactId} onChange={() => setApplyToMaster(true)} data-testid="radio-scope-sale-and-master" aria-label="담당자 Master도 함께 수정" />
          <span><b>담당자 Master 도 함께 수정</b> — 현재 고객 연락처 기준 정보({selected?.name ?? '선택한 담당자'})도 바뀝니다. 다른 판매건의 기존 견적서 출력값은 바뀌지 않습니다.</span>
        </label>
      </fieldset>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px 20px' }}>
        <div>
          <label style={lbl} htmlFor="sale-basic-pm">담당 PM</label>
          <select id="sale-basic-pm" value={adminId ?? ''} onChange={e => setAdminId(e.target.value ? Number(e.target.value) : null)} style={inp} data-testid="select-sale-basic-pm" aria-label="담당 PM 선택">
            <option value="">— 미지정 —</option>
            {adminId != null && !view.staff.some(s => s.id === adminId) && <option value={adminId}>현재 PM (#{adminId})</option>}
            {view.staff.map(s => <option key={s.id} value={s.id}>{s.name ?? s.email}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl} htmlFor="sale-basic-issue">견적일 (= 판매일)</label>
          <input id="sale-basic-issue" type="date" value={issueDate} onChange={e => setIssueDate(e.target.value)} style={inp} data-testid="input-sale-basic-issue-date" aria-label="견적일" />
          <div style={hint}>운영 판매의 판매일은 별도 저장 칸 없이 견적일을 사용합니다. 견적번호 표시(Q날짜-번호)도 견적일을 따릅니다.</div>
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={lbl} htmlFor="sale-basic-title">견적서명 / 판매명</label>
          <input id="sale-basic-title" value={title} onChange={e => setTitle(e.target.value)} style={inp} data-testid="input-sale-basic-title" aria-label="견적서명 판매명" />
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={lbl} htmlFor="sale-basic-reason">수정 사유 <span style={{ color: '#dc2626' }}>*</span></label>
          <textarea id="sale-basic-reason" value={reason} onChange={e => setReason(e.target.value)} rows={2} placeholder="예: 과거 CRM 이관 시 거래처 대표 이메일이 담당자 이메일로 잘못 표시되어 정정"
            style={{ ...inp, resize: 'vertical' }} data-testid="input-sale-basic-reason" aria-label="수정 사유" />
          <div style={hint}>변경 전·후 값, 수정자, 수정일시, 사유, 담당자 Master 동시 수정 여부가 변경 이력에 기록됩니다. 수행·지급·청구·수금·정산 정보는 바뀌지 않습니다.</div>
        </div>
      </div>

      {error && <div data-testid="sale-basic-error" style={{ fontSize: 12, color: '#b91c1c' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <GhostBtn onClick={onCancel} disabled={busy} style={{ fontSize: 12, padding: '6px 12px' }} data-testid="btn-sale-basic-cancel" aria-label="기본정보 수정 취소">취소</GhostBtn>
        <PrimaryBtn onClick={save} disabled={busy || !dirty} style={{ fontSize: 12, padding: '6px 12px' }} data-testid="btn-sale-basic-save" aria-label="기본정보 저장">{busy ? '저장 중…' : '저장'}</PrimaryBtn>
      </div>

      {pickerOpen && view.saleNo && (
        <SaleContactPicker source="current" id={saleId} authHeaders={{ Authorization: `Bearer ${token}` }}
          onClose={() => { setPickerOpen(false); void onReload(); }}
          onSaved={() => { void onReload(); }} />
      )}
    </div>
  );
}
