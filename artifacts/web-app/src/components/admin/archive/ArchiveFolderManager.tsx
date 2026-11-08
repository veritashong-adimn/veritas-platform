/**
 * 폴더 관리(관리자·폴더 관리권자 전용) — '전체 자료' 폴더 탐색과 '자료 관리설정 › 분류·폴더·권한'이 공용으로 사용.
 * 두 화면 모두 동일한 서버 API(/archive/folders…)와 ArchiveModule 의 단일 folders 상태를 쓰므로 한쪽 변경이 즉시 양쪽에 반영된다.
 *  · 메뉴: 하위 폴더 추가 / 이름 변경 / 다른 폴더로 이동 / 위로·아래로 / 비활성화 / 삭제(관리자)
 *  · 삭제는 소프트 삭제 — 하위 폴더·자료·휴지통 자료가 있으면 서버가 차단하고 영향 범위를 안내
 *  · 삭제된 폴더 복원(관리자) — 원래 위치·이름 충돌 시 관리자가 위치·이름을 직접 지정
 * 권한은 서버가 재검증한다(화면 숨김과 별개).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { S, fmtDateTime, type ArchiveApi, type ArchiveFolder, type ArchiveMe } from './archiveApi';
import { Modal } from './ArchiveDocumentDetail';

type DeleteImpact = {
  path: string; childFolderCount: number; childFolders: string[]; documentCount: number; trashedDocumentCount: number;
  aclCount: number; canDelete: boolean; reasons: string[];
};
type DeletedFolder = {
  id: number; name: string; parentId: number | null; originalPath: string; deletedAt: string;
  deletedByName: string | null; deletedByEmail: string | null; parentAvailable: boolean; nameConflict: boolean;
};
type Dialog =
  | { kind: 'create'; parentId: number | null }
  | { kind: 'rename'; folder: ArchiveFolder }
  | { kind: 'move'; folder: ArchiveFolder }
  | { kind: 'delete'; folder: ArchiveFolder }
  | { kind: 'trash' };

export function useArchiveFolderManager({ api, me, folders, reload, setToast, idPrefix }: {
  api: ArchiveApi; me: ArchiveMe; folders: ArchiveFolder[]; reload: () => Promise<void>; setToast: (m: string) => void; idPrefix: string;
}) {
  const canManage = useCallback((f: ArchiveFolder) => me.isArchiveAdmin || f.actions.includes('manage'), [me.isArchiveAdmin]);
  const enabled = me.isArchiveAdmin || folders.some(canManage);
  const [menu, setMenu] = useState<{ folder: ArchiveFolder; x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', esc);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', esc); window.removeEventListener('scroll', close, true); };
  }, [menu]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); setToast(ok); await reload(); return true; }
    catch (e: any) { setToast(e.message); return false; }
  };

  const openMenu = (f: ArchiveFolder, x: number, y: number) => setMenu({ folder: f, x: Math.min(x, window.innerWidth - 200), y: Math.min(y, window.innerHeight - 280) });

  const rowExtra = (f: ArchiveFolder) => !canManage(f) ? null : (
    <button type="button" aria-label={`폴더 ${f.name} 관리 메뉴`} data-testid={`${idPrefix}-menu-${f.id}`} title="폴더 관리"
      onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); openMenu(f, r.left, r.bottom + 2); }}
      style={{ border: 0, background: 'none', cursor: 'pointer', color: '#6b7280', padding: '0 4px', fontSize: 14, lineHeight: 1 }}>⋯</button>
  );
  const onRowContextMenu = (f: ArchiveFolder, e: React.MouseEvent) => {
    if (!canManage(f)) return;
    e.preventDefault();
    openMenu(f, e.clientX, e.clientY);
  };

  const siblings = (f: ArchiveFolder) => folders.filter(x => (x.parentId ?? null) === (f.parentId ?? null))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  const menuEl = menu && (() => {
    const f = menu.folder;
    const sib = siblings(f);
    const idx = sib.findIndex(x => x.id === f.id);
    const item = (key: string, label: string, onClick: () => void, opts: { disabled?: boolean; danger?: boolean } = {}) => (
      <button key={key} type="button" role="menuitem" disabled={opts.disabled} data-testid={`${idPrefix}-menu-${key}`} aria-label={`${f.name} ${label}`}
        onClick={(e) => { e.stopPropagation(); setMenu(null); onClick(); }}
        style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 12px', border: 0, background: 'none', fontSize: 13,
          cursor: opts.disabled ? 'default' : 'pointer', color: opts.disabled ? '#d1d5db' : opts.danger ? '#dc2626' : '#374151' }}>{label}</button>
    );
    return (
      <div role="menu" aria-label={`${f.name} 폴더 관리`} data-testid={`${idPrefix}-menu`} onClick={e => e.stopPropagation()}
        style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 1100, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', minWidth: 180, padding: '4px 0' }}>
        <div style={{ padding: '4px 12px 6px', fontSize: 11, color: '#9ca3af', borderBottom: '1px solid #f3f4f6', marginBottom: 2 }}>📁 {f.name}</div>
        {item('add-child', '하위 폴더 추가', () => setDialog({ kind: 'create', parentId: f.id }))}
        {item('rename', '이름 변경', () => setDialog({ kind: 'rename', folder: f }))}
        {item('move', '다른 폴더로 이동', () => setDialog({ kind: 'move', folder: f }))}
        {item('up', '위로 이동', () => run(() => api.post(`/archive/folders/${f.id}/reorder`, { direction: 'up' }), '순서를 변경했습니다.'), { disabled: idx <= 0 })}
        {item('down', '아래로 이동', () => run(() => api.post(`/archive/folders/${f.id}/reorder`, { direction: 'down' }), '순서를 변경했습니다.'), { disabled: idx < 0 || idx >= sib.length - 1 })}
        {item('toggle-active', f.isActive ? '비활성화' : '활성화', () => run(() => api.patch(`/archive/folders/${f.id}`, { isActive: !f.isActive }), f.isActive ? '비활성화했습니다(자료는 보존).' : '활성화했습니다.'))}
        {me.isArchiveAdmin && item('delete', '삭제', () => setDialog({ kind: 'delete', folder: f }), { danger: true })}
      </div>
    );
  })();

  const toolbar = enabled && (me.isArchiveAdmin ? (
    <div style={{ display: 'flex', gap: 4, padding: '0 4px 6px' }}>
      <button type="button" style={{ ...S.btn, padding: '4px 8px', fontSize: 12, flex: 1 }} onClick={() => setDialog({ kind: 'create', parentId: null })}
        data-testid={`${idPrefix}-add-root`} aria-label="최상위 폴더 추가">+ 폴더 추가</button>
      <button type="button" style={{ ...S.btn, padding: '4px 8px', fontSize: 12 }} onClick={() => setDialog({ kind: 'trash' })}
        data-testid={`${idPrefix}-trash`} aria-label="삭제된 폴더 보기·복원" title="삭제된 폴더 복원">🗑️</button>
    </div>
  ) : null);

  const close = () => setDialog(null);
  const dialogEl = dialog && (
    dialog.kind === 'create' ? <NameDialog title={dialog.parentId == null ? '최상위 폴더 추가' : `하위 폴더 추가 · ${folders.find(x => x.id === dialog.parentId)?.path ?? ''}`}
      initial="" submitLabel="추가" idPrefix={`${idPrefix}-create`} onClose={close}
      onSubmit={(name) => run(() => api.post('/archive/folders', { parentId: dialog.parentId, name }), '폴더를 추가했습니다.')} />
    : dialog.kind === 'rename' ? <NameDialog title={`이름 변경 · ${dialog.folder.path}`} initial={dialog.folder.name} submitLabel="변경" idPrefix={`${idPrefix}-rename`} onClose={close}
      onSubmit={(name) => run(() => api.patch(`/archive/folders/${dialog.folder.id}`, { name }), '이름을 변경했습니다. 문서 연결은 그대로 유지됩니다.')} />
    : dialog.kind === 'move' ? <MoveDialog folder={dialog.folder} folders={folders} me={me} idPrefix={`${idPrefix}-move`} onClose={close}
      onSubmit={(parentId) => run(() => api.patch(`/archive/folders/${dialog.folder.id}`, { parentId }), '폴더를 이동했습니다. 하위 폴더·자료도 함께 이동됩니다.')} />
    : dialog.kind === 'delete' ? <DeleteDialog api={api} folder={dialog.folder} idPrefix={`${idPrefix}-delete`} onClose={close}
      onSubmit={() => run(() => api.del(`/archive/folders/${dialog.folder.id}`), '폴더를 삭제했습니다(🗑️ 삭제된 폴더에서 복원 가능).')} />
    : <TrashDialog api={api} folders={folders} idPrefix={`${idPrefix}-trash`} onClose={close} reload={reload} setToast={setToast} />
  );

  const overlay = <>{menuEl}{dialogEl}</>;
  return { enabled, rowExtra, onRowContextMenu, toolbar, overlay };
}

function NameDialog({ title, initial, submitLabel, idPrefix, onClose, onSubmit }: {
  title: string; initial: string; submitLabel: string; idPrefix: string; onClose: () => void; onSubmit: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const submit = async () => { if (!name.trim() || busy) return; setBusy(true); if (await onSubmit(name.trim())) onClose(); else setBusy(false); };
  return (
    <Modal title={title} onClose={onClose}>
      <input style={S.input} value={name} autoFocus maxLength={200} placeholder="폴더명" onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit(); }} aria-label="폴더명" data-testid={`${idPrefix}-name`} />
      <div style={{ ...S.muted, marginTop: 6 }}>같은 상위 폴더 안에서는 동일한 이름을 사용할 수 없습니다.</div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 12 }}>
        <button type="button" style={S.btn} onClick={onClose} data-testid={`${idPrefix}-cancel`} aria-label="취소">취소</button>
        <button type="button" style={S.btnPrimary} disabled={!name.trim() || busy || name.trim() === initial} onClick={submit} data-testid={`${idPrefix}-submit`} aria-label={submitLabel}>{submitLabel}</button>
      </div>
    </Modal>
  );
}

function descendantIds(folders: ArchiveFolder[], rootId: number) {
  const out = new Set<number>([rootId]);
  let grew = true;
  while (grew) { grew = false; for (const f of folders) if (f.parentId != null && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true; } }
  return out;
}

function ParentSelect({ folders, exclude, value, onChange, allowRoot, idPrefix }: {
  folders: ArchiveFolder[]; exclude: Set<number>; value: string; onChange: (v: string) => void; allowRoot: boolean; idPrefix: string;
}) {
  const options = useMemo(() => folders.filter(f => !exclude.has(f.id)).sort((a, b) => a.path.localeCompare(b.path, 'ko')), [folders, exclude]);
  return (
    <select style={S.input} value={value} onChange={e => onChange(e.target.value)} aria-label="대상 상위 폴더" data-testid={`${idPrefix}-parent`}>
      <option value="" disabled>대상 위치 선택</option>
      {allowRoot && <option value="root">(최상위)</option>}
      {options.map(f => <option key={f.id} value={f.id}>{f.path}{!f.isActive ? ' (비활성)' : ''}</option>)}
    </select>
  );
}

function MoveDialog({ folder, folders, me, idPrefix, onClose, onSubmit }: {
  folder: ArchiveFolder; folders: ArchiveFolder[]; me: ArchiveMe; idPrefix: string; onClose: () => void; onSubmit: (parentId: number | null) => Promise<boolean>;
}) {
  const exclude = useMemo(() => descendantIds(folders, folder.id), [folders, folder.id]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const current = folder.parentId == null ? 'root' : String(folder.parentId);
  return (
    <Modal title={`다른 폴더로 이동 · ${folder.path}`} onClose={onClose}>
      <ParentSelect folders={folders} exclude={exclude} value={target} onChange={setTarget} allowRoot={me.isArchiveAdmin} idPrefix={idPrefix} />
      <div style={{ ...S.muted, marginTop: 6 }}>자기 자신과 하위 폴더로는 이동할 수 없습니다. 하위 폴더와 소속 자료는 함께 이동하며, 문서 원본·이력·권한은 변경되지 않습니다.</div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 12 }}>
        <button type="button" style={S.btn} onClick={onClose} data-testid={`${idPrefix}-cancel`} aria-label="취소">취소</button>
        <button type="button" style={S.btnPrimary} disabled={!target || target === current || busy} data-testid={`${idPrefix}-submit`} aria-label="이동"
          onClick={async () => { setBusy(true); if (await onSubmit(target === 'root' ? null : Number(target))) onClose(); else setBusy(false); }}>이동</button>
      </div>
    </Modal>
  );
}

function DeleteDialog({ api, folder, idPrefix, onClose, onSubmit }: {
  api: ArchiveApi; folder: ArchiveFolder; idPrefix: string; onClose: () => void; onSubmit: () => Promise<boolean>;
}) {
  const [impact, setImpact] = useState<DeleteImpact | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get<DeleteImpact>(`/archive/folders/${folder.id}/delete-check`).then(setImpact).catch(e => setError(e.message)); }, [api, folder.id]);
  return (
    <Modal title={`폴더 삭제 · ${folder.path}`} onClose={onClose}>
      {error && <div style={{ color: '#b91c1c', fontSize: 13 }}>{error}</div>}
      {!impact && !error && <div style={S.muted}>영향 범위를 확인하는 중…</div>}
      {impact && (
        <div data-testid={`${idPrefix}-impact`} style={{ fontSize: 13 }}>
          <table style={{ borderCollapse: 'collapse', marginBottom: 10 }}>
            <tbody>
              {[['하위 폴더', `${impact.childFolderCount}개${impact.childFolders.length ? ` (${impact.childFolders.join(', ')})` : ''}`],
                ['포함된 자료', `${impact.documentCount}건`], ['휴지통 자료', `${impact.trashedDocumentCount}건`], ['폴더 권한 설정', `${impact.aclCount}건 (삭제 후에도 보존)`]]
                .map(([k, v]) => <tr key={k}><td style={{ padding: '3px 12px 3px 0', color: '#6b7280' }}>{k}</td><td style={{ padding: '3px 0' }}>{v}</td></tr>)}
            </tbody>
          </table>
          {impact.canDelete ? (
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: 10 }}>
              빈 폴더입니다. 삭제하면 탐색·등록·AI 자동 분류 대상에서 제외되며, 🗑️ 삭제된 폴더에서 언제든 복원할 수 있습니다(복원 가능한 삭제).
            </div>
          ) : (
            <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: 10, color: '#991b1b' }} data-testid={`${idPrefix}-blocked`}>
              <b>삭제할 수 없습니다.</b>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{impact.reasons.map(r => <li key={r}>{r}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 12 }}>
        <button type="button" style={S.btn} onClick={onClose} data-testid={`${idPrefix}-cancel`} aria-label="닫기">닫기</button>
        <button type="button" style={S.btnDanger} disabled={!impact?.canDelete || busy} data-testid={`${idPrefix}-submit`} aria-label="폴더 삭제"
          onClick={async () => { setBusy(true); if (await onSubmit()) onClose(); else setBusy(false); }}>삭제</button>
      </div>
    </Modal>
  );
}

function TrashDialog({ api, folders, idPrefix, onClose, reload, setToast }: {
  api: ArchiveApi; folders: ArchiveFolder[]; idPrefix: string; onClose: () => void; reload: () => Promise<void>; setToast: (m: string) => void;
}) {
  const [rows, setRows] = useState<DeletedFolder[] | null>(null);
  const [error, setError] = useState('');
  // 충돌 해결 입력(폴더별): 위치·이름 직접 지정
  const [fix, setFix] = useState<Record<number, { code: string; message: string; parent: string; name: string }>>({});
  const load = useCallback(() => { api.get<DeletedFolder[]>('/archive/folders/deleted').then(setRows).catch(e => setError(e.message)); }, [api]);
  useEffect(() => { load(); }, [load]);

  const restore = async (r: DeletedFolder) => {
    const f = fix[r.id];
    const body: Record<string, unknown> = {};
    if (f?.parent) body.parentId = f.parent === 'root' ? null : Number(f.parent);
    if (f?.name.trim()) body.name = f.name.trim();
    try {
      await api.post(`/archive/folders/${r.id}/restore`, body);
      setToast(`「${body.name ?? r.name}」 폴더를 복원했습니다.`);
      setFix(x => { const n = { ...x }; delete n[r.id]; return n; });
      await reload(); load();
    } catch (e: any) {
      const code = e?.data?.code;
      if (code === 'parent_unavailable' || code === 'name_conflict') {
        setFix(x => ({ ...x, [r.id]: { code, message: e.message, parent: x[r.id]?.parent ?? '', name: x[r.id]?.name ?? r.name } }));
      } else setToast(e.message);
    }
  };

  return (
    <Modal title="삭제된 폴더" wide onClose={onClose}>
      {error && <div style={{ color: '#b91c1c', fontSize: 13 }}>{error}</div>}
      {rows && rows.length === 0 && <div style={S.muted}>삭제된 폴더가 없습니다.</div>}
      {rows && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid={`${idPrefix}-list`}>
          {rows.map(r => {
            const f = fix[r.id];
            return (
              <div key={r.id} style={{ ...S.card, padding: 10 }} data-testid={`${idPrefix}-row-${r.id}`}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, fontSize: 13 }}>
                    <b>📁 {r.name}</b> <span style={S.muted}>원래 위치: {r.originalPath}</span>
                    <div style={S.muted}>삭제 {fmtDateTime(r.deletedAt)} · {r.deletedByName ?? r.deletedByEmail ?? '-'}
                      {!r.parentAvailable && <span style={{ color: '#d97706' }}> · 원래 상위 폴더가 삭제됨</span>}
                      {r.nameConflict && <span style={{ color: '#d97706' }}> · 같은 이름의 폴더가 있음</span>}
                    </div>
                  </div>
                  <button type="button" style={S.btnPrimary} onClick={() => restore(r)} data-testid={`${idPrefix}-restore-${r.id}`} aria-label={`${r.name} 폴더 복원`}>
                    {f ? '지정한 위치로 복원' : '복원'}</button>
                </div>
                {f && (
                  <div style={{ marginTop: 8, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: 8, fontSize: 13 }} data-testid={`${idPrefix}-conflict-${r.id}`}>
                    <div style={{ marginBottom: 6, color: '#92400e' }}>{f.message} 복원할 위치와 이름을 확인해 주세요.</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <div style={{ flex: 2, minWidth: 200 }}>
                        <ParentSelect folders={folders} exclude={new Set()} value={f.parent} allowRoot idPrefix={`${idPrefix}-${r.id}`}
                          onChange={v => setFix(x => ({ ...x, [r.id]: { ...x[r.id], parent: v } }))} />
                      </div>
                      <input style={{ ...S.input, flex: 1, minWidth: 140 }} value={f.name} maxLength={200} aria-label="복원 폴더명" data-testid={`${idPrefix}-${r.id}-name`}
                        onChange={e => setFix(x => ({ ...x, [r.id]: { ...x[r.id], name: e.target.value } }))} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
