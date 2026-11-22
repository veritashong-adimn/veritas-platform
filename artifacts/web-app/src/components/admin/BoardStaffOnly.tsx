// ─── 게시판 직원전용 자료(2026-11-22) — 대상 직원 선택 · 복수 첨부 · 다운로드 공통 ─────────────────
//  · 대상 직원: 기존 직원 명부(활성 admin·staff 계정, /api/admin/board/staff-directory)에서 검색·선택(직접 입력 없음).
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
export function StaffTargetPicker({ token, value, onChange }: { token: string; value: number[]; onChange: (ids: number[]) => void }) {
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
  const byId = useMemo(() => new Map(all.map(m => [m.id, m])), [all]);
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

/** 첨부 파일 선택(복수) — 선택 목록 표시·개별 제외 */
export function BoardFilePicker({ files, onChange, testId = 'board-file-input' }: { files: File[]; onChange: (f: File[]) => void; testId?: string }) {
  return (
    <div>
      <input type="file" multiple data-testid={testId} aria-label="첨부파일 선택"
        onChange={e => { const add = Array.from(e.target.files ?? []); e.target.value = ''; onChange([...files, ...add].slice(0, BOARD_MAX_FILES)); }}
        style={{ fontSize: 12 }} />
      <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 6 }}>최대 {BOARD_MAX_FILES}개 · 파일당 {MAX_MB}MB</span>
      {files.length > 0 && (
        <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none' }}>
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} style={{ fontSize: 12, color: '#374151', display: 'flex', gap: 6, alignItems: 'center' }}>
              📎 {f.name} <span style={{ color: '#9ca3af' }}>{fmtSize(f.size)}</span>
              <button type="button" onClick={() => onChange(files.filter((_, j) => j !== i))} aria-label={`${f.name} 첨부 제외`} data-testid={`board-file-remove-${i}`}
                style={{ border: 'none', background: 'transparent', color: '#dc2626', cursor: 'pointer', fontSize: 12 }}>제외</button>
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
