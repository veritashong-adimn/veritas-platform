/**
 * InquiryRegisterTab — 의뢰건 등록
 *
 * PM이 전화/이메일/기타 채널로 받은 의뢰를 직접 등록한다. 접수 단계에서는 기존 거래처/담당자와
 * 연결되지 않아도 등록 가능(원문 문자열로 보관). 확정 연결은 상세 화면에서 진행한다.
 * 서비스 유형(통역/번역/장비/기타)에 따라 조건부 입력폼을 노출한다(InquiryFormFields 공용).
 * 첨부는 기존 /api/upload(R2) 재사용.
 */
import React, { useState } from 'react';
import { api } from '../../lib/constants';
import { EquipmentRow } from '../../lib/inquiryMeta';
import { InquiryFormFields, InquiryFormState, emptyInquiryForm, buildInquiryPayload } from './InquiryFormFields';

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
  const set = (k: keyof InquiryFormState, v: string | boolean) => setF(prev => ({ ...prev, [k]: v }));

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
    <div data-testid="inquiry-register-tab" style={{ maxWidth: 860 }}>
      <h1 style={{ fontSize: 20, fontWeight: 800, color: '#111827', margin: '0 0 4px' }}>의뢰건 등록</h1>
      <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 8px' }}>거래처/담당자가 등록되어 있지 않아도 접수할 수 있습니다. 확정 연결은 상세에서 진행합니다.</p>

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '18px 22px' }}>
        <InquiryFormFields
          f={f} set={set}
          equipment={equipment} setEquipment={setEquipment}
          adminUsers={adminUsers}
          attachments={attachments} onUpload={handleUpload} onRemoveAttachment={(i) => setAttachments(prev => prev.filter((_, j) => j !== i))} uploading={uploading}
        />

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 22 }}>
          {onDone && <button type="button" onClick={onDone} disabled={saving} data-testid="inq-cancel"
            style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #d1d5db', background: '#f9fafb', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#374151' }}>취소</button>}
          <button type="button" onClick={submit} disabled={saving} data-testid="inq-submit"
            style={{ padding: '9px 22px', borderRadius: 8, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, background: saving ? '#93c5fd' : '#2563eb', cursor: saving ? 'not-allowed' : 'pointer' }}>
            {saving ? '등록 중…' : '의뢰건 등록'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default InquiryRegisterTab;
