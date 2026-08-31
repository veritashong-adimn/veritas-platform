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
import { EquipmentRow } from '../../lib/inquiryMeta';
import { InquiryFormFields, InquiryFormState, emptyInquiryForm, buildInquiryPayload } from './InquiryFormFields';
import { InquiryAiAnalyzePanel, AiInquiryFields, AiInquiryEquipment } from './InquiryAiAnalyzePanel';

/** 폼에 사용자 입력이 있는지 판정(접수일시는 자동 갱신되므로 제외). 초기화 확인창 노출 판단용. */
function isInquiryFormDirty(f: InquiryFormState): boolean {
  const e = emptyInquiryForm();
  return (Object.keys(e) as (keyof InquiryFormState)[]).some(k => k !== 'receivedAt' && f[k] !== e[k]);
}

export function InquiryRegisterTab({ token, onToast, onDone, adminUsers = [] }: {
  token: string;
  onToast: (m: string) => void;
  onDone?: () => void;
  adminUsers?: Array<{ id: number; name?: string | null; email: string }>;
}) {
  const authH = { Authorization: `Bearer ${token}` };
  const [f, setF] = useState<InquiryFormState>(emptyInquiryForm);
  const [equipment, setEquipment] = useState<EquipmentRow[]>([]);
  const [attachments, setAttachments] = useState<Array<{ name: string; url: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  // 자식(AI 패널 / 폼 필드+거래처 picker)의 내부 state를 초기화 시 리마운트로 완전히 비우기 위한 키
  const [resetKey, setResetKey] = useState(0);
  // AI 패널의 미분석 입력(붙여넣은 텍스트/추가한 파일/분석결과) 존재 여부 — 초기화 확인창 판단용
  const aiDirtyRef = useRef(false);
  const set = (k: keyof InquiryFormState, v: string | boolean) => setF(prev => ({ ...prev, [k]: v }));

  // ── 초기화 ──────────────────────────────────────────────────────────────────
  // 폼(서비스유형·고객정보·거래처/담당자 선택·서비스별 내용·요구사항)·장비·첨부·AI 패널을 모두 비운다.
  // 접수일시는 현재 시각으로, PM 등 기본값 필드는 기본값으로 복귀(emptyInquiryForm).
  const handleReset = () => {
    const hasContent = isInquiryFormDirty(f) || equipment.length > 0 || attachments.length > 0 || aiDirtyRef.current;
    if (hasContent && !window.confirm('입력한 내용이 모두 삭제됩니다. 초기화하시겠습니까?')) return;
    setF(emptyInquiryForm());          // receivedAt=현재시각, channel/customerMode 등 기본값 복귀
    setEquipment([]);
    setAttachments([]);
    aiDirtyRef.current = false;
    setResetKey(k => k + 1);           // AI 패널 + 폼 필드/거래처 picker 리마운트 → 내부 state·검색·경고 초기화
  };

  // AI 분석 결과 → 폼 자동입력. AI가 값을 준 필드만 덮어써 PM의 기존 입력을 보존한다.
  // (등록은 하지 않는다 — 아래 「의뢰건 등록」 버튼으로만 PM이 직접 등록)
  const AI_FIELD_KEYS: (keyof InquiryFormState)[] = [
    'channel', 'serviceType', 'customerCompanyName', 'department', 'contactName', 'contactPosition',
    'contactPhone', 'contactMobile', 'contactEmail', 'languageFrom', 'languageTo',
    'subject', 'requirements', 'quoteDueDate',
    'interpretType', 'scheduleFrom', 'scheduleTo', 'interpretDuration', 'place',
    'documentType', 'documentUsage', 'volume', 'desiredCompletionDate',
  ];
  const applyAi = (fields: AiInquiryFields, eq: AiInquiryEquipment[]) => {
    setF(prev => {
      const next = { ...prev };
      for (const k of AI_FIELD_KEYS) {
        const v = (fields as Record<string, unknown>)[k];
        if (typeof v === 'string' && v.trim()) (next as Record<string, unknown>)[k] = v;
      }
      // 통역+장비: 장비 행이 분석되면 체크박스 자동 활성화(장비 단독은 항상 노출되어 불필요)
      if (eq.length > 0 && next.serviceType === 'interpretation') next.equipmentNeeded = true;
      return next;
    });
    if (eq.length > 0) {
      setEquipment(eq.map(r => ({
        kind: r.kind || '', quantity: (r.quantity || '1').trim(), unit: r.unit || '세트',
        location: r.location || '', note: r.note || '',
      })));
    }
  };

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
        <InquiryAiAnalyzePanel key={`ai-${resetKey}`} token={token} onApply={applyAi} onToast={onToast}
          onDirtyChange={(d) => { aiDirtyRef.current = d; }} />

        <InquiryFormFields
          key={`form-${resetKey}`}
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
