/**
 * InquiryFormFields — 의뢰건 접수 폼 본문 (등록/상세수정 공용).
 *
 * 서비스 유형(통역/번역/장비/기타)에 따라 조건부 입력폼을 렌더링한다.
 *  · 통역: 통역 정보 + 「통역장비 필요」 체크 시 장비 복수행
 *  · 번역: 번역 정보
 *  · 장비: 장비 단독(사용기간/장소/장비 복수행)
 *  · 기타: 최소 범용 필드(언어 미표시)
 * 폼 상태(InquiryFormState) + 장비행(EquipmentRow[]) 은 부모가 소유하고, 저장 payload 는
 * buildInquiryPayload() 로 생성한다. 등록/수정 모두 동일 컴포넌트를 사용해 중복을 없앤다.
 */
import React from 'react';
import {
  INQUIRY_CHANNELS, INQUIRY_SERVICE_TYPES, INTERPRET_TYPES, DOCUMENT_TYPES,
  EQUIPMENT_KINDS, EQUIPMENT_UNITS, EquipmentRow, emptyEquipmentRow,
} from '../../lib/inquiryMeta';
import { ClickSelect } from '../ui';

const label: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 8, outline: 'none' };
const field = (w?: string): React.CSSProperties => ({ flex: w ? `0 0 ${w}` : '1 1 200px', minWidth: 160 });
const sectionTitle: React.CSSProperties = { fontSize: 13, fontWeight: 800, color: '#111827', margin: '18px 0 10px', paddingBottom: 6, borderBottom: '1px solid #eef2f7' };
const row: React.CSSProperties = { display: 'flex', gap: 12, flexWrap: 'wrap' };

// ── 폼 상태 ────────────────────────────────────────────────────────────────────
export interface InquiryFormState {
  receivedAt: string; channel: string; assignedPmId: string;
  customerCompanyName: string; department: string; contactName: string; contactPosition: string;
  contactPhone: string; contactMobile: string; contactEmail: string;
  serviceType: string;
  languageFrom: string; languageTo: string;
  quoteDueDate: string;                 // date
  // 통역
  interpretType: string; scheduleFrom: string; scheduleTo: string; interpretDuration: string; place: string;
  // 번역
  documentType: string; documentUsage: string; desiredCompletionDate: string; volume: string;
  // 공통
  subject: string; requirements: string;
  // 통역 + 장비 필요 여부
  equipmentNeeded: boolean;
}

function nowLocalInput(): string {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}
function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function isoToDateInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function emptyInquiryForm(): InquiryFormState {
  return {
    receivedAt: nowLocalInput(), channel: 'phone', assignedPmId: '',
    customerCompanyName: '', department: '', contactName: '', contactPosition: '', contactPhone: '', contactMobile: '', contactEmail: '',
    serviceType: '', languageFrom: '', languageTo: '', quoteDueDate: '',
    interpretType: '', scheduleFrom: '', scheduleTo: '', interpretDuration: '', place: '',
    documentType: '', documentUsage: '', desiredCompletionDate: '', volume: '',
    subject: '', requirements: '', equipmentNeeded: false,
  };
}

/** 상세 응답 → 폼 상태 (수정 진입 시 프리필) */
export function inquiryFormFromDetail(d: any, equipmentRows: EquipmentRow[]): InquiryFormState {
  return {
    receivedAt: isoToLocalInput(d.receivedAt), channel: d.channel ?? 'phone', assignedPmId: d.assignedPmId != null ? String(d.assignedPmId) : '',
    customerCompanyName: d.customerCompanyName ?? '', department: d.department ?? '', contactName: d.contactName ?? '', contactPosition: d.contactPosition ?? '',
    contactPhone: d.contactPhone ?? '', contactMobile: d.contactMobile ?? '', contactEmail: d.contactEmail ?? '',
    serviceType: d.serviceType ?? '', languageFrom: d.languageFrom ?? '', languageTo: d.languageTo ?? '',
    quoteDueDate: isoToDateInput(d.quoteDueDate),
    interpretType: d.interpretType ?? '', scheduleFrom: isoToLocalInput(d.scheduleFrom), scheduleTo: isoToLocalInput(d.scheduleTo),
    interpretDuration: d.interpretDuration ?? '', place: d.place ?? '',
    documentType: d.documentType ?? '', documentUsage: d.documentUsage ?? '', desiredCompletionDate: isoToDateInput(d.desiredCompletionDate), volume: d.volume ?? '',
    subject: d.subject ?? '', requirements: d.requirements ?? '',
    equipmentNeeded: d.serviceType === 'interpretation' && equipmentRows.length > 0,
  };
}

/** 폼 상태 + 장비행 + 첨부 → API payload (등록/수정 공용). 서비스 유형에 맞지 않는 필드는 null 처리. */
export function buildInquiryPayload(f: InquiryFormState, equipment: EquipmentRow[], attachments: Array<{ name: string; url: string }>): Record<string, any> {
  const isInterp = f.serviceType === 'interpretation';
  const isTrans = f.serviceType === 'translation';
  const isEquip = f.serviceType === 'equipment';
  const isOther = f.serviceType === 'other';
  const iso = (v: string) => (v ? new Date(v).toISOString() : null);
  const eqActive = (isInterp && f.equipmentNeeded) || isEquip;
  const eqRows = eqActive
    ? equipment.filter(r => r.kind.trim() || r.quantity.trim() || r.location.trim() || r.note.trim())
    : [];
  return {
    receivedAt: f.receivedAt ? new Date(f.receivedAt).toISOString() : undefined,
    channel: f.channel,
    assignedPmId: f.assignedPmId ? Number(f.assignedPmId) : null,
    customerCompanyName: f.customerCompanyName, department: f.department, contactName: f.contactName,
    contactPosition: f.contactPosition, contactPhone: f.contactPhone, contactMobile: f.contactMobile, contactEmail: f.contactEmail,
    serviceType: f.serviceType || null,
    languageFrom: (isInterp || isTrans) ? f.languageFrom : null,
    languageTo: (isInterp || isTrans) ? f.languageTo : null,
    quoteDueDate: iso(f.quoteDueDate),
    subject: f.subject, requirements: f.requirements,
    interpretType: isInterp ? f.interpretType : null,
    interpretDuration: isInterp ? f.interpretDuration : null,
    scheduleFrom: (isInterp || isEquip || isOther) ? iso(f.scheduleFrom) : null,
    scheduleTo: (isInterp || isEquip || isOther) ? iso(f.scheduleTo) : null,
    place: (isInterp || isEquip || isOther) ? (f.place || null) : null,
    documentType: isTrans ? f.documentType : null,
    documentUsage: isTrans ? f.documentUsage : null,
    desiredCompletionDate: isTrans ? iso(f.desiredCompletionDate) : null,
    volume: isTrans ? f.volume : null,
    equipmentJson: eqRows.length ? JSON.stringify(eqRows) : null,
    attachmentsJson: attachments.length ? JSON.stringify(attachments) : null,
  };
}

// ── 장비 복수행 편집 ───────────────────────────────────────────────────────────
function EquipmentRows({ rows, setRows }: { rows: EquipmentRow[]; setRows: (r: EquipmentRow[]) => void }) {
  const upd = (i: number, k: keyof EquipmentRow, v: string) => setRows(rows.map((r, j) => j === i ? { ...r, [k]: v } : r));
  const add = () => setRows([...rows, emptyEquipmentRow()]);
  const del = (i: number) => setRows(rows.filter((_, j) => j !== i));
  const cellL: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 3 };
  return (
    <div data-testid="inq-equipment-rows" style={{ marginTop: 10, border: '1px solid #fcd34d', background: '#fffdf5', borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: '#92400e', marginBottom: 8 }}>통역장비 · 복수 등록 가능</div>
      {rows.length === 0 && <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 8 }}>등록된 장비가 없습니다. 아래 「장비 추가」로 입력하세요.</div>}
      {rows.map((r, i) => (
        <div key={i} data-testid={`inq-eq-row-${i}`} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10, paddingBottom: 10, borderBottom: i < rows.length - 1 ? '1px dashed #fde68a' : 'none' }}>
          <div style={{ flex: '0 0 180px', minWidth: 150 }}><div style={cellL}>장비 종류</div>
            <select value={r.kind} onChange={e => upd(i, 'kind', e.target.value)} data-testid={`inq-eq-kind-${i}`} style={input}>
              <option value="">선택</option>
              {EQUIPMENT_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
            </select></div>
          <div style={{ flex: '0 0 90px' }}><div style={cellL}>수량</div>
            <input value={r.quantity} onChange={e => upd(i, 'quantity', e.target.value)} data-testid={`inq-eq-qty-${i}`} style={input} inputMode="numeric" placeholder="예: 50" /></div>
          <div style={{ flex: '0 0 90px' }}><div style={cellL}>단위</div>
            <select value={r.unit} onChange={e => upd(i, 'unit', e.target.value)} data-testid={`inq-eq-unit-${i}`} style={input}>
              {EQUIPMENT_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
            </select></div>
          <div style={{ flex: '1 1 160px', minWidth: 140 }}><div style={cellL}>사용 장소</div>
            <input value={r.location} onChange={e => upd(i, 'location', e.target.value)} data-testid={`inq-eq-loc-${i}`} style={input} placeholder="예: 코엑스 3층" /></div>
          <div style={{ flex: '1 1 200px', minWidth: 160 }}><div style={cellL}>설치/운영·기타 요청사항</div>
            <input value={r.note} onChange={e => upd(i, 'note', e.target.value)} data-testid={`inq-eq-note-${i}`} style={input} placeholder="예: 오전 8시까지 설치 완료" /></div>
          <button type="button" onClick={() => del(i)} data-testid={`inq-eq-del-${i}`}
            style={{ flex: '0 0 auto', padding: '8px 12px', fontSize: 12, fontWeight: 700, color: '#dc2626', border: '1px solid #fecaca', background: '#fff', borderRadius: 8, cursor: 'pointer' }}>삭제</button>
        </div>
      ))}
      <button type="button" onClick={add} data-testid="inq-eq-add"
        style={{ marginTop: 2, padding: '7px 16px', fontSize: 12, fontWeight: 700, color: '#92400e', border: '1px dashed #f59e0b', background: '#fffbeb', borderRadius: 8, cursor: 'pointer' }}>＋ 장비 추가</button>
    </div>
  );
}

// ── 본문 컴포넌트 ──────────────────────────────────────────────────────────────
export function InquiryFormFields({ f, set, equipment, setEquipment, adminUsers = [], attachments, onUpload, onRemoveAttachment, uploading = false }: {
  f: InquiryFormState;
  set: (k: keyof InquiryFormState, v: string | boolean) => void;
  equipment: EquipmentRow[];
  setEquipment: (r: EquipmentRow[]) => void;
  adminUsers?: Array<{ id: number; name?: string | null; email: string }>;
  attachments: Array<{ name: string; url: string }>;
  onUpload: (files: FileList | null) => void;
  onRemoveAttachment: (i: number) => void;
  uploading?: boolean;
}) {
  const isInterp = f.serviceType === 'interpretation';
  const isTrans = f.serviceType === 'translation';
  const isEquip = f.serviceType === 'equipment';
  const isOther = f.serviceType === 'other';

  return (
    <div>
      <div style={sectionTitle}>접수 정보</div>
      <div style={row}>
        <div style={field('200px')}><label style={label}>접수일시</label>
          <input type="datetime-local" value={f.receivedAt} onChange={e => set('receivedAt', e.target.value)} data-testid="inq-receivedAt" style={input} /></div>
        <div style={field('160px')}><label style={label}>접수경로</label>
          <select value={f.channel} onChange={e => set('channel', e.target.value)} data-testid="inq-channel" style={input}>
            {INQUIRY_CHANNELS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select></div>
        <div style={field('200px')}><label style={label}>담당 PM</label>
          <select value={f.assignedPmId} onChange={e => set('assignedPmId', e.target.value)} data-testid="inq-pm" style={input}>
            <option value="">미지정</option>
            {adminUsers.map(u => <option key={u.id} value={u.id}>{u.name ?? u.email}</option>)}
          </select></div>
      </div>

      <div style={sectionTitle}>고객 정보 (원문)</div>
      <div style={row}>
        <div style={field()}><label style={label}>회사명</label><input value={f.customerCompanyName} onChange={e => set('customerCompanyName', e.target.value)} data-testid="inq-company" style={input} placeholder="예: ABC 주식회사" /></div>
        <div style={field()}><label style={label}>부서</label><input value={f.department} onChange={e => set('department', e.target.value)} data-testid="inq-dept" style={input} /></div>
        <div style={field()}><label style={label}>담당자</label><input value={f.contactName} onChange={e => set('contactName', e.target.value)} data-testid="inq-contact" style={input} placeholder="예: 김철수" /></div>
        <div style={field('140px')}><label style={label}>직함</label><input value={f.contactPosition} onChange={e => set('contactPosition', e.target.value)} data-testid="inq-position" style={input} placeholder="예: 팀장" /></div>
      </div>
      <div style={{ ...row, marginTop: 12 }}>
        <div style={field()}><label style={label}>전화번호</label><input value={f.contactPhone} onChange={e => set('contactPhone', e.target.value)} data-testid="inq-phone" style={input} /></div>
        <div style={field()}><label style={label}>휴대폰</label><input value={f.contactMobile} onChange={e => set('contactMobile', e.target.value)} data-testid="inq-mobile" style={input} /></div>
        <div style={field()}><label style={label}>이메일</label><input value={f.contactEmail} onChange={e => set('contactEmail', e.target.value)} data-testid="inq-email" style={input} /></div>
      </div>

      <div style={sectionTitle}>의뢰 내용</div>
      <div style={row}>
        <div style={field('180px')} data-testid="inq-service"><label style={label}>서비스 유형</label>
          {/* 네이티브 select → 플랫폼 표준 커스텀 드롭다운(ClickSelect). 포커스 이동/캡처 시에도 유지. */}
          <ClickSelect
            value={f.serviceType}
            onChange={(v) => set('serviceType', v)}
            placeholder="선택"
            options={INQUIRY_SERVICE_TYPES.map(s => ({ value: s.value, label: s.label }))}
            style={{ display: 'block', width: '100%' }}
            triggerStyle={{ width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 13, boxSizing: 'border-box', fontWeight: 400 }}
          /></div>
        <div style={field('200px')}><label style={label}>견적서 수령 희망일 <span style={{ color: '#9ca3af', fontWeight: 400 }}>(선택)</span></label><input type="date" value={f.quoteDueDate} onChange={e => set('quoteDueDate', e.target.value)} data-testid="inq-quoteDue" style={input} /></div>
      </div>

      {/* ── 통역 ── */}
      {isInterp && (
        <div data-testid="inq-interp-fields">
          <div style={{ ...row, marginTop: 12 }}>
            <div style={field('160px')}><label style={label}>출발 언어</label><input value={f.languageFrom} onChange={e => set('languageFrom', e.target.value)} data-testid="inq-langFrom" style={input} placeholder="예: 한국어" /></div>
            <div style={field('160px')}><label style={label}>도착 언어</label><input value={f.languageTo} onChange={e => set('languageTo', e.target.value)} data-testid="inq-langTo" style={input} placeholder="예: 영어" /></div>
            <div style={field('180px')}><label style={label}>통역 형태</label>
              <select value={f.interpretType} onChange={e => set('interpretType', e.target.value)} data-testid="inq-interpretType" style={input}>
                <option value="">선택</option>
                {INTERPRET_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select></div>
          </div>
          <div style={{ ...row, marginTop: 12 }}>
            <div style={field()}><label style={label}>통역 시작일시</label><input type="datetime-local" value={f.scheduleFrom} onChange={e => set('scheduleFrom', e.target.value)} data-testid="inq-schedFrom" style={input} /></div>
            <div style={field()}><label style={label}>통역 종료일시</label><input type="datetime-local" value={f.scheduleTo} onChange={e => set('scheduleTo', e.target.value)} data-testid="inq-schedTo" style={input} /></div>
            <div style={field('160px')}><label style={label}>1일 통역시간</label><input value={f.interpretDuration} onChange={e => set('interpretDuration', e.target.value)} data-testid="inq-duration" style={input} placeholder="예: 8시간" /></div>
          </div>
          <div style={{ ...row, marginTop: 12 }}>
            <div style={field()}><label style={label}>통역 장소</label><input value={f.place} onChange={e => set('place', e.target.value)} data-testid="inq-place" style={input} placeholder="예: 서울 코엑스 3층" /></div>
          </div>
          <div style={{ marginTop: 12 }}><label style={label}>통역 주제</label><input value={f.subject} onChange={e => set('subject', e.target.value)} data-testid="inq-subject" style={input} /></div>
          {/* 통역 + 장비 */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 13, fontWeight: 700, color: '#92400e', cursor: 'pointer' }}>
            <input type="checkbox" checked={f.equipmentNeeded} onChange={e => set('equipmentNeeded', e.target.checked)} data-testid="inq-equip-needed" style={{ width: 16, height: 16 }} />
            통역장비 필요
          </label>
          {f.equipmentNeeded && <EquipmentRows rows={equipment} setRows={setEquipment} />}
        </div>
      )}

      {/* ── 번역 ── */}
      {isTrans && (
        <div data-testid="inq-trans-fields">
          <div style={{ ...row, marginTop: 12 }}>
            <div style={field('160px')}><label style={label}>출발 언어</label><input value={f.languageFrom} onChange={e => set('languageFrom', e.target.value)} data-testid="inq-langFrom" style={input} placeholder="예: 한국어" /></div>
            <div style={field('160px')}><label style={label}>도착 언어</label><input value={f.languageTo} onChange={e => set('languageTo', e.target.value)} data-testid="inq-langTo" style={input} placeholder="예: 영어" /></div>
            <div style={field('160px')}><label style={label}>원문서 형태</label>
              <select value={f.documentType} onChange={e => set('documentType', e.target.value)} data-testid="inq-docType" style={input}>
                <option value="">선택</option>
                {DOCUMENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select></div>
          </div>
          <div style={{ ...row, marginTop: 12 }}>
            <div style={field()}><label style={label}>번역 분량</label><input value={f.volume} onChange={e => set('volume', e.target.value)} data-testid="inq-volume" style={input} placeholder="예: A4 20페이지, 5,000단어, 10,000자" /></div>
            <div style={field()}><label style={label}>문서 사용처</label><input value={f.documentUsage} onChange={e => set('documentUsage', e.target.value)} data-testid="inq-docUsage" style={input} placeholder="예: 계약서 제출용, 내부 검토용" /></div>
            <div style={field('200px')}><label style={label}>번역 완료 희망일</label><input type="date" value={f.desiredCompletionDate} onChange={e => set('desiredCompletionDate', e.target.value)} data-testid="inq-completeDate" style={input} /></div>
          </div>
          <div style={{ marginTop: 12 }}><label style={label}>번역 내용/주제</label><input value={f.subject} onChange={e => set('subject', e.target.value)} data-testid="inq-subject" style={input} /></div>
        </div>
      )}

      {/* ── 장비 단독 ── */}
      {isEquip && (
        <div data-testid="inq-equip-fields">
          <div style={{ ...row, marginTop: 12 }}>
            <div style={field()}><label style={label}>장비 사용 시작일시</label><input type="datetime-local" value={f.scheduleFrom} onChange={e => set('scheduleFrom', e.target.value)} data-testid="inq-schedFrom" style={input} /></div>
            <div style={field()}><label style={label}>장비 사용 종료일시</label><input type="datetime-local" value={f.scheduleTo} onChange={e => set('scheduleTo', e.target.value)} data-testid="inq-schedTo" style={input} /></div>
            <div style={field()}><label style={label}>사용 장소</label><input value={f.place} onChange={e => set('place', e.target.value)} data-testid="inq-place" style={input} placeholder="예: 서울 코엑스 3층" /></div>
          </div>
          <EquipmentRows rows={equipment} setRows={setEquipment} />
          <div style={{ marginTop: 12 }}><label style={label}>행사/업무 주제</label><input value={f.subject} onChange={e => set('subject', e.target.value)} data-testid="inq-subject" style={input} /></div>
        </div>
      )}

      {/* ── 기타 ── */}
      {isOther && (
        <div data-testid="inq-other-fields">
          <div style={{ marginTop: 12 }}><label style={label}>주제/내용</label><input value={f.subject} onChange={e => set('subject', e.target.value)} data-testid="inq-subject" style={input} placeholder="문의 내용을 입력하세요" /></div>
          <div style={{ ...row, marginTop: 12 }}>
            <div style={field()}><label style={label}>희망 일정 시작 <span style={{ color: '#9ca3af', fontWeight: 400 }}>(선택)</span></label><input type="datetime-local" value={f.scheduleFrom} onChange={e => set('scheduleFrom', e.target.value)} data-testid="inq-schedFrom" style={input} /></div>
            <div style={field()}><label style={label}>희망 일정 종료 <span style={{ color: '#9ca3af', fontWeight: 400 }}>(선택)</span></label><input type="datetime-local" value={f.scheduleTo} onChange={e => set('scheduleTo', e.target.value)} data-testid="inq-schedTo" style={input} /></div>
            <div style={field()}><label style={label}>장소 <span style={{ color: '#9ca3af', fontWeight: 400 }}>(선택)</span></label><input value={f.place} onChange={e => set('place', e.target.value)} data-testid="inq-place" style={input} /></div>
          </div>
        </div>
      )}

      {/* ── 미선택 안내 ── */}
      {!isInterp && !isTrans && !isEquip && !isOther && (
        <div style={{ marginTop: 12, padding: '14px 16px', background: '#f9fafb', border: '1px dashed #d1d5db', borderRadius: 8, fontSize: 13, color: '#6b7280' }}>
          서비스 유형을 선택하면 유형별 입력 항목이 표시됩니다.
        </div>
      )}

      <div style={{ marginTop: 12 }}><label style={label}>요구사항</label><textarea value={f.requirements} onChange={e => set('requirements', e.target.value)} data-testid="inq-requirements" rows={3} style={{ ...input, resize: 'vertical' }} /></div>

      <div style={sectionTitle}>첨부파일</div>
      <input type="file" multiple onChange={e => onUpload(e.target.files)} disabled={uploading} data-testid="inq-attach" style={{ fontSize: 12 }} />
      {uploading && <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 8 }}>업로드 중…</span>}
      {attachments.length > 0 && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: '#374151' }}>
          {attachments.map((a, i) => <li key={i}>{a.name} <button type="button" onClick={() => onRemoveAttachment(i)} style={{ marginLeft: 6, fontSize: 11, color: '#dc2626', border: 'none', background: 'none', cursor: 'pointer' }}>삭제</button></li>)}
        </ul>
      )}
    </div>
  );
}
