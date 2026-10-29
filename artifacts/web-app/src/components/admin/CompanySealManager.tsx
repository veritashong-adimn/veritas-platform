/**
 * CompanySealManager — 환경설정 > 공급자 정보의 회사 직인 관리.
 *  · 등록·교체·삭제·견적서 표시 여부는 관리자만(서버가 다시 확인). 직원은 상태만 본다.
 *  · 이미지는 서버가 R2 비공개 경로에 저장하고, 미리보기는 서버가 내려준 data URI 로만 표시(원본 URL 미노출).
 */
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/constants';
import { confirmDialog } from '../ui';

interface SealStatus {
  registered: boolean; showOnQuote: boolean; canManage: boolean; storageReady: boolean;
  previewDataUrl: string | null; legacyUrl: boolean;
}

const btn = (primary = false, danger = false): React.CSSProperties => ({
  padding: '7px 14px', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer',
  border: primary ? 'none' : `1px solid ${danger ? '#fecaca' : '#d1d5db'}`,
  background: primary ? '#2563eb' : '#fff', color: primary ? '#fff' : danger ? '#dc2626' : '#374151',
});

export function CompanySealManager({ token, onToast }: { token: string; onToast: (msg: string) => void }) {
  const [st, setSt] = useState<SealStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const authH = { Authorization: `Bearer ${token}` };

  const load = async () => {
    const r = await fetch(api('/api/admin/company-seal'), { headers: authH });
    setSt(r.ok ? await r.json() : null);
  };
  useEffect(() => { void load(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const upload = async (file: File) => {
    if (!/^image\/(png|jpeg)$/.test(file.type)) { onToast('PNG 또는 JPG 이미지만 등록할 수 있습니다(투명 배경 PNG 권장).'); return; }
    if (file.size > 2 * 1024 * 1024) { onToast('직인 이미지는 2MB 이하만 등록할 수 있습니다.'); return; }
    if (st?.registered && !await confirmDialog({ title: '직인 교체', message: '등록된 직인을 새 이미지로 교체하시겠습니까?\n이후 출력하는 견적서에 새 직인이 사용됩니다.', confirmLabel: '교체', cancelLabel: '취소' })) return;
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await fetch(api('/api/admin/company-seal'), { method: 'POST', headers: authH, body: fd });
      const d = await r.json().catch(() => ({}));
      onToast(r.ok ? d.message ?? '직인 이미지를 등록했습니다.' : d.error ?? '직인 등록에 실패했습니다.');
      if (r.ok) await load();
    } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const remove = async () => {
    if (!await confirmDialog({ title: '직인 삭제', message: '등록된 직인 이미지를 삭제하시겠습니까?\n이후 출력하는 견적서에는 직인이 표시되지 않습니다.', confirmLabel: '삭제', cancelLabel: '취소', variant: 'danger' })) return;
    setBusy(true);
    try {
      const r = await fetch(api('/api/admin/company-seal'), { method: 'DELETE', headers: authH });
      const d = await r.json().catch(() => ({}));
      onToast(r.ok ? d.message ?? '직인 이미지를 삭제했습니다.' : d.error ?? '직인 삭제에 실패했습니다.');
      if (r.ok) await load();
    } finally { setBusy(false); }
  };
  const toggle = async (show: boolean) => {
    setBusy(true);
    try {
      const r = await fetch(api('/api/admin/company-seal'), { method: 'PATCH', headers: { ...authH, 'Content-Type': 'application/json' }, body: JSON.stringify({ showOnQuote: show }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setSt(s => (s ? { ...s, showOnQuote: show } : s)); onToast(show ? '견적서에 직인을 표시합니다.' : '견적서에 직인을 표시하지 않습니다.'); }
      else onToast(d.error ?? '설정 저장에 실패했습니다.');
    } finally { setBusy(false); }
  };

  if (!st) return null;
  return (
    <div data-testid="company-seal" style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #f0f0f0' }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 4 }}>회사 직인</div>
      <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 10 }}>견적서 첫 페이지 공급자 정보의 상호 오른쪽에 표시됩니다. 투명 배경 PNG 권장(2MB 이하).</div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <div data-testid="company-seal-preview" style={{ width: 84, height: 84, flexShrink: 0, border: '1px solid #e2e8f0', borderRadius: 8, background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {st.previewDataUrl
            ? <img src={st.previewDataUrl} alt="등록된 직인" style={{ maxWidth: 72, maxHeight: 72, objectFit: 'contain' }} />
            : <span style={{ fontSize: 11, color: '#9ca3af' }}>{st.registered ? '등록됨' : '미등록'}</span>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          {st.canManage ? (
            <>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <input ref={fileRef} type="file" accept="image/png,image/jpeg" style={{ display: 'none' }} data-testid="company-seal-file" aria-label="직인 이미지 파일"
                  onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
                <button type="button" disabled={busy || !st.storageReady} onClick={() => fileRef.current?.click()} style={btn(true)}
                  data-testid="company-seal-upload" aria-label={st.registered ? '직인 이미지 교체' : '직인 이미지 등록'}>
                  {st.registered ? '이미지 교체' : '직인 이미지 등록'}
                </button>
                {st.registered && (
                  <button type="button" disabled={busy} onClick={() => void remove()} style={btn(false, true)} data-testid="company-seal-delete" aria-label="직인 이미지 삭제">삭제</button>
                )}
              </div>
              {st.registered && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#374151', cursor: 'pointer' }}>
                  <input type="checkbox" checked={st.showOnQuote} disabled={busy} onChange={e => void toggle(e.target.checked)}
                    data-testid="company-seal-show" aria-label="견적서에 직인 표시" />
                  견적서에 직인 표시
                </label>
              )}
              {!st.storageReady && <div style={{ fontSize: 11, color: '#b45309' }}>파일 저장소(R2)가 설정되지 않아 직인을 등록할 수 없습니다.</div>}
            </>
          ) : (
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              {st.registered ? (st.showOnQuote ? '등록된 직인이 견적서에 표시됩니다.' : '직인이 등록돼 있으나 견적서에 표시하지 않습니다.') : '등록된 직인이 없습니다.'}
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>직인 등록·교체·삭제는 관리자만 할 수 있습니다.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
