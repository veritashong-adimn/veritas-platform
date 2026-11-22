// ─── 게시판 직원전용 자료(2026-11-22) — 대상 직원 선택 · 복수 첨부 · 다운로드 공통 ─────────────────
//  · 대상 직원: 기존 직원 명부(role=staff 활성 계정 — 관리자·게스트 제외, /api/admin/board/staff-directory)에서 검색·선택(직접 입력 없음).
//    수정 시 이미 지정된 대상(명부 밖 계정 포함)은 그대로 표시·유지한다(known).
//  · 첨부: 게시글 저장 후 /api/admin/board/:id/files 로 업로드(관리자만). 다운로드는 권한 확인 API 로만.
//  · 권한 판정은 서버가 한다(이 화면은 표시만).
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/constants';

export type StaffMember = { id: number; name: string | null; email: string; role: string };
export const BOARD_MAX_FILES = 10;
const MAX_MB = 50;

const chip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 12, background: '#eef2ff', color: '#3730a3', fontSize: 12, fontWeight: 600 };
const box: React.CSSProperties = { width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db' };

export const staffLabel = (m: { name: string | null; email: string }) => (m.name?.trim() ? `${m.name} (${m.email})` : m.email);
export const fmtSize = (n: number | null | undefined) => (n == null ? '' : n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

/** 대상 직원 검색·선택(직원 명부) */
export function StaffTargetPicker({ token, value, onChange, known = [] }: {
  token: string; value: number[]; onChange: (ids: number[]) => void;
  known?: { id: number; name: string | null; email: string }[];   // 기존 대상(명부에 없을 수 있음) 표시용
}) {
  const [all, setAll] = useState<StaffMember[]>([]);
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(api('/api/admin/board/staff-directory'), { headers: { Authorization: `Bearer ${token}` } })
      .then(async r => { const d = await r.json().catch(() => null); if (!alive) return; if (r.ok && Array.isArray(d)) setAll(d); else setErr(d?.error ?? '직원 명부를 불러오지 못했습니다.'); })
      .catch(() => { if (alive) setErr('직원 명부를 불러오지 못했습니다.'); });
    return () => { alive = false; };
  }, [token]);
  const byId = useMemo(() => new Map<number, { name: string | null; email: string }>([...known.map(k => [k.id, k] as const), ...all.map(m => [m.id, m] as const)]), [all, known]);
  const term = q.trim().toLowerCase();
  const hits = all.filter(m => !value.includes(m.id) && (!term || `${m.name ?? ''} ${m.email}`.toLowerCase().includes(term))).slice(0, 8);
  return (
    <div data-testid="board-staff-picker">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: value.length ? 6 : 0 }}>
        {value.map(id => {
          const m = byId.get(id);
          return (
            <span key={id} style={chip} data-testid={`board-target-chip-${id}`}>
              {m ? staffLabel(m) : `#${id}`}
              <button type="button" onClick={() => onChange(value.filter(x => x !== id))} aria-label={`${m?.name ?? id} 대상에서 제외`}
                data-testid={`board-target-remove-${id}`} style={{ border: 'none', background: 'transparent', color: '#6366f1', cursor: 'pointer', fontSize: 13, padding: 0 }}>×</button>
            </span>
          );
        })}
      </div>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="직원 이름·이메일 검색" style={box}
        data-testid="board-target-search" aria-label="대상 직원 검색" />
      {err && <div role="alert" style={{ color: '#b91c1c', fontSize: 12, marginTop: 4 }}>{err}</div>}
      {hits.length > 0 && (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, marginTop: 4, maxHeight: 200, overflowY: 'auto', background: '#fff' }}>
          {hits.map(m => (
            <button type="button" key={m.id} onClick={() => { onChange([...value, m.id]); setQ(''); }}
              data-testid={`board-target-option-${m.id}`} aria-label={`${m.name ?? m.email} 대상으로 선택`}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', border: 'none', borderBottom: '1px solid #f3f4f6', background: '#fff', cursor: 'pointer', fontSize: 13 }}>
              {staffLabel(m)} <span style={{ color: '#9ca3af', fontSize: 11 }}>{m.role === 'admin' ? '관리자' : '직원'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 첨부 파일 선택(복수) — 파일 선택 버튼 + 드래그 앤 드롭 영역 · 선택 목록·개별 제외.
 *  제한(서버와 동일): 최대 10개 · 파일당 50MB — 넘는 파일은 담지 않고 안내만 한다. 업로드는 uploadBoardFiles(기존 R2 경로). */
export function BoardFilePicker({ files, onChange, testId = 'board-file-input' }: { files: File[]; onChange: (f: File[]) => void; testId?: string }) {
  const [over, setOver] = useState(false);
  const [warn, setWarn] = useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const add = (incoming: File[]) => {
    if (!incoming.length) return;
    const big = incoming.filter(f => f.size > MAX_MB * 1024 * 1024);
    const ok = incoming.filter(f => f.size <= MAX_MB * 1024 * 1024);
    const room = Math.max(0, BOARD_MAX_FILES - files.length);
    const msgs: string[] = [];
    if (big.length) msgs.push(`${MAX_MB}MB 초과 ${big.length}개 제외(${big.map(f => f.name).slice(0, 3).join(', ')})`);
    if (ok.length > room) msgs.push(`최대 ${BOARD_MAX_FILES}개까지 — ${ok.length - room}개 제외`);
    setWarn(msgs.length ? msgs.join(' · ') : null);
    if (room > 0 && ok.length) onChange([...files, ...ok.slice(0, room)]);
  };
  return (
    <div>
      <div data-testid={`${testId}-dropzone`} aria-label="첨부파일 끌어다 놓기 영역" role="button" tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
        onDragEnter={e => { e.preventDefault(); setOver(true); }}
        onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true); }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
        onDrop={e => { e.preventDefault(); setOver(false); add(Array.from(e.dataTransfer.files ?? [])); }}
        style={{ border: `2px dashed ${over ? '#6366f1' : '#d1d5db'}`, background: over ? '#eef2ff' : '#f9fafb', borderRadius: 10,
          padding: '14px 12px', textAlign: 'center', fontSize: 12.5, color: over ? '#4338ca' : '#6b7280', cursor: 'pointer', marginBottom: 6 }}>
        {over ? '여기에 놓으면 첨부됩니다' : '파일을 끌어다 놓거나 클릭해 선택하세요'}
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>여러 파일 동시 첨부 · 최대 {BOARD_MAX_FILES}개 · 파일당 {MAX_MB}MB</div>
      </div>
      <input ref={inputRef} type="file" multiple data-testid={testId} aria-label="첨부파일 선택"
        onChange={e => { const sel = Array.from(e.target.files ?? []); e.target.value = ''; add(sel); }}
        style={{ fontSize: 12 }} />
      {warn && <div role="alert" data-testid={`${testId}-warn`} style={{ color: '#b45309', fontSize: 12, marginTop: 4 }}>{warn}</div>}
      {files.length > 0 && (
        <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none' }} data-testid={`${testId}-list`}>
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} style={{ fontSize: 12, color: '#374151', display: 'flex', gap: 6, alignItems: 'center' }}>
              📎 {f.name} <span style={{ color: '#9ca3af' }}>{fmtSize(f.size)}</span>
              <button type="button" onClick={() => { onChange(files.filter((_, j) => j !== i)); setWarn(null); }} aria-label={`${f.name} 첨부 삭제`} data-testid={`board-file-remove-${i}`}
                style={{ border: 'none', background: 'transparent', color: '#dc2626', cursor: 'pointer', fontSize: 12 }}>삭제</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 게시글에 파일 업로드(관리자) — 실패 시 오류 문구 반환 */
export async function uploadBoardFiles(token: string, postId: number, files: File[]): Promise<string | null> {
  if (!files.length) return null;
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);
  fd.append('fileNames', JSON.stringify(files.map(f => f.name)));
  const r = await fetch(api(`/api/admin/board/${postId}/files`), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  if (r.ok) return null;
  const d = await r.json().catch(() => ({}));
  return d.error ?? `첨부파일 업로드 실패(${r.status})`;
}

/** 권한 확인 다운로드(토큰을 URL 에 싣지 않음) */
export async function downloadBoardFile(token: string, postId: number, file: { id: number; originalFileName: string }): Promise<string | null> {
  const r = await fetch(api(`/api/admin/board/${postId}/files/${file.id}/download`), { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) { const d = await r.json().catch(() => ({})); return d.error ?? `다운로드 실패(${r.status})`; }
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a'); a.href = url; a.download = file.originalFileName; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return null;
}
