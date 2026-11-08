/**
 * 회사 자료보관함 — 자료 등록(간편 통합 업로드).
 * 직원은 파일(또는 폴더)만 선택하면 등록 완료. 자료 유형·폴더·제목·요약·키워드·보안등급은 AI 가 등록 후 자동 정리한다.
 * 공개 범위·AI 활용·공식 서식/매뉴얼 지정은 관리자 승인 사항(이 화면에서 입력하지 않음).
 */
import React, { useEffect, useRef, useState } from 'react';
import { DOC_TYPE_LABEL, S, badgeStyle, fmtSize, sha256Hex, type ArchiveApi, type ArchiveMe } from './archiveApi';

type St = 'ready' | 'unsupported' | 'toolarge' | 'uploading' | 'analyzing' | 'done' | 'review' | 'failed';
interface Item {
  key: string; file: File; relativePath?: string; status: St; message?: string;
  documentId?: number; duplicates?: Array<{ id: number; title: string; folderPath: string }>;
  result?: { title: string; docType: string; folderPath: string };
}

const ST: Record<St, [string, string]> = {
  ready: ['대기', '#6b7280'], unsupported: ['미지원 형식', '#dc2626'], toolarge: ['용량 초과', '#dc2626'],
  uploading: ['업로드 중', '#2563eb'], analyzing: ['분석 중', '#7c3aed'], done: ['등록 완료', '#059669'],
  review: ['확인 필요', '#d97706'], failed: ['실패', '#dc2626'],
};

/** 드롭된 폴더를 재귀 탐색(상대경로는 AI 참고용으로만 전달 — 폴더를 새로 만들지 않음) */
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

const statusOf = (aiStatus: string): St => aiStatus === 'analyzing' ? 'analyzing' : aiStatus === 'classified' ? 'done' : 'review';

export function ArchiveQuickUpload({ api, me, onDone, setToast }: {
  api: ArchiveApi; me: ArchiveMe; onDone?: () => void; setToast: (m: string) => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [running, setRunning] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const exts = new Set(me.allowedExtensions);
  const patchItem = (key: string, p: Partial<Item>) => setItems(prev => prev.map(x => x.key === key ? { ...x, ...p } : x));

  const addFiles = async (list: Array<{ file: File; relativePath?: string }>) => {
    const next: Item[] = list.map((x, i) => {
      const ext = '.' + (x.file.name.split('.').pop() ?? '').toLowerCase();
      const status: St = !exts.has(ext) ? 'unsupported' : x.file.size > me.maxFileSize ? 'toolarge' : x.file.size === 0 ? 'failed' : 'ready';
      return { key: `${Date.now()}-${i}-${x.file.name}`, file: x.file, relativePath: x.relativePath, status,
        message: status === 'unsupported' ? '지원하지 않는 형식' : status === 'toolarge' ? `최대 ${fmtSize(me.maxFileSize)}` : status === 'failed' ? '빈 파일' : undefined };
    });
    setItems(prev => [...prev, ...next]);
    // 중복 가능성 안내(권한 있는 자료만) — 중복이어도 등록·덮어쓰기·삭제하지 않음
    const hashes = await Promise.all(next.map(it => it.status === 'ready' ? sha256Hex(it.file) : Promise.resolve(null)));
    const valid = hashes.filter((h): h is string => !!h);
    if (!valid.length) return;
    try {
      const dup = await api.post<Record<string, Item['duplicates']>>('/archive/duplicates', { hashes: valid });
      next.forEach((it, i) => { const h = hashes[i]; if (h && dup[h]?.length) patchItem(it.key, { duplicates: dup[h] }); });
    } catch { /* 중복 확인 실패는 등록을 막지 않음 */ }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const entries = [...e.dataTransfer.items].map(i => (i as any).webkitGetAsEntry?.()).filter(Boolean);
    if (entries.some((en: any) => en.isDirectory)) {
      const out: Array<{ file: File; relativePath: string }> = [];
      for (const en of entries) await readEntry(en, '', out);
      addFiles(out);
    } else addFiles([...e.dataTransfer.files].map(file => ({ file })));
  };

  // AI 분석 진행 상태 폴링(분석 중인 파일이 있을 때만)
  const analyzingIds = items.filter(i => i.status === 'analyzing' && i.documentId).map(i => i.documentId!);
  const idsKey = analyzingIds.join(',');
  useEffect(() => {
    if (!idsKey) return;
    let stop = false; let tries = 0;
    const tick = async () => {
      if (stop) return;
      try {
        const rows = await api.post<Array<{ id: number; aiStatus: string; title: string; docType: string; folderPath: string }>>('/archive/ai-status', { ids: idsKey.split(',').map(Number) });
        setItems(prev => prev.map(x => {
          const r = rows.find(row => row.id === x.documentId);
          if (!r || x.status !== 'analyzing') return x;
          const st = statusOf(r.aiStatus);
          return { ...x, status: st, result: { title: r.title, docType: r.docType, folderPath: r.folderPath },
            message: st === 'analyzing' ? undefined : st === 'done' ? undefined : r.aiStatus === 'failed' ? 'AI 분석 실패 — 원본 보존, 관리자 재분석 가능' : '분류 불명확 — 관리자 확인 후 정리' };
        }));
        if (onDone && rows.some(r => r.aiStatus !== 'analyzing')) onDone();
      } catch { /* 일시 오류는 다음 주기에 재시도 */ }
      if (++tries < 90 && !stop) setTimeout(tick, 2000);
    };
    const t = setTimeout(tick, 1500);
    return () => { stop = true; clearTimeout(t); };
  }, [idsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const readyCount = items.filter(i => i.status === 'ready').length;
  const start = async () => {
    if (!readyCount || running) return;
    setRunning(true);
    let ok = 0, failed = 0;
    for (const it of items) {
      if (it.status !== 'ready') continue;
      patchItem(it.key, { status: 'uploading', message: undefined });
      try {
        const name = it.relativePath?.split('/').pop() ?? it.file.name;
        const r = await api.upload<any>('/archive/upload/auto', it.file, name, { relativePath: it.relativePath });
        const st = statusOf(r.data?.aiStatus ?? 'needs_review');
        patchItem(it.key, { status: st, documentId: r.data?.documentId, message: st === 'review' ? '내용 추출 불가 — 원본 보존, 관리자 확인 필요' : undefined });
        ok++;
      } catch (e: any) {
        patchItem(it.key, { status: 'failed', message: e.message }); failed++;
      }
    }
    setRunning(false);
    setToast(`자료 등록: 성공 ${ok}건${failed ? ` · 실패 ${failed}건` : ''} — AI가 자동으로 분류합니다.`);
    if (ok) onDone?.();
  };

  if (!me.canUpload) return <div style={S.card}>자료 등록 권한(archive.upload)이 없습니다. 관리자에게 요청해 주세요.</div>;

  return (
    <div style={{ ...S.card, maxWidth: 820 }} data-testid="archive-quick-upload">
      <h2 style={S.h2}>회사 자료보관함 — 자료 등록</h2>
      <div onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}
        data-testid="archive-upload-dropzone" aria-label="파일 또는 폴더를 끌어다 놓기"
        style={{ border: `2px dashed ${dragOver ? '#2563eb' : '#d1d5db'}`, background: dragOver ? '#eff6ff' : '#f9fafb', borderRadius: 10, padding: 28, textAlign: 'center' }}>
        <div style={{ fontSize: 30 }}>📂</div>
        <div style={{ fontSize: 14, color: '#374151', margin: '6px 0 12px' }}>파일 또는 폴더를 여기에 끌어다 놓으세요.</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button type="button" style={S.btn} onClick={() => fileRef.current?.click()} data-testid="archive-upload-pick-files" aria-label="파일 선택">파일 선택</button>
          <button type="button" style={S.btn} onClick={() => dirRef.current?.click()} data-testid="archive-upload-pick-folder" aria-label="폴더 선택">폴더 선택</button>
        </div>
        <input ref={fileRef} type="file" multiple hidden onChange={e => { addFiles([...(e.target.files ?? [])].map(file => ({ file }))); e.target.value = ''; }} data-testid="archive-upload-input-files" aria-label="파일 입력" />
        <input ref={dirRef} type="file" hidden {...({ webkitdirectory: '', directory: '' } as any)} multiple
          onChange={e => { addFiles([...(e.target.files ?? [])].map(file => ({ file, relativePath: (file as any).webkitRelativePath || undefined }))); e.target.value = ''; }}
          data-testid="archive-upload-input-folder" aria-label="폴더 입력" />
        <div style={{ ...S.muted, marginTop: 10 }}>파일당 최대 {fmtSize(me.maxFileSize)} · 자료 종류·폴더·키워드는 AI가 자동으로 정리합니다.</div>
      </div>

      {items.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0 6px' }}>
            <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>선택한 파일 {items.length}개</span>
            <button type="button" style={S.btn} disabled={running} onClick={() => setItems(prev => prev.filter(i => i.status === 'analyzing'))} data-testid="archive-upload-clear" aria-label="목록 비우기">목록 비우기</button>
          </div>
          <div style={{ maxHeight: 400, overflowY: 'auto', border: '1px solid #eef0f3', borderRadius: 8 }}>
            {items.map(it => (
              <div key={it.key} data-testid={`archive-upload-item-${it.key}`} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 10px', borderBottom: '1px solid #f3f4f6', fontSize: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={it.relativePath ?? it.file.name}>{it.relativePath ?? it.file.name}</div>
                  <div style={S.muted}>
                    {fmtSize(it.file.size)}
                    {it.result && it.status === 'done' ? ` · ${DOC_TYPE_LABEL[it.result.docType] ?? it.result.docType} · ${it.result.folderPath}` : ''}
                    {it.message ? ` · ${it.message}` : ''}
                  </div>
                  {it.duplicates?.length ? <div style={{ color: '#b45309' }}>⚠ 같은 파일이 이미 있습니다: {it.duplicates.map(d => d.title).join(', ')} (기존 자료는 그대로 유지)</div> : null}
                </div>
                <span style={badgeStyle(ST[it.status][1])}>{ST[it.status][0]}</span>
                {!running && (it.status === 'ready' || it.status === 'unsupported' || it.status === 'toolarge') &&
                  <button type="button" style={{ ...S.btn, padding: '1px 6px', fontSize: 11 }} onClick={() => setItems(prev => prev.filter(p => p.key !== it.key))} data-testid={`archive-upload-remove-${it.key}`} aria-label="목록에서 제거">✕</button>}
              </div>
            ))}
          </div>
        </>
      )}
      <button type="button" style={{ ...S.btnPrimary, marginTop: 14, width: '100%', opacity: readyCount && !running ? 1 : 0.5 }} disabled={!readyCount || running} onClick={start}
        data-testid="archive-upload-start" aria-label="자료 등록">
        {running ? '등록 중…' : readyCount ? `자료 등록 (${readyCount}개)` : '자료 등록'}
      </button>
    </div>
  );
}
