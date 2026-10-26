/**
 * InquiryFormFields — 의뢰건 접수 폼 본문 (등록/상세수정 공용).
 *
 * 서비스 유형(통역/번역/장비/기타, 복수 선택)에 따라 선택한 유형의 입력폼을 모두 렌더링한다.
 *  · 통역: 통역 정보 + 「통역장비 필요」 체크 시 장비 복수행
 *  · 번역: 번역 정보
 *  · 장비: 장비 단독(사용기간/장소/장비 복수행)
 *  · 기타: 최소 범용 필드(언어 미표시)
 * 폼 상태(InquiryFormState) + 장비행(EquipmentRow[]) 은 부모가 소유하고, 저장 payload 는
 * buildInquiryPayload() 로 생성한다. 등록/수정 모두 동일 컴포넌트를 사용해 중복을 없앤다.
 */
import React, { useRef, useState } from 'react';
import {
  INQUIRY_CHANNELS, INQUIRY_SERVICE_TYPES, INTERPRET_TYPES, DOCUMENT_TYPES,
  EQUIPMENT_KINDS, EQUIPMENT_UNITS, EquipmentRow, emptyEquipmentRow,
  OTHER_SERVICE_PRESETS, inquiryServiceTypes,
} from '../../lib/inquiryMeta';
import { CustomerLinkPicker } from './CustomerLinkPicker';
import { DateField } from './DatePickerShared';

const label: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 8, outline: 'none' };
const field = (w?: string): React.CSSProperties => ({ flex: w ? `0 0 ${w}` : '1 1 200px', minWidth: 160 });
const sectionTitle: React.CSSProperties = { fontSize: 13, fontWeight: 800, color: '#111827', margin: '18px 0 10px', paddingBottom: 6, borderBottom: '1px solid #eef2f7' };
const row: React.CSSProperties = { display: 'flex', gap: 12, flexWrap: 'wrap' };

// ── 폼 상태 ────────────────────────────────────────────────────────────────────
export interface InquiryFormState {
  receivedAt: string; channel: string; assignedPmId: string;
  // 고객 연결 — 기존 거래처/담당자 마스터 연결(선택). 신규 고객은 빈 값(원문 snapshot만 보존).
  customerMode: string;                 // 'existing' | 'new' (기본 existing)
  companyId: string; contactId: string; divisionId: string;
  customerCompanyName: string; department: string; contactName: string; contactPosition: string;
  contactPhone: string; contactMobile: string; contactEmail: string;
  serviceType: string;                  // 대표값(레거시 호환·AI 단일 제안 입력용). 저장 시 serviceTypes 첫 값으로 재계산
  serviceTypes: string[];               // 복수 선택(통역/번역/장비/기타)
  otherServices: string[];              // 기타 세부 — 프리셋(감수/편집/공증) 선택값
  otherCustomOn: boolean;               // 기타 세부 — '직접 입력' 선택 여부
  otherCustom: string[];                // 기타 세부 — 직접 입력 서비스명(여러 개)
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
    customerMode: 'existing', companyId: '', contactId: '', divisionId: '',
    customerCompanyName: '', department: '', contactName: '', contactPosition: '', contactPhone: '', contactMobile: '', contactEmail: '',
    serviceType: '', serviceTypes: [], otherServices: [], otherCustomOn: false, otherCustom: [''],
    languageFrom: '', languageTo: '', quoteDueDate: '',
    interpretType: '', scheduleFrom: '', scheduleTo: '', interpretDuration: '', place: '',
    documentType: '', documentUsage: '', desiredCompletionDate: '', volume: '',
    subject: '', requirements: '', equipmentNeeded: false,
  };
}

/** 상세 응답 → 폼 상태 (수정 진입 시 프리필) */
export function inquiryFormFromDetail(d: any, equipmentRows: EquipmentRow[]): InquiryFormState {
  return {
    receivedAt: isoToLocalInput(d.receivedAt), channel: d.channel ?? 'phone', assignedPmId: d.assignedPmId != null ? String(d.assignedPmId) : '',
    customerMode: d.companyId != null ? 'existing' : 'new',
    companyId: d.companyId != null ? String(d.companyId) : '', contactId: d.contactId != null ? String(d.contactId) : '', divisionId: d.divisionId != null ? String(d.divisionId) : '',
    customerCompanyName: d.customerCompanyName ?? '', department: d.department ?? '', contactName: d.contactName ?? '', contactPosition: d.contactPosition ?? '',
    contactPhone: d.contactPhone ?? '', contactMobile: d.contactMobile ?? '', contactEmail: d.contactEmail ?? '',
    serviceType: d.serviceType ?? '', serviceTypes: inquiryServiceTypes(d),
    ...splitOtherServices(Array.isArray(d.otherServices) ? d.otherServices : []),
    languageFrom: d.languageFrom ?? '', languageTo: d.languageTo ?? '',
    quoteDueDate: isoToDateInput(d.quoteDueDate),
    interpretType: d.interpretType ?? '', scheduleFrom: isoToLocalInput(d.scheduleFrom), scheduleTo: isoToLocalInput(d.scheduleTo),
    interpretDuration: d.interpretDuration ?? '', place: d.place ?? '',
    documentType: d.documentType ?? '', documentUsage: d.documentUsage ?? '', desiredCompletionDate: isoToDateInput(d.desiredCompletionDate), volume: d.volume ?? '',
    subject: d.subject ?? '', requirements: d.requirements ?? '',
    // 통역 + 장비행: 장비 유형을 따로 선택하지 않은 기존 데이터는 「통역장비 필요」 체크로 복원
    equipmentNeeded: inquiryServiceTypes(d).includes('interpretation') && !inquiryServiceTypes(d).includes('equipment') && equipmentRows.length > 0,
  };
}

/** 저장된 기타 세부 서비스 → 프리셋 선택값 / 직접 입력값 분리(수정 화면 복원) */
function splitOtherServices(list: string[]): Pick<InquiryFormState, 'otherServices' | 'otherCustomOn' | 'otherCustom'> {
  const presets = list.filter(v => (OTHER_SERVICE_PRESETS as readonly string[]).includes(v));
  const custom = list.filter(v => !(OTHER_SERVICE_PRESETS as readonly string[]).includes(v));
  return { otherServices: presets, otherCustomOn: custom.length > 0, otherCustom: custom.length ? custom : [''] };
}

/** 저장할 기타 세부 서비스(프리셋 + 공백 제거한 직접 입력값, 중복·빈 값 제외). 기타 미선택이면 빈 배열. */
function collectOtherServices(f: InquiryFormState): string[] {
  if (!f.serviceTypes.includes('other')) return [];
  const custom = f.otherCustomOn ? f.otherCustom.map(v => v.trim()).filter(Boolean) : [];
  return [...new Set([...f.otherServices, ...custom])];
}

/** 등록·수정 전 서비스 선택 검증 — 오류 문구(없으면 null). */
export function validateInquiryServices(f: InquiryFormState): string | null {
  if (f.serviceTypes.length === 0) return '서비스 유형을 1개 이상 선택해 주세요.';
  if (f.serviceTypes.includes('other') && f.otherCustomOn && f.otherCustom.every(v => !v.trim())) return '기타 서비스 직접 입력란에 서비스명을 입력하거나 직접 입력을 해제해 주세요.';
  return null;
}

/** 폼 상태 + 장비행 + 첨부 → API payload (등록/수정 공용). 서비스 유형에 맞지 않는 필드는 null 처리. */
export function buildInquiryPayload(f: InquiryFormState, equipment: EquipmentRow[], attachments: Array<{ name: string; url: string }>): Record<string, any> {
  const order = INQUIRY_SERVICE_TYPES.map(t => t.value as string);
  const types = [...order.filter(t => f.serviceTypes.includes(t)), ...f.serviceTypes.filter(t => !order.includes(t))];   // 표시 순서 + 레거시값 보존
  const isInterp = types.includes('interpretation');
  const isTrans = types.includes('translation');
  const isEquip = types.includes('equipment');
  const isOther = types.includes('other');
  const iso = (v: string) => (v ? new Date(v).toISOString() : null);
  const eqActive = (isInterp && f.equipmentNeeded) || isEquip;
  const eqRows = eqActive
    ? equipment.filter(r => r.kind.trim() || r.quantity.trim() || r.location.trim() || r.note.trim())
    : [];
  return {
    receivedAt: f.receivedAt ? new Date(f.receivedAt).toISOString() : undefined,
    channel: f.channel,
    assignedPmId: f.assignedPmId ? Number(f.assignedPmId) : null,
    // 마스터 연결(선택). 신규 고객은 null. 원문 고객정보(아래 snapshot 필드)는 연결 여부와 무관하게 항상 보존.
    companyId: f.companyId ? Number(f.companyId) : null,
    contactId: f.contactId ? Number(f.contactId) : null,
    divisionId: f.divisionId ? Number(f.divisionId) : null,
    customerCompanyName: f.customerCompanyName, department: f.department, contactName: f.contactName,
    contactPosition: f.contactPosition, contactPhone: f.contactPhone, contactMobile: f.contactMobile, contactEmail: f.contactEmail,
    serviceType: types[0] ?? null,          // 대표값(기존 단일 필드 호환)
    serviceTypes: types,
    otherServices: isOther ? collectOtherServices(f) : [],
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

// ── 서비스 유형 탭 (상단 배치) ─────────────────────────────────────────────────
// 4개 버튼(통역/번역/장비/기타) 복수 선택 — 다시 누르면 해제. 선택값은 serviceTypes 배열(대표값은 저장 시 첫 값).
// 실비(expense)는 신규 선택지에서 제외(legacy 표시/저장 로직은 유지). 버튼 요소라 키보드 접근성 기본 제공.
function ServiceTabs({ values, onChange }: { values: string[]; onChange: (v: string[]) => void }) {
  return (
    <div role="group" aria-label="서비스 유형(복수 선택)" data-testid="inq-service-tabs" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {INQUIRY_SERVICE_TYPES.map(s => {
        const active = values.includes(s.value);
        return (
          <button
            key={s.value} type="button" aria-pressed={active}
            aria-label={`서비스 유형 ${s.label}`} data-testid={`inq-service-tab-${s.value}`}
            onClick={() => onChange(active ? values.filter(v => v !== s.value) : [...values, s.value])}
            style={{
              padding: '9px 24px', fontSize: 13, fontWeight: 700, borderRadius: 8, cursor: 'pointer',
              border: active ? '1px solid #2563eb' : '1px solid #d1d5db',
              background: active ? '#2563eb' : '#fff',
              color: active ? '#fff' : '#374151',
              boxShadow: active ? '0 1px 2px rgba(37,99,235,0.25)' : 'none',
              transition: 'background .12s, color .12s, border-color .12s',
            }}>
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

// ── 기타 서비스 세부 선택(복수) — 감수/편집/공증/직접 입력(여러 개) ─────────────
function OtherServicePicker({ f, set }: { f: InquiryFormState; set: (k: keyof InquiryFormState, v: string | boolean | string[]) => void }) {
  const chip = (active: boolean): React.CSSProperties => ({
    padding: '7px 16px', fontSize: 12, fontWeight: 700, borderRadius: 8, cursor: 'pointer',
    border: active ? '1px solid #2563eb' : '1px solid #d1d5db', background: active ? '#2563eb' : '#fff', color: active ? '#fff' : '#374151',
  });
  const toggle = (v: string) => set('otherServices', f.otherServices.includes(v) ? f.otherServices.filter(x => x !== v) : [...f.otherServices, v]);
  const updCustom = (i: number, v: string) => set('otherCustom', f.otherCustom.map((x, j) => (j === i ? v : x)));
  return (
    <div data-testid="inq-other-services" style={{ marginTop: 10, padding: '12px 14px', border: '1px solid #e5e7eb', borderRadius: 10, background: '#f9fafb' }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: '#374151', marginBottom: 8 }}>기타 서비스 · 복수 선택 가능</div>
      <div role="group" aria-label="기타 서비스 세부" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {OTHER_SERVICE_PRESETS.map(v => (
          <button key={v} type="button" aria-pressed={f.otherServices.includes(v)} aria-label={`기타 서비스 ${v}`} data-testid={`inq-other-${v}`}
            onClick={() => toggle(v)} style={chip(f.otherServices.includes(v))}>{v}</button>
        ))}
        <button type="button" aria-pressed={f.otherCustomOn} aria-label="기타 서비스 직접 입력" data-testid="inq-other-custom-toggle"
          onClick={() => set('otherCustomOn', !f.otherCustomOn)} style={chip(f.otherCustomOn)}>직접 입력</button>
      </div>
      {f.otherCustomOn && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {f.otherCustom.map((v, i) => (
            <div key={i} style={{ display: 'flex', gap: 6 }}>
              <input value={v} onChange={e => updCustom(i, e.target.value)} data-testid={`inq-other-custom-${i}`} aria-label={`직접 입력 서비스명 ${i + 1}`}
                style={{ ...input, maxWidth: 360 }} placeholder="서비스명 입력 (예: 자막 제작)" maxLength={50} />
              {f.otherCustom.length > 1 && (
                <button type="button" onClick={() => set('otherCustom', f.otherCustom.filter((_, j) => j !== i))} data-testid={`inq-other-custom-del-${i}`} aria-label={`직접 입력 ${i + 1} 삭제`}
                  style={{ padding: '6px 10px', fontSize: 12, color: '#dc2626', border: '1px solid #fecaca', background: '#fff', borderRadius: 8, cursor: 'pointer' }}>삭제</button>
              )}
            </div>
          ))}
          <button type="button" onClick={() => set('otherCustom', [...f.otherCustom, ''])} data-testid="inq-other-custom-add" aria-label="직접 입력 서비스 추가"
            style={{ alignSelf: 'flex-start', padding: '6px 14px', fontSize: 12, fontWeight: 700, color: '#2563eb', border: '1px dashed #93c5fd', background: '#eff6ff', borderRadius: 8, cursor: 'pointer' }}>＋ 서비스 추가</button>
        </div>
      )}
    </div>
  );
}

// ── 첨부파일 드롭존 ────────────────────────────────────────────────────────────
// 기존 /api/upload(R2) 로직은 그대로 재사용. UI만 넓은 클릭/드래그영역으로 개선(향후 AI 자동접수 입력영역).
function AttachmentDropzone({ attachments, onUpload, onRemoveAttachment, uploading }: {
  attachments: Array<{ name: string; url: string }>;
  onUpload: (files: FileList | null) => void;
  onRemoveAttachment: (i: number) => void;
  uploading: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const openPicker = () => inputRef.current?.click();
  return (
    <div>
      <div style={sectionTitle}>첨부파일</div>
      <div
        data-testid="inq-attach-dropzone"
        role="button" tabIndex={0} aria-label="첨부파일 선택 또는 끌어다 놓기"
        onClick={openPicker}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); } }}
        onDragOver={e => { e.preventDefault(); if (!drag) setDrag(true); }}
        onDragLeave={e => { e.preventDefault(); setDrag(false); }}
        onDrop={e => { e.preventDefault(); setDrag(false); onUpload(e.dataTransfer.files); }}
        style={{
          border: `1.5px dashed ${drag ? '#2563eb' : '#cbd5e1'}`,
          background: drag ? '#eff6ff' : '#f9fafb',
          borderRadius: 10, padding: '22px 18px', textAlign: 'center', cursor: 'pointer',
          transition: 'border-color .12s, background .12s',
        }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: drag ? '#2563eb' : '#374151' }}>파일을 선택하거나 여기에 끌어다 놓으세요</div>
        <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>PDF · Word · 한글 · Excel · 이미지 등</div>
        {uploading && <div style={{ fontSize: 12, color: '#2563eb', marginTop: 6 }}>업로드 중…</div>}
      </div>
      <input
        ref={inputRef} type="file" multiple disabled={uploading} data-testid="inq-attach"
        onChange={e => { onUpload(e.target.files); e.target.value = ''; }}
        style={{ display: 'none' }} />
      {attachments.length > 0 && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: '#374151' }}>
          {attachments.map((a, i) => <li key={i}>{a.name} <button type="button" onClick={() => onRemoveAttachment(i)} style={{ marginLeft: 6, fontSize: 11, color: '#dc2626', border: 'none', background: 'none', cursor: 'pointer' }}>삭제</button></li>)}
        </ul>
      )}
    </div>
  );
}

// ── 본문 컴포넌트 ──────────────────────────────────────────────────────────────
export function InquiryFormFields({ f, set, equipment, setEquipment, adminUsers = [], attachments, onUpload, onRemoveAttachment, uploading = false, token, showCustomerPicker = false }: {
  f: InquiryFormState;
  set: (k: keyof InquiryFormState, v: string | boolean | string[]) => void;
  equipment: EquipmentRow[];
  setEquipment: (r: EquipmentRow[]) => void;
  adminUsers?: Array<{ id: number; name?: string | null; email: string }>;
  attachments: Array<{ name: string; url: string }>;
  onUpload: (files: FileList | null) => void;
  onRemoveAttachment: (i: number) => void;
  uploading?: boolean;
  token?: string;                       // 고객 picker 검색용(showCustomerPicker=true 일 때 필요)
  showCustomerPicker?: boolean;         // true → 기존 거래처/담당자 연결 picker, false(기본) → 기존 원문 직접입력(상세 수정 호환)
}) {
  const isInterp = f.serviceTypes.includes('interpretation');
  const isTrans = f.serviceTypes.includes('translation');
  const isEquip = f.serviceTypes.includes('equipment');
  const isOther = f.serviceTypes.includes('other');
  // 여러 유형이 공유하는 입력값(언어·일정·장소·주제)은 처음 보이는 영역에만 한 번 표시한다(같은 값 중복 입력란 방지).
  const subjectIn = isInterp ? 'interp' : isTrans ? 'trans' : isEquip ? 'equip' : 'other';

  return (
    <div>
      {/* ── 서비스 유형 (상단, 복수 선택) ── */}
      <div style={{ ...sectionTitle, marginTop: 2 }}>서비스 유형 <span style={{ fontSize: 11, fontWeight: 500, color: '#9ca3af' }}>복수 선택 가능</span></div>
      <ServiceTabs values={f.serviceTypes} onChange={(v) => set('serviceTypes', v)} />
      {isOther && <OtherServicePicker f={f} set={set} />}

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
        <div style={field('200px')}><label style={label}>견적서 수령 희망일 <span style={{ color: '#9ca3af', fontWeight: 400 }}>(선택)</span></label>
          <DateField value={f.quoteDueDate} onChange={v => set('quoteDueDate', v)} testid="inq-quoteDue" ariaLabel="견적서 수령 희망일" style={input} /></div>
      </div>

      {/* 고객 정보 — 등록: 기존 거래처/담당자 연결 picker / 상세 수정: 기존 원문 직접입력(호환 유지) */}
      {showCustomerPicker && token ? (
        <CustomerLinkPicker token={token} f={f} set={set as (k: keyof InquiryFormState, v: string) => void} />
      ) : (
        <>
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
        </>
      )}

      <div style={sectionTitle}>의뢰 내용</div>

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
          {/* 통역 + 장비 — 장비 유형을 함께 선택하면 장비행은 아래 장비 영역에서 한 번만 입력 */}
          {!isEquip && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 13, fontWeight: 700, color: '#92400e', cursor: 'pointer' }}>
              <input type="checkbox" checked={f.equipmentNeeded} onChange={e => set('equipmentNeeded', e.target.checked)} data-testid="inq-equip-needed" style={{ width: 16, height: 16 }} />
              통역장비 필요
            </label>
          )}
          {!isEquip && f.equipmentNeeded && <EquipmentRows rows={equipment} setRows={setEquipment} />}
        </div>
      )}

      {/* ── 번역 ── */}
      {isTrans && (
        <div data-testid="inq-trans-fields">
          {isInterp && <div style={{ fontSize: 12, fontWeight: 800, color: '#374151', marginTop: 16 }}>번역 정보</div>}
          <div style={{ ...row, marginTop: 12 }}>
            {!isInterp && <div style={field('160px')}><label style={label}>출발 언어</label><input value={f.languageFrom} onChange={e => set('languageFrom', e.target.value)} data-testid="inq-langFrom" style={input} placeholder="예: 한국어" /></div>}
            {!isInterp && <div style={field('160px')}><label style={label}>도착 언어</label><input value={f.languageTo} onChange={e => set('languageTo', e.target.value)} data-testid="inq-langTo" style={input} placeholder="예: 영어" /></div>}
            <div style={field('160px')}><label style={label}>원문서 형태</label>
              <select value={f.documentType} onChange={e => set('documentType', e.target.value)} data-testid="inq-docType" style={input}>
                <option value="">선택</option>
                {DOCUMENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select></div>
          </div>
          <div style={{ ...row, marginTop: 12 }}>
            <div style={field()}><label style={label}>번역 분량</label><input value={f.volume} onChange={e => set('volume', e.target.value)} data-testid="inq-volume" style={input} placeholder="예: A4 20페이지, 5,000단어, 10,000자" /></div>
            <div style={field()}><label style={label}>문서 사용처</label><input value={f.documentUsage} onChange={e => set('documentUsage', e.target.value)} data-testid="inq-docUsage" style={input} placeholder="예: 계약서 제출용, 내부 검토용" /></div>
            <div style={field('200px')}><label style={label}>번역 완료 희망일</label><DateField value={f.desiredCompletionDate} onChange={v => set('desiredCompletionDate', v)} testid="inq-completeDate" ariaLabel="번역 완료 희망일" style={input} /></div>
          </div>
          {subjectIn === 'trans' && <div style={{ marginTop: 12 }}><label style={label}>번역 내용/주제</label><input value={f.subject} onChange={e => set('subject', e.target.value)} data-testid="inq-subject" style={input} /></div>}
        </div>
      )}

      {/* ── 장비 단독 ── */}
      {isEquip && (
        <div data-testid="inq-equip-fields">
          {(isInterp || isTrans) && <div style={{ fontSize: 12, fontWeight: 800, color: '#374151', marginTop: 16 }}>장비 정보{isInterp ? ' (일정·장소는 통역 정보와 동일)' : ''}</div>}
          {!isInterp && (
            <div style={{ ...row, marginTop: 12 }}>
              <div style={field()}><label style={label}>장비 사용 시작일시</label><input type="datetime-local" value={f.scheduleFrom} onChange={e => set('scheduleFrom', e.target.value)} data-testid="inq-schedFrom" style={input} /></div>
              <div style={field()}><label style={label}>장비 사용 종료일시</label><input type="datetime-local" value={f.scheduleTo} onChange={e => set('scheduleTo', e.target.value)} data-testid="inq-schedTo" style={input} /></div>
              <div style={field()}><label style={label}>사용 장소</label><input value={f.place} onChange={e => set('place', e.target.value)} data-testid="inq-place" style={input} placeholder="예: 서울 코엑스 3층" /></div>
            </div>
          )}
          <EquipmentRows rows={equipment} setRows={setEquipment} />
          {subjectIn === 'equip' && <div style={{ marginTop: 12 }}><label style={label}>행사/업무 주제</label><input value={f.subject} onChange={e => set('subject', e.target.value)} data-testid="inq-subject" style={input} /></div>}
        </div>
      )}

      {/* ── 기타 ── */}
      {isOther && (
        <div data-testid="inq-other-fields">
          {subjectIn === 'other' && <div style={{ marginTop: 12 }}><label style={label}>주제/내용</label><input value={f.subject} onChange={e => set('subject', e.target.value)} data-testid="inq-subject" style={input} placeholder="문의 내용을 입력하세요" /></div>}
          {!isInterp && !isEquip && <div style={{ ...row, marginTop: 12 }}>
            <div style={field()}><label style={label}>희망 일정 시작 <span style={{ color: '#9ca3af', fontWeight: 400 }}>(선택)</span></label><input type="datetime-local" value={f.scheduleFrom} onChange={e => set('scheduleFrom', e.target.value)} data-testid="inq-schedFrom" style={input} /></div>
            <div style={field()}><label style={label}>희망 일정 종료 <span style={{ color: '#9ca3af', fontWeight: 400 }}>(선택)</span></label><input type="datetime-local" value={f.scheduleTo} onChange={e => set('scheduleTo', e.target.value)} data-testid="inq-schedTo" style={input} /></div>
            <div style={field()}><label style={label}>장소 <span style={{ color: '#9ca3af', fontWeight: 400 }}>(선택)</span></label><input value={f.place} onChange={e => set('place', e.target.value)} data-testid="inq-place" style={input} /></div>
          </div>}
        </div>
      )}

      {/* ── 미선택 안내 ── */}
      {!isInterp && !isTrans && !isEquip && !isOther && (
        <div data-testid="inq-service-guide" style={{ marginTop: 4, padding: '14px 16px', background: '#f9fafb', border: '1px dashed #d1d5db', borderRadius: 8, fontSize: 13, color: '#6b7280' }}>
          서비스 유형을 선택하면 의뢰 내용을 입력할 수 있습니다.
        </div>
      )}

      {/* ── 요구사항 (모든 서비스 유형 공통) ── */}
      <div style={{ marginTop: 12 }}><label style={label}>요구사항</label><textarea value={f.requirements} onChange={e => set('requirements', e.target.value)} data-testid="inq-requirements" rows={3} style={{ ...input, resize: 'vertical' }} /></div>

      <AttachmentDropzone attachments={attachments} onUpload={onUpload} onRemoveAttachment={onRemoveAttachment} uploading={uploading} />
    </div>
  );
}
