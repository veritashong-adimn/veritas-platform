/**
 * InquiryRegisterTab — 의뢰건 등록
 *
 * PM이 전화/이메일/기타 채널로 받은 의뢰를 직접 등록한다. 접수 단계에서는 기존 거래처/담당자와
 * 연결되지 않아도 등록 가능(원문 문자열로 보관). 확정 연결은 상세 화면에서 진행한다.
 * 서비스 유형(통역/번역/장비/기타)에 따라 조건부 입력폼을 노출한다(InquiryFormFields 공용).
 * 첨부는 기존 /api/upload(R2) 재사용.
 */
import React, { useRef, useState } from 'react';
import { api } from '../../lib/constants';
import { confirmDialog } from '../ui';
import { EquipmentRow, aiEquipmentToRow } from '../../lib/inquiryMeta';
import { InquiryFormFields, InquiryFormState, emptyInquiryForm, buildInquiryPayload, validateInquiryServices } from './InquiryFormFields';
import { OTHER_SERVICE_PRESETS } from '../../lib/inquiryMeta';
import { InquiryAiAnalyzePanel, AiInquiryFields, AiInquiryEquipment, AiApplyReport } from './InquiryAiAnalyzePanel';

/** 폼에 사용자 입력이 있는지 판정(접수일시는 자동 갱신되므로 제외). 배열 필드는 값으로 비교. 초기화 확인창 노출 판단용. */
function isInquiryFormDirty(f: InquiryFormState): boolean {
  const e = emptyInquiryForm();
  return (Object.keys(e) as (keyof InquiryFormState)[]).some(k => k !== 'receivedAt' && JSON.stringify(f[k]) !== JSON.stringify(e[k]));
}

/** 언어 칸 안내문구(미선택 드롭다운) — 서버에서도 거르지만 화면 입력 직전에 한 번 더 막는다 */
const isLangPlaceholder = (v: string) => /^(?:언어|출발언어|도착언어|원문언어|목표언어|언어선택|선택)$/.test(v.replace(/[^\p{L}]+/gu, '').replace(/([가-힣])v$/i, '$1'));

/** 폼 필드 키 → 화면 라벨(확인창·충돌 안내용) */
const INQ_FIELD_LABELS: Record<string, string> = {
  customerReceivedDate: '고객 접수일', customerReceivedTime: '고객 접수시각', customerReceivedStatus: '접수일시 확인 상태', customerReceivedSource: '접수일시 출처',
  channel: '접수경로', serviceType: '서비스 유형', serviceTypes: '서비스 유형', customerCompanyName: '회사명', department: '부서', contactName: '담당자',
  contactPosition: '직함', contactPhone: '전화번호', contactMobile: '휴대폰', contactEmail: '이메일',
  languageFrom: '출발 언어', languageTo: '도착 언어', subject: '주제', requirements: '요구사항', quoteDueDate: '견적서 수령 희망일',
  interpretType: '통역 형태', scheduleFrom: '시작일', scheduleTo: '종료일', interpretDuration: '1일 통역시간', place: '장소',
  documentType: '원문서 형태', documentUsage: '문서 사용처', volume: '분량', desiredCompletionDate: '완료 희망일',
  companyId: '거래처 연결', contactId: '담당자 연결', assignedPmId: '담당 PM', otherServices: '기타 서비스', equipmentNeeded: '통역장비 필요',
};

export function InquiryRegisterTab({ token, onToast, onDone, adminUsers = [] }: {
  token: string;
  onToast: (m: string) => void;
  onDone?: () => void;
  adminUsers?: Array<{ id: number; name?: string | null; email: string }>;
}) {
  const authH = { Authorization: `Bearer ${token}` };
  const [f, setF] = useState<InquiryFormState>(emptyInquiryForm);
  const fRef = useRef(f);
  fRef.current = f;   // AI 응답(비동기) 시점의 최신 폼 상태 참조용
  const [equipment, setEquipment] = useState<EquipmentRow[]>([]);
  const equipmentRef = useRef(equipment);
  equipmentRef.current = equipment;
  const [attachments, setAttachments] = useState<Array<{ name: string; url: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  // 자식(AI 패널 / 폼 필드+거래처 picker)의 내부 state를 초기화 시 리마운트로 완전히 비우기 위한 키
  const [resetKey, setResetKey] = useState(0);
  // AI 패널만 리마운트(분석 초기화) — 입력 텍스트·첨부·결과·경고·추출 원문 등 패널 내부 상태를 모두 비운다
  const [aiPanelKey, setAiPanelKey] = useState(0);
  // AI 패널의 미분석 입력(붙여넣은 텍스트/추가한 파일/분석결과) 존재 여부 — 초기화 확인창 판단용
  const aiDirtyRef = useRef(false);
  // 사용자가 직접 입력/수정한 필드 — AI 재분석이 덮어쓰지 않는다(AI 자동입력은 setF 로 직접 반영되어 여기에 기록되지 않음).
  const userEditedRef = useRef<Set<keyof InquiryFormState>>(new Set());
  // AI가 자동입력한 값(분석 초기화 시 이 값 그대로인 항목만 되돌린다)
  const aiAppliedRef = useRef<Map<keyof InquiryFormState, string>>(new Map());
  const aiServiceTypesRef = useRef<Set<string>>(new Set());     // AI가 추가한 서비스 유형
  const aiOtherServicesRef = useRef<Set<string>>(new Set());    // AI가 추가한 기타 세부(프리셋)
  const aiEquipmentRef = useRef<EquipmentRow[] | null>(null);   // AI가 채운 장비행(참조 동일하면 미수정)
  // 사용자가 직접 켜거나 끈 서비스 유형(유형 단위) — AI 제안 교체·분석 초기화 대상에서 제외
  const userTypeToggledRef = useRef<Set<string>>(new Set());
  const set = (k: keyof InquiryFormState, v: string | boolean | string[]) => {
    if (k === 'serviceTypes' && Array.isArray(v)) {
      const prevT = fRef.current.serviceTypes;
      [...v.filter(t => !prevT.includes(t)), ...prevT.filter(t => !v.includes(t))].forEach(t => userTypeToggledRef.current.add(t));
    }
    if (k !== 'serviceTypes') userEditedRef.current.add(k);
    setF(prev => ({ ...prev, [k]: v }));
  };
  const clearAiTracking = () => {
    aiAppliedRef.current = new Map();
    aiServiceTypesRef.current = new Set();
    aiOtherServicesRef.current = new Set();
    aiEquipmentRef.current = null;
  };

  // ── 전체 초기화 ──────────────────────────────────────────────────────────────
  // 폼(서비스유형·고객정보·거래처/담당자 선택·서비스별 내용·요구사항)·장비·첨부·AI 패널을 모두 비운다.
  // 접수일시는 현재 시각으로, PM 등 기본값 필드는 기본값으로 복귀(emptyInquiryForm). 저장된 의뢰건·Master 는 건드리지 않는다.
  const handleReset = async () => {
    const hasContent = isInquiryFormDirty(f) || equipment.length > 0 || attachments.length > 0 || aiDirtyRef.current;
    if (hasContent && !(await confirmDialog({ title: '입력 초기화', message: '작성 중인 내용(고객정보·서비스 유형·일정·언어·상세정보·요구사항·AI 분석 결과·첨부)이 모두 지워지고 최초 등록 화면으로 돌아갑니다. 이미 저장된 의뢰건과 거래처·담당자 정보는 변경되지 않습니다. 초기화하시겠습니까?', confirmLabel: '초기화', variant: 'warning' }))) return;
    setF(emptyInquiryForm());          // receivedAt=현재시각, channel/customerMode 등 기본값 복귀
    setEquipment([]);
    setAttachments([]);
    aiDirtyRef.current = false;
    userEditedRef.current = new Set();
    userTypeToggledRef.current = new Set();
    clearAiTracking();
    setResetKey(k => k + 1);           // AI 패널 + 폼 필드/거래처 picker 리마운트 → 내부 state·검색·경고 초기화
  };

  // ── 분석 초기화 ──────────────────────────────────────────────────────────────
  // AI 패널(입력 텍스트·분석용 첨부·결과·신뢰도·경고·추출 원문)과 AI가 자동입력한 값만 되돌린다.
  // 사용자가 직접 입력/수정한 값은 유지하며, 그런 값이 있으면 먼저 확인창을 띄운다. 저장 데이터·Master 는 건드리지 않는다.
  const handleResetAi = async (): Promise<void> => {
    const cur = fRef.current;
    const empty = emptyInquiryForm();
    const edited = [...userEditedRef.current].filter(k => k !== 'receivedAt' && JSON.stringify(cur[k]) !== JSON.stringify(empty[k]));
    if (userTypeToggledRef.current.size > 0) edited.push('serviceTypes');
    let removeEdited = false;
    if (edited.length > 0) {
      const names = [...new Set(edited.map(k => INQ_FIELD_LABELS[k] ?? k))].join(', ');
      const ok = await confirmDialog({
        title: '분석 초기화',
        message: `AI 분석 결과와 AI가 자동입력한 항목을 초기화합니다.\n직접 입력·수정한 항목이 있습니다: ${names}. 계속하시겠습니까?`,
        confirmLabel: '계속', variant: 'warning',
      });
      if (!ok) return;
      // 직접 수정값은 사용자가 고른다 — 기본(취소/닫기)은 유지
      removeEdited = await confirmDialog({
        title: '직접 수정한 항목',
        message: `직접 입력·수정한 항목(${names})도 함께 지울까요?`,
        confirmLabel: '함께 삭제', cancelLabel: '유지', variant: 'warning',
      });
    }
    const applied = aiAppliedRef.current;
    const aiTypes = aiServiceTypesRef.current;
    const aiOthers = aiOtherServicesRef.current;
    const toggled = removeEdited ? new Set<string>() : userTypeToggledRef.current;
    const editedKeys = removeEdited ? edited : [];
    setF(prev => {
      const next = { ...prev };
      for (const k of editedKeys) (next as Record<string, unknown>)[k] = empty[k];
      for (const [k, v] of applied) {
        if (!userEditedRef.current.has(k) && prev[k] === v) (next as Record<string, unknown>)[k] = empty[k];
      }
      next.serviceTypes = removeEdited ? [] : prev.serviceTypes.filter(t => !aiTypes.has(t) || toggled.has(t));
      if (!userEditedRef.current.has('otherServices')) next.otherServices = prev.otherServices.filter(o => !aiOthers.has(o));
      return next;
    });
    if (aiEquipmentRef.current && equipmentRef.current === aiEquipmentRef.current) setEquipment([]);
    if (removeEdited) { editedKeys.forEach(k => userEditedRef.current.delete(k)); userTypeToggledRef.current = new Set(); }
    clearAiTracking();
    aiDirtyRef.current = false;
    setAiPanelKey(k => k + 1);
    onToast('AI 분석을 초기화했습니다. 새 자료로 다시 분석할 수 있습니다.');
  };

  // AI 분석 결과 → 폼 자동입력. 사용자가 직접 수정한 값·Master 연결값은 덮어쓰지 않고 충돌로 보고한다.
  // (등록은 하지 않는다 — 아래 「의뢰건 등록」 버튼으로만 PM이 직접 등록)
  // 고객 접수일시: 원문의 고객 제출 일시가 있을 때만 날짜/시각이 오고, 상태(확정/확인 필요/미기재)·출처는 항상 온다.
  //   메일 수신·발송 일시는 자동입력하지 않는다(패널의 후보 적용 버튼으로 직원이 결정).
  const AI_FIELD_KEYS: (keyof InquiryFormState)[] = [
    'customerReceivedDate', 'customerReceivedTime', 'customerReceivedStatus', 'customerReceivedSource', 'channel', 'serviceType', 'customerCompanyName', 'department', 'contactName', 'contactPosition',
    'contactPhone', 'contactMobile', 'contactEmail', 'languageFrom', 'languageTo',
    'subject', 'requirements', 'quoteDueDate',
    'interpretType', 'scheduleFrom', 'scheduleTo', 'interpretDuration', 'place',
    'documentType', 'documentUsage', 'volume', 'desiredCompletionDate',
  ];
  const CONTACT_KEYS: (keyof InquiryFormState)[] = ['department', 'contactName', 'contactPosition', 'contactPhone', 'contactMobile', 'contactEmail'];
  const applyAi = (fields: AiInquiryFields, eq: AiInquiryEquipment[]): AiApplyReport => {
    const cur = fRef.current;
    const firstApply = aiAppliedRef.current.size === 0 && aiServiceTypesRef.current.size === 0;   // 아래 필드 반영 전에 판정
    const report: AiApplyReport = { conflicts: [], replaced: [] };
    const updates: Partial<Record<keyof InquiryFormState, string>> = {};
    for (const k of AI_FIELD_KEYS) {
      const v = (fields as Record<string, unknown>)[k];
      if (typeof v !== 'string' || !v.trim() || v === cur[k]) continue;
      if ((k === 'languageFrom' || k === 'languageTo') && isLangPlaceholder(v)) continue;
      // 직원이 고객 접수일시(날짜/시각)를 직접 정했으면 상태·출처도 직원 결정을 유지(충돌로 표시하지 않음)
      if ((k === 'customerReceivedStatus' || k === 'customerReceivedSource')
        && (userEditedRef.current.has('customerReceivedDate') || userEditedRef.current.has('customerReceivedTime') || userEditedRef.current.has(k))) continue;
      const curV = String(cur[k] ?? '');
      const byMaster = (!!cur.contactId && CONTACT_KEYS.includes(k)) || (!!cur.companyId && k === 'customerCompanyName');
      if (userEditedRef.current.has(k) || byMaster) {
        report.conflicts.push({ key: k, current: curV, ai: v, reason: userEditedRef.current.has(k) ? 'user' : 'master' });
        continue;
      }
      if (curV.trim() && aiAppliedRef.current.has(k)) report.replaced.push({ key: k, prev: curV, ai: v });
      updates[k] = v;
      aiAppliedRef.current.set(k, v);
    }
    const aiTypes = new Set<string>([
      ...(Array.isArray(fields.serviceTypes) && fields.serviceTypes.length ? fields.serviceTypes : (fields.serviceType ? [fields.serviceType] : [])),
      ...(eq.length > 0 ? ['equipment'] : []),
    ]);
    const others = Array.isArray(fields.otherServices) ? fields.otherServices.filter(Boolean) : [];
    if (others.length) aiTypes.add('other');
    // 첫 AI 자동입력(이번 화면에서 아직 AI 결과가 반영된 적 없음)이고 AI가 유형을 판정했으면,
    // 분석 전에 골라 둔 유형은 AI 판정으로 교체한다(예: 통역 선택 상태에서 번역 단독 의뢰 분석 → 통역 해제).
    // AI 분석 이후 사용자가 직접 바꾼 유형은 기존대로 유지한다.
    if (firstApply && aiTypes.size > 0) userTypeToggledRef.current = new Set();
    const toggled = userTypeToggledRef.current;
    const prevAiTypes = aiServiceTypesRef.current;
    setF(prev => {
      const next = { ...prev, ...updates } as InquiryFormState;   // AI_FIELD_KEYS 는 모두 문자열 필드
      // 서비스 유형 — 사용자가 직접 고르지 않았다면 이전 AI 제안은 이번 분석 결과로 교체(재분석 시 잘못된 유형이 누적되지 않게).
      // 사용자가 직접 고른 유형은 유지하고 AI 제안은 추가만 한다.
      // 사용자가 직접 끈 유형은 AI 가 다시 켜지 않는다
      const base = firstApply && aiTypes.size > 0 ? [] : prev.serviceTypes.filter(t => !prevAiTypes.has(t) || toggled.has(t));
      next.serviceTypes = [...new Set([...base, ...[...aiTypes].filter(t => !(toggled.has(t) && !prev.serviceTypes.includes(t)))])];
      // 기타 세부 제안 — 프리셋(감수/편집/공증)은 해당 버튼, 그 외는 직접 입력란에 추가
      if (others.length) {
        const presets = others.filter(o => (OTHER_SERVICE_PRESETS as readonly string[]).includes(o));
        const custom = others.filter(o => !(OTHER_SERVICE_PRESETS as readonly string[]).includes(o));
        next.otherServices = [...new Set([...prev.otherServices, ...presets])];
        presets.forEach(o => { if (!prev.otherServices.includes(o)) aiOtherServicesRef.current.add(o); });
        if (custom.length) { next.otherCustomOn = true; next.otherCustom = [...prev.otherCustom.filter(v => v.trim()), ...custom]; }
      }
      return next;
    });
    aiServiceTypesRef.current = new Set([...aiTypes].filter(t => !toggled.has(t)));
    if (eq.length > 0) {
      // 기존 장비 목록·단위에 맞춰 매핑(목록 밖 장비명·단위는 비고에 원문 보존, 원문에 없는 수량·단위는 비워 둠)
      const rows = eq.map(aiEquipmentToRow);
      if (!aiEquipmentRef.current || equipmentRef.current === aiEquipmentRef.current || equipmentRef.current.length === 0) {
        setEquipment(rows);
        aiEquipmentRef.current = rows;
      }
    }
    return report;
  };

  /** 충돌 항목에서 사용자가 「AI 값 적용」을 고른 경우 — 사용자 결정이므로 직접 수정값으로 기록 */
  const resolveConflict = (key: string, value: string) => set(key as keyof InquiryFormState, value);

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData(); fd.append('file', file);
        const res = await fetch(api('/api/upload'), { method: 'POST', headers: authH, body: fd });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) { onToast(d.error ?? '첨부 업로드 실패'); continue; }
        setAttachments(prev => [...prev, { name: file.name, url: d.fileUrl }]);
      }
    } finally { setUploading(false); }
  };

  const submit = async () => {
    const svcErr = validateInquiryServices(f);
    if (svcErr) { onToast(svcErr); return; }
    if (!f.customerCompanyName.trim() && !f.contactName.trim() && !f.subject.trim()) {
      onToast('회사명·담당자·주제 중 하나 이상 입력해 주세요.'); return;
    }
    setSaving(true);
    try {
      const body = buildInquiryPayload(f, equipment, attachments);
      const res = await fetch(api('/api/admin/inquiries'), { method: 'POST', headers: { ...authH, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(d.error ?? '의뢰건 등록 실패'); return; }
      onToast(`의뢰건이 등록되었습니다. (${d.inquiryNumber ?? ''})`);
      onDone?.();
    } catch { onToast('의뢰건 등록 중 오류가 발생했습니다.'); }
    finally { setSaving(false); }
  };

  return (
    <div data-testid="inquiry-register-tab" style={{ maxWidth: 1100 }}>
      <h1 style={{ fontSize: 20, fontWeight: 800, color: '#111827', margin: '0 0 4px' }}>의뢰건 등록</h1>
      <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 8px' }}>거래처/담당자가 등록되어 있지 않아도 접수할 수 있습니다. 확정 연결은 상세에서 진행합니다.</p>

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '18px 22px' }}>
        <InquiryAiAnalyzePanel key={`ai-${resetKey}-${aiPanelKey}`} token={token} onApply={applyAi} onToast={onToast}
          onResetAi={handleResetAi} onResolveConflict={resolveConflict}
          onDirtyChange={(d) => { aiDirtyRef.current = d; }} />

        <InquiryFormFields
          key={`form-${resetKey}`}
          systemRegisteredAt={null}
          f={f} set={set}
          equipment={equipment} setEquipment={setEquipment}
          adminUsers={adminUsers}
          token={token} showCustomerPicker
          attachments={attachments} onUpload={handleUpload} onRemoveAttachment={(i) => setAttachments(prev => prev.filter((_, j) => j !== i))} uploading={uploading}
        />

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 22 }}>
          <button type="button" onClick={handleReset} disabled={saving} data-testid="inq-reset" aria-label="입력 초기화"
            style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #fca5a5', background: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', color: '#dc2626' }}>초기화</button>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
          {onDone && <button type="button" onClick={onDone} disabled={saving} data-testid="inq-cancel"
            style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #d1d5db', background: '#f9fafb', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#374151' }}>취소</button>}
          <button type="button" onClick={submit} disabled={saving} data-testid="inq-submit"
            style={{ padding: '9px 22px', borderRadius: 8, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, background: saving ? '#93c5fd' : '#2563eb', cursor: saving ? 'not-allowed' : 'pointer' }}>
            {saving ? '등록 중…' : '의뢰건 등록'}
          </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default InquiryRegisterTab;
