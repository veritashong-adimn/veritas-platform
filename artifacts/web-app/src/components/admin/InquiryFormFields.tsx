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
  INQUIRY_CHANNELS, INQUIRY_SERVICE_TYPES, INTERPRET_TYPES,
  EQUIPMENT_KINDS, EQUIPMENT_UNITS, EquipmentRow, emptyEquipmentRow,
  OTHER_SERVICE_PRESETS, inquiryServiceTypes,
} from '../../lib/inquiryMeta';
import { CustomerLinkPicker } from './CustomerLinkPicker';
import { DateField } from './DatePickerShared';
import { DocumentTypeMultiSelect } from './DocumentTypeMultiSelect';

const label: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 8, outline: 'none' };
const field = (w?: string): React.CSSProperties => ({ flex: w ? `0 0 ${w}` : '1 1 200px', minWidth: 160 });
const sectionTitle: React.CSSProperties = { fontSize: 13, fontWeight: 800, color: '#111827', margin: '18px 0 10px', paddingBottom: 6, borderBottom: '1px solid #eef2f7' };
const row: React.CSSProperties = { display: 'flex', gap: 12, flexWrap: 'wrap' };

const CR_STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  confirmed:    { label: '확정',      color: '#065f46', bg: '#ecfdf5' },
  needs_review: { label: '확인 필요', color: '#92400e', bg: '#fffbeb' },
  not_provided: { label: '미기재',    color: '#6b7280', bg: '#f3f4f6' },
};
const CR_SOURCE_LABEL: Record<string, string> = { homepage: '홈페이지 고객 제출', email_received: '메일 수신일시', email_sent: '메일 발송일시', manual: '직원 입력', unknown: '출처 미상' };

/**
 * 고객 접수일시 — 날짜 + 시간(선택) + 확인 상태. 원문에 없으면 공란.
 * 직원이 날짜/시간을 직접 바꾸면 상태=확정·출처=직원 입력으로 기록한다(날짜를 지우면 미기재).
 * 상태가 비어 있으면 기존 자료(미분류) — 직원이 입력하기 전까지 그대로 둔다.
 */
function CustomerReceivedField({ f, set }: { f: InquiryFormState; set: (k: keyof InquiryFormState, v: string) => void }) {
  const markManual = (date: string) => {
    set('customerReceivedStatus', date ? 'confirmed' : 'not_provided');
    set('customerReceivedSource', date ? 'manual' : 'unknown');
  };
  const st = CR_STATUS_META[f.customerReceivedStatus];
  return (
    <div style={field('300px')}>
      <label style={label}>고객 접수일시 <span style={{ color: '#9ca3af', fontWeight: 400 }}>(KST · 시간 선택)</span></label>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <DateField value={f.customerReceivedDate} testid="inq-custRecvDate" ariaLabel="고객 접수일" style={{ ...input, flex: '1 1 auto' }}
          onChange={d => { set('customerReceivedDate', d); if (!d) set('customerReceivedTime', ''); markManual(d); }} />
        <input type="time" value={f.customerReceivedTime} disabled={!f.customerReceivedDate} data-testid="inq-custRecvTime" aria-label="고객 접수시각"
          onChange={e => { set('customerReceivedTime', e.target.value); markManual(f.customerReceivedDate); }}
          style={{ ...input, flex: '0 0 104px', color: f.customerReceivedTime ? undefined : '#9ca3af' }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 11, flexWrap: 'wrap' }}>
        <select value={f.customerReceivedStatus} onChange={e => set('customerReceivedStatus', e.target.value)} data-testid="inq-custRecvStatus" aria-label="고객 접수일시 확인 상태"
          style={{ fontSize: 11, padding: '2px 6px', borderRadius: 6, border: '1px solid #e5e7eb', color: st?.color ?? '#6b7280', background: st?.bg ?? '#fff', fontWeight: 700 }}>
          {!f.customerReceivedStatus && <option value="">기존 자료(미분류)</option>}
          {Object.entries(CR_STATUS_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
        </select>
        {f.customerReceivedSource && <span data-testid="inq-custRecvSource" style={{ color: '#6b7280' }}>{CR_SOURCE_LABEL[f.customerReceivedSource] ?? f.customerReceivedSource}</span>}
        {f.customerReceivedDate && !f.customerReceivedTime && <span style={{ color: '#9ca3af' }}>시각 미기재</span>}
      </div>
    </div>
  );
}

/** 일정 입력 — 날짜(필수 아님) + 시간(선택). 시간을 비우면 "시간 미정"으로 저장된다. */
function ScheduleInput({ label: text, value, onChange, testid, optional }: {
  label: string; value: string; onChange: (v: string) => void; testid: string; optional?: boolean;
}) {
  const date = value.slice(0, 10);
  const time = value.length > 10 ? value.slice(11, 16) : '';
  const emit = (d: string, t: string) => onChange(d ? (t ? `${d}T${t}` : d) : '');
  return (
    <>
      <label style={label}>{text}{optional && <span style={{ color: '#9ca3af', fontWeight: 400 }}> (선택)</span>}</label>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <DateField value={date} onChange={d => emit(d, d ? time : '')} testid={testid} ariaLabel={`${text} 날짜`} style={{ ...input, flex: '1 1 auto' }} />
        <input type="time" value={time} disabled={!date} onChange={e => emit(date, e.target.value)}
          data-testid={`${testid}-time`} aria-label={`${text} 시간`} style={{ ...input, flex: '0 0 110px', color: time ? undefined : '#9ca3af' }} />
        {date && time && (
          <button type="button" onClick={() => emit(date, '')} data-testid={`${testid}-time-clear`} aria-label={`${text} 시간 지우기(미정)`}
            style={{ border: 'none', background: 'none', color: '#6b7280', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' }}>미정</button>
        )}
      </div>
      {date && !time && <div data-testid={`${testid}-time-tbd`} style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>시간 미정</div>}
    </>
  );
}

// ── 폼 상태 ────────────────────────────────────────────────────────────────────
export interface InquiryFormState {
  receivedAt: string; channel: string; assignedPmId: string;   // receivedAt: 목록 기준 일시(화면 입력 없음·저장 시 서버가 기록)
  // 고객 접수일시 — 고객이 실제 의뢰를 제출한 일시. 시스템 등록일시(created_at)와 별개. 원문에 없으면 공란.
  customerReceivedDate: string;         // YYYY-MM-DD
  customerReceivedTime: string;         // HH:mm, '' = 시각 미기재
  customerReceivedStatus: string;       // confirmed | needs_review | not_provided | '' (기존 자료·미분류)
  customerReceivedSource: string;       // homepage | email_received | email_sent | manual | unknown
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

// 접수일시 — 화면 입력·표시·저장 모두 KST 기준(브라우저 시간대와 무관). 상세 화면도 KST 로 표시한다.
const KST_MS = 9 * 3600_000;
/** 현재 시각(KST 벽시계 "YYYY-MM-DDTHH:mm") — 신규 등록 화면의 접수일시 기본값 */
function nowKstInput(): string {
  return new Date(Date.now() + KST_MS).toISOString().slice(0, 16);
}
function isoToKstInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d.getTime())) return '';
  return new Date(d.getTime() + KST_MS).toISOString().slice(0, 16);
}
/**
 * 일정(시작/종료) — 시간 미정을 허용한다. 폼 값: "YYYY-MM-DD"(시간 미정) 또는 "YYYY-MM-DDTHH:mm".
 * 저장 컬럼은 timestamp 그대로이므로 시간 미정은 "그 날짜 00:00(KST)"으로 저장하고, 불러올 때 00:00 이면 날짜만 표시한다.
 * 상세·견적 연동이 KST 기준으로 표시하므로 브라우저 시간대와 무관하게 KST(+09:00)로 변환한다.
 */
function isoToScheduleInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d.getTime())) return '';
  const kst = new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 16);   // UTC+9 벽시계
  return kst.endsWith('T00:00') ? kst.slice(0, 10) : kst;
}
function scheduleToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v.length === 10 ? `${v}T00:00:00+09:00` : `${v}:00+09:00`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function isoToDateInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function emptyInquiryForm(): InquiryFormState {
  return {
    // 접수경로는 미선택으로 시작(근거 없이 '전화'로 고정하지 않음) — 등록 전 선택 필수
    receivedAt: nowKstInput(), channel: '', assignedPmId: '',
    // 고객 접수일시는 공란으로 시작(등록 화면을 연 시각을 접수일시로 넣지 않음)
    customerReceivedDate: '', customerReceivedTime: '', customerReceivedStatus: 'not_provided', customerReceivedSource: 'unknown',
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
    receivedAt: isoToKstInput(d.receivedAt), channel: d.channel ?? 'phone', assignedPmId: d.assignedPmId != null ? String(d.assignedPmId) : '',
    customerReceivedDate: d.customerReceivedDate ?? '', customerReceivedTime: (d.customerReceivedTime ?? '').slice(0, 5),
    customerReceivedStatus: d.customerReceivedStatus ?? '', customerReceivedSource: d.customerReceivedSource ?? '',
    customerMode: d.companyId != null ? 'existing' : 'new',
    companyId: d.companyId != null ? String(d.companyId) : '', contactId: d.contactId != null ? String(d.contactId) : '', divisionId: d.divisionId != null ? String(d.divisionId) : '',
    customerCompanyName: d.customerCompanyName ?? '', department: d.department ?? '', contactName: d.contactName ?? '', contactPosition: d.contactPosition ?? '',
    contactPhone: d.contactPhone ?? '', contactMobile: d.contactMobile ?? '', contactEmail: d.contactEmail ?? '',
    serviceType: d.serviceType ?? '', serviceTypes: inquiryServiceTypes(d),
    ...splitOtherServices(Array.isArray(d.otherServices) ? d.otherServices : []),
    languageFrom: d.languageFrom ?? '', languageTo: d.languageTo ?? '',
    quoteDueDate: isoToDateInput(d.quoteDueDate),
    interpretType: d.interpretType ?? '', scheduleFrom: isoToScheduleInput(d.scheduleFrom), scheduleTo: isoToScheduleInput(d.scheduleTo),
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
  if (!f.channel) return '접수경로를 선택해 주세요. (이메일·전화·홈페이지 등 고객이 의뢰를 전달한 방식)';
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
    // received_at 은 보내지 않는다 — 신규는 서버가 저장 시각을 기록, 수정은 기존 값 유지(목록·집계 기준 불변)
    customerReceivedDate: f.customerReceivedDate || null,
    customerReceivedTime: f.customerReceivedDate && f.customerReceivedTime ? f.customerReceivedTime : null,
    // 상태가 비어 있으면(기존 자료) 보내지 않아 미분류(NULL) 그대로 유지 — 과거 자료를 임의로 분류하지 않음
    ...(f.customerReceivedStatus ? { customerReceivedStatus: f.customerReceivedStatus } : {}),
    ...(f.customerReceivedSource ? { customerReceivedSource: f.customerReceivedSource } : {}),
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
    scheduleFrom: (isInterp || isEquip || isOther) ? scheduleToIso(f.scheduleFrom) : null,
    scheduleTo: (isInterp || isEquip || isOther) ? scheduleToIso(f.scheduleTo) : null,
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
              <option value="">선택</option>
              {EQUIPMENT_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
            </select></div>
          <div style={{ flex: '0 0 84px' }}><div style={cellL}>대여일수</div>
            <div style={{ position: 'relative' }}>
              <input value={r.days ?? ''} onChange={e => upd(i, 'days', e.target.value)} data-testid={`inq-eq-days-${i}`} aria-label={`장비 ${i + 1} 대여일수`} style={{ ...input, paddingRight: 22 }} inputMode="numeric" placeholder="-" />
              <span style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: '#6b7280' }}>일</span>
            </div></div>
          <div style={{ flex: '1 1 160px', minWidth: 140 }}><div style={cellL}>사용 장소</div>
            <input value={r.location} onChange={e => upd(i, 'location', e.target.value)} data-testid={`inq-eq-loc-${i}`} style={input} placeholder="예: 코엑스 3층" /></div>
          <div style={{ flex: '1 1 200px', minWidth: 160 }}><div style={cellL}>설치/운영·기타 요청사항</div>
            <input value={r.note} onChange={e => upd(i, 'note', e.target.value)} data-testid={`inq-eq-note-${i}`} style={input} placeholder="예: 오전 8시까지 설치 완료" title={r.note || undefined} /></div>
          {/* 원본 견적 참고단가(AI 분석) — 읽기 전용. 견적 화면에서 담당자가 [적용]할 때만 단가로 쓴다 */}
          {Number(r.refUnitPrice) > 0 && (
            <div data-testid={`inq-eq-ref-${i}`} style={{ flex: '0 0 auto', alignSelf: 'center', fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' }}
              title="원본 견적서의 단가·공급가액(참고정보 — 신규 견적 금액 아님)">
              원본 단가 {Number(r.refUnitPrice).toLocaleString()}원{Number(r.refAmount) > 0 ? ` · 공급가액 ${Number(r.refAmount).toLocaleString()}원` : ''}
            </div>
          )}
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
export function InquiryFormFields({ f, set, equipment, setEquipment, adminUsers = [], attachments, onUpload, onRemoveAttachment, uploading = false, token, showCustomerPicker = false, systemRegisteredAt }: {
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
  systemRegisteredAt?: string | null;   // 시스템 등록일시(created_at, 읽기 전용). 없으면 '저장 시 자동 기록'
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
        <CustomerReceivedField f={f} set={set} />
        <div style={field('160px')}><label style={label}>접수경로</label>
          <select value={f.channel} onChange={e => set('channel', e.target.value)} data-testid="inq-channel" aria-label="접수경로"
            style={{ ...input, ...(f.channel ? {} : { color: '#b45309', borderColor: '#fcd34d' }) }}>
            {!f.channel && <option value="">미선택 (확인 필요)</option>}
            {INQUIRY_CHANNELS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select></div>
        <div style={field('200px')}><label style={label}>담당 PM</label>
          <select value={f.assignedPmId} onChange={e => set('assignedPmId', e.target.value)} data-testid="inq-pm" style={input}>
            <option value="">미지정</option>
            {adminUsers.map(u => <option key={u.id} value={u.id}>{u.name ?? u.email}</option>)}
          </select></div>
        <div style={field('200px')}><label style={label}>견적서 수령 희망일 <span style={{ color: '#9ca3af', fontWeight: 400 }}>(선택)</span></label>
          <DateField value={f.quoteDueDate} onChange={v => set('quoteDueDate', v)} testid="inq-quoteDue" ariaLabel="견적서 수령 희망일" style={input} /></div>
        <div style={field('180px')}><label style={label}>시스템 등록일시</label>
          <div data-testid="inq-system-registered" aria-label="시스템 등록일시(읽기 전용)"
            style={{ ...input, background: '#f9fafb', color: systemRegisteredAt ? '#374151' : '#9ca3af' }}>
            {systemRegisteredAt ? new Date(systemRegisteredAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '저장 시 자동 기록'}
          </div></div>
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
            <div style={field()}><ScheduleInput label="통역 시작일" value={f.scheduleFrom} onChange={v => set('scheduleFrom', v)} testid="inq-schedFrom" /></div>
            <div style={field()}><ScheduleInput label="통역 종료일" value={f.scheduleTo} onChange={v => set('scheduleTo', v)} testid="inq-schedTo" /></div>
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
            <div style={field('240px')}><label style={label}>원문서 형태 <span style={{ color: '#9ca3af', fontWeight: 400 }}>(복수 선택)</span></label>
              <DocumentTypeMultiSelect value={f.documentType} onChange={v => set('documentType', v)} style={input} /></div>
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
              <div style={field()}><ScheduleInput label="장비 사용 시작일" value={f.scheduleFrom} onChange={v => set('scheduleFrom', v)} testid="inq-schedFrom" /></div>
              <div style={field()}><ScheduleInput label="장비 사용 종료일" value={f.scheduleTo} onChange={v => set('scheduleTo', v)} testid="inq-schedTo" /></div>
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
            <div style={field()}><ScheduleInput label="희망 일정 시작일" optional value={f.scheduleFrom} onChange={v => set('scheduleFrom', v)} testid="inq-schedFrom" /></div>
            <div style={field()}><ScheduleInput label="희망 일정 종료일" optional value={f.scheduleTo} onChange={v => set('scheduleTo', v)} testid="inq-schedTo" /></div>
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
