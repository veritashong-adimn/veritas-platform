/**
 * 자료 등록·가져오기 — 단일/다중/드래그앤드롭/폴더 단위(하위 구조 유지) 업로드, 중복 사전 확인, 파일별 결과.
 * templateId 지정 시: 표준양식 기반 「작성·발급본」 등록 모드(원본 양식은 변경되지 않음).
 */
import React, { useMemo, useRef, useState } from 'react';
import {
  DOC_TYPE_LABEL, SECURITY_LABEL, S, badgeStyle, fmtSize, sha256Hex, type AclEntry, type ArchiveApi, type ArchiveFolder, type ArchiveMe,
} from './archiveApi';
import { ArchiveAclEditor } from './ArchiveAclEditor';
import { Field } from './ArchiveDocumentDetail';

interface Item { key: string; file: File; relativePath?: string; status: 'ready' | 'unsupported' | 'toolarge' | 'uploading' | 'done' | 'failed' | 'skipped'; message?: string; hash?: string | null; duplicates?: Array<{ id: number; title: string; folderPath: string }>; documentId?: number }

const STATUS_TEXT: Record<Item['status'], [string, string]> = {
  ready: ['대기', '#6b7280'], unsupported: ['미지원 형식', '#dc2626'], toolarge: ['용량 초과', '#dc2626'], uploading: ['업로드 중', '#2563eb'],
  done: ['완료', '#059669'], failed: ['실패', '#dc2626'], skipped: ['건너뜀', '#9ca3af'],
};

/** 드롭된 폴더를 재귀 탐색해 상대경로 유지 */
async function readEntry(entry: any, prefix: string, out: Array<{ file: File; relativePath: string }>) {
  if (entry.isFile) {
    const file: File = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, relativePath: `${prefix}${file.name}` });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch: any[];
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const e of batch) await readEntry(e, `${prefix}${entry.name}/`, out);
    } while (batch.length > 0);
  }
}

/** 업무자료 분류별 기본 자료 유형(사용자가 변경 가능) */
const MENU_DEFAULT_DOCTYPE: Record<string, string> = { manuals: 'manual', contracts: 'contract', records: 'record', hr: 'general', management: 'report' };

export function ArchiveUploadPanel({ api, me, folders, initialFolderId, templateId, menuKey, onDone, setToast }: {
  api: ArchiveApi; me: ArchiveMe; folders: ArchiveFolder[]; initialFolderId?: number | null; templateId?: number | null;
  /** 지정 시 해당 분류(menuKey) 폴더 중 등록 권한이 있는 폴더만 저장 위치로 표시 */
  menuKey?: string | null;
  onDone?: () => void; setToast: (m: string) => void;
}) {
  const uploadable = useMemo(() => folders.filter(f => f.isActive && f.actions.includes('upload') && (!menuKey || f.effectiveMenuKey === menuKey)), [folders, menuKey]);
  const [folderId, setFolderId] = useState<string>(initialFolderId && uploadable.some(f => f.id === initialFolderId) ? String(initialFolderId) : '');
  const [items, setItems] = useState<Item[]>([]);
  const [meta, setMeta] = useState({
    title: '', docType: templateId ? 'form_issued' : (menuKey && MENU_DEFAULT_DOCTYPE[menuKey]) || 'general', description: '', keywords: '', authorName: '', ownerDepartment: me.department ?? '',
    documentDate: '', securityLevel: 'restricted', aiAllowed: false, retentionUntil: '', expiresAt: '', requiresApproval: !!templateId,
    isStandardForm: false, submit: true, visibility: templateId ? 'private' : '', skipDuplicates: false,
  });
  const [acl, setAcl] = useState<AclEntry[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [running, setRunning] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const setM = (k: keyof typeof meta, v: any) => setMeta(m => ({ ...m, [k]: v }));
  const exts = new Set(me.allowedExtensions);

  const addFiles = async (list: Array<{ file: File; relativePath?: string }>) => {
    const next: Item[] = list.map((x, i) => {
      const ext = '.' + (x.file.name.split('.').pop() ?? '').toLowerCase();
      const status: Item['status'] = !exts.has(ext) ? 'unsupported' : x.file.size > me.maxFileSize ? 'toolarge' : 'ready';
      return { key: `${Date.now()}-${i}-${x.file.name}`, file: x.file, relativePath: x.relativePath, status,
        message: status === 'unsupported' ? `지원 형식: ${me.allowedExtensions.join(' ')}` : status === 'toolarge' ? `최대 ${fmtSize(me.maxFileSize)}` : undefined };
    });
    setItems(prev => templateId ? next.slice(0, 1) : [...prev, ...next]);
    // 중복 사전 확인(해시) — 권한 있는 자료만 안내, 자동 삭제 없음
    const hashes = await Promise.all(next.map(it => it.status === 'ready' ? sha256Hex(it.file) : Promise.resolve(null)));
    next.forEach((it, i) => { it.hash = hashes[i]; });
    const valid = hashes.filter((h): h is string => !!h);
    if (valid.length) {
      try {
        const dup = await api.post<Record<string, Item['duplicates']>>('/archive/duplicates', { hashes: valid });
        setItems(prev => prev.map(p => { const n = next.find(x => x.key === p.key); return n?.hash && dup[n.hash] ? { ...p, hash: n.hash, duplicates: dup[n.hash] } : n ? { ...p, hash: n.hash } : p; }));
      } catch { /* 중복 확인 실패는 업로드를 막지 않음 */ }
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const entries = [...e.dataTransfer.items].map(i => (i as any).webkitGetAsEntry?.()).filter(Boolean);
    if (entries.length && entries.some((en: any) => en.isDirectory)) {
      const out: Array<{ file: File; relativePath: string }> = [];
      for (const en of entries) await readEntry(en, '', out);
      addFiles(out.map(o => ({ file: o.file, relativePath: o.relativePath.includes('/') ? o.relativePath : undefined })));
    } else {
      addFiles([...e.dataTransfer.files].map(file => ({ file })));
    }
  };

  const readyCount = items.filter(i => i.status === 'ready').length;
  const canStart = !!folderId && !!meta.visibility && readyCount > 0 && !running;

  const start = async () => {
    if (!canStart) return;
    setRunning(true);
    let ok = 0, failed = 0, skipped = 0;
    for (const it of items) {
      if (it.status !== 'ready') continue;
      if (meta.skipDuplicates && it.duplicates?.length) {
        setItems(prev => prev.map(p => p.key === it.key ? { ...p, status: 'skipped', message: '중복 파일 건너뜀' } : p)); skipped++; continue;
      }
      setItems(prev => prev.map(p => p.key === it.key ? { ...p, status: 'uploading' } : p));
      const body: Record<string, unknown> = {
        ...meta, folderId: Number(folderId), relativePath: it.relativePath,
        title: items.length === 1 && meta.title.trim() ? meta.title.trim() : undefined,
        documentDate: meta.documentDate || null, retentionUntil: meta.retentionUntil || null, expiresAt: meta.expiresAt || null,
        acl: meta.visibility === 'custom' ? acl : undefined,
      };
      try {
        const path = templateId ? `/archive/documents/${templateId}/issue` : '/archive/upload';
        const r = await api.upload<any>(path, it.file, it.relativePath?.split('/').pop() ?? it.file.name, body);
        const msg = r.data?.approvalId ? '등록 완료 · 승인 대기' : r.data?.status === 'draft' ? '초안 저장' : '등록 완료';
        setItems(prev => prev.map(p => p.key === it.key ? { ...p, status: 'done', documentId: r.data?.documentId, message: msg } : p)); ok++;
      } catch (e: any) {
        setItems(prev => prev.map(p => p.key === it.key ? { ...p, status: 'failed', message: e.message } : p)); failed++;
      }
    }
    setRunning(false);
    setToast(`등록 결과: 성공 ${ok}건 · 실패 ${failed}건${skipped ? ` · 건너뜀 ${skipped}건` : ''}`);
    if (ok) onDone?.();
  };

  if (!me.canUpload) return <div style={S.card}>자료 등록 권한(archive.upload)이 없습니다. 관리자에게 요청해 주세요.</div>;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 1fr) minmax(360px, 1.2fr)', gap: 16, alignItems: 'start' }}>
      <div style={S.card}>
        <h2 style={S.h2}>{templateId ? '양식 기반 작성·발급본 등록' : '등록 정보'}</h2>
        {templateId && <div style={{ ...S.muted, marginBottom: 8 }}>원본 표준양식은 변경되지 않으며, 작성본은 별도 자료로 등록됩니다. 증명서·계약서 등은 기본적으로 승인 후 확정됩니다.</div>}
        <div style={{ display: 'grid', gap: 8 }}>
          <Field label="저장 폴더 *">
            <select style={S.input} value={folderId} onChange={e => setFolderId(e.target.value)} aria-label="저장 폴더" data-testid="archive-upload-folder">
              <option value="">폴더 선택</option>
              {uploadable.map(f => <option key={f.id} value={f.id}>{f.path}</option>)}
            </select>
          </Field>
          {uploadable.length === 0 && <div style={{ ...S.muted, color: '#b45309' }}>등록 권한이 있는 폴더가 없습니다. 자료 관리설정에서 폴더 권한(등록)을 부여받아야 합니다.</div>}
          {(items.length <= 1) && <Field label="자료명(비우면 파일명)"><input style={S.input} value={meta.title} onChange={e => setM('title', e.target.value)} aria-label="자료명" data-testid="archive-upload-title" /></Field>}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {!templateId && (
              <Field label="자료 유형">
                <select style={S.input} value={meta.docType} onChange={e => setM('docType', e.target.value)} aria-label="자료 유형" data-testid="archive-upload-doctype">
                  {Object.entries(DOC_TYPE_LABEL).filter(([k]) => k !== 'form_issued').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
            )}
            <Field label="보안등급">
              <select style={S.input} value={meta.securityLevel} onChange={e => setM('securityLevel', e.target.value)} aria-label="보안등급" data-testid="archive-upload-security">
                {Object.entries(SECURITY_LABEL).filter(([k]) => k !== 'secret' || me.isArchiveAdmin).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="작성자"><input style={S.input} value={meta.authorName} onChange={e => setM('authorName', e.target.value)} aria-label="작성자" data-testid="archive-upload-author" /></Field>
            <Field label="관리부서"><input style={S.input} value={meta.ownerDepartment} onChange={e => setM('ownerDepartment', e.target.value)} aria-label="관리부서" data-testid="archive-upload-dept" /></Field>
            <Field label="작성일"><input type="date" style={S.input} value={meta.documentDate} onChange={e => setM('documentDate', e.target.value)} aria-label="작성일" data-testid="archive-upload-docdate" /></Field>
            <Field label="보존기한"><input type="date" style={S.input} value={meta.retentionUntil} onChange={e => setM('retentionUntil', e.target.value)} aria-label="보존기한" data-testid="archive-upload-retention" /></Field>
            <Field label="만료일(계약 등)"><input type="date" style={S.input} value={meta.expiresAt} onChange={e => setM('expiresAt', e.target.value)} aria-label="만료일" data-testid="archive-upload-expires" /></Field>
          </div>
          <Field label="설명"><textarea style={{ ...S.input, minHeight: 50 }} value={meta.description} onChange={e => setM('description', e.target.value)} aria-label="설명" data-testid="archive-upload-description" /></Field>
          <Field label="키워드(쉼표 구분)"><input style={S.input} value={meta.keywords} onChange={e => setM('keywords', e.target.value)} aria-label="키워드" data-testid="archive-upload-keywords" /></Field>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13 }}>
            <label><input type="checkbox" checked={meta.aiAllowed} onChange={e => setM('aiAllowed', e.target.checked)} aria-label="AI 활용 허용" data-testid="archive-upload-ai" /> AI 활용 허용</label>
            <label><input type="checkbox" checked={meta.requiresApproval} onChange={e => setM('requiresApproval', e.target.checked)} aria-label="승인 필요" data-testid="archive-upload-approval" /> 승인 필요</label>
            {!templateId && <label><input type="checkbox" checked={meta.isStandardForm} onChange={e => setM('isStandardForm', e.target.checked)} aria-label="표준양식 지정" data-testid="archive-upload-standard" /> 표준양식 지정(승인 필수)</label>}
            {(meta.requiresApproval || meta.isStandardForm) && <label><input type="checkbox" checked={meta.submit} onChange={e => setM('submit', e.target.checked)} aria-label="바로 검토 요청" data-testid="archive-upload-submit" /> 등록과 동시에 검토 요청</label>}
          </div>
          <Field label="공개 범위 *(기본 비공개 정책 — 명시적으로 선택)">
            <select style={S.input} value={meta.visibility} onChange={e => setM('visibility', e.target.value)} aria-label="공개 범위" data-testid="archive-upload-visibility">
              <option value="">선택</option>
              <option value="inherit">폴더 권한 따름(상속)</option>
              <option value="private">비공개(등록자·관리자만)</option>
              <option value="custom">직접 지정(상속 해제)</option>
            </select>
          </Field>
          {meta.visibility === 'custom' && <ArchiveAclEditor api={api} entries={acl} onChange={setAcl} testIdPrefix="archive-upload-acl" />}
        </div>
      </div>

      <div style={S.card}>
        <h2 style={S.h2}>파일 선택</h2>
        <div onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}
          data-testid="archive-upload-dropzone" aria-label="파일 또는 폴더를 끌어다 놓기"
          style={{ border: `2px dashed ${dragOver ? '#2563eb' : '#d1d5db'}`, background: dragOver ? '#eff6ff' : '#f9fafb', borderRadius: 10, padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 28 }}>📂</div>
          <div style={{ fontSize: 13, color: '#374151', margin: '6px 0 10px' }}>파일{templateId ? '' : ' 또는 폴더'}를 여기에 끌어다 놓으세요</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button type="button" style={S.btn} onClick={() => fileRef.current?.click()} data-testid="archive-upload-pick-files" aria-label="파일 선택">파일 선택</button>
            {!templateId && <button type="button" style={S.btn} onClick={() => dirRef.current?.click()} data-testid="archive-upload-pick-folder" aria-label="폴더 선택">폴더 선택(하위 구조 유지)</button>}
          </div>
          <input ref={fileRef} type="file" multiple={!templateId} hidden onChange={e => { addFiles([...(e.target.files ?? [])].map(file => ({ file }))); e.target.value = ''; }} data-testid="archive-upload-input-files" aria-label="파일 입력" />
          <input ref={dirRef} type="file" hidden {...({ webkitdirectory: '', directory: '' } as any)} multiple
            onChange={e => { addFiles([...(e.target.files ?? [])].map(file => ({ file, relativePath: (file as any).webkitRelativePath || undefined }))); e.target.value = ''; }}
            data-testid="archive-upload-input-folder" aria-label="폴더 입력" />
          <div style={{ ...S.muted, marginTop: 10 }}>파일당 최대 {fmtSize(me.maxFileSize)} · 지원: {me.allowedExtensions.join(' ')}</div>
        </div>

        {items.length > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '12px 0 6px' }}>
              <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{items.length}개 파일 · 등록 가능 {readyCount}개</span>
              {items.some(i => i.duplicates?.length) && (
                <label style={{ fontSize: 12 }}><input type="checkbox" checked={meta.skipDuplicates} onChange={e => setM('skipDuplicates', e.target.checked)} aria-label="중복 파일 건너뛰기" data-testid="archive-upload-skip-dup" /> 중복 파일 건너뛰기</label>
              )}
              <button type="button" style={S.btn} disabled={running} onClick={() => setItems([])} data-testid="archive-upload-clear" aria-label="목록 비우기">비우기</button>
            </div>
            <div style={{ maxHeight: 380, overflowY: 'auto', border: '1px solid #eef0f3', borderRadius: 8 }}>
              {items.map(it => (
                <div key={it.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '7px 10px', borderBottom: '1px solid #f3f4f6', fontSize: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.relativePath ?? it.file.name}</div>
                    <div style={S.muted}>{fmtSize(it.file.size)}{it.message ? ` · ${it.message}` : ''}</div>
                    {it.duplicates?.length ? <div style={{ color: '#b45309' }}>⚠ 동일 파일 존재: {it.duplicates.map(d => `${d.title}(${d.folderPath})`).join(', ')}</div> : null}
                  </div>
                  <span style={badgeStyle(STATUS_TEXT[it.status][1])}>{STATUS_TEXT[it.status][0]}</span>
                  {!running && it.status !== 'done' && <button type="button" style={{ ...S.btn, padding: '1px 6px', fontSize: 11 }} onClick={() => setItems(prev => prev.filter(p => p.key !== it.key))} data-testid={`archive-upload-remove-${it.key}`} aria-label="목록에서 제거">✕</button>}
                </div>
              ))}
            </div>
          </>
        )}
        <button type="button" style={{ ...S.btnPrimary, marginTop: 12, width: '100%', opacity: canStart ? 1 : 0.5 }} disabled={!canStart} onClick={start}
          data-testid="archive-upload-start" aria-label="등록 시작">
          {running ? '등록 중…' : `${readyCount}개 파일 등록`}
        </button>
        {!meta.visibility && items.length > 0 && <div style={{ ...S.muted, color: '#b45309', marginTop: 6 }}>공개 범위를 선택해 주세요.</div>}
      </div>
    </div>
  );
}
