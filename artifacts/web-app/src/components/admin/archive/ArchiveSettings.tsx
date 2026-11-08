/**
 * 자료 관리설정 — ① 승인 관리 ② 분류·폴더·권한(기본 분류 생성, 폴더 추가·수정·이동·비활성화·메뉴 연결, 폴더 권한) ③ 감사로그.
 * 탭 노출: 승인 관리=승인권자·관리자, 분류·폴더·권한=관리자·폴더 권한설정자, 감사로그=관리자.
 * 서버가 archive.approve / archive.admin / 폴더 manage 권한을 재검증한다(화면 숨김과 별개로 API 차단).
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ARCHIVE_MENU_LABEL, AUDIT_ACTION_LABEL, S, fmtDateTime, type AclEntry, type ArchiveApi, type ArchiveFolder, type ArchiveMe,
} from './archiveApi';
import { ArchiveFolderTree } from './ArchiveFolderTree';
import { useArchiveFolderManager } from './ArchiveFolderManager';
import { ArchiveAclEditor } from './ArchiveAclEditor';
import { Field } from './ArchiveDocumentDetail';
import { ArchiveApprovals } from './ArchiveApprovals';

export type SettingsTab = 'approvals' | 'folders' | 'audit';

const MENU_KEYS = ['forms', 'manuals', 'contracts', 'records', 'hr', 'management'];

export function ArchiveSettings({ api, me, folders, reloadFolders, setToast, initialTab, onOpen, refreshKey = 0, onChanged }: {
  api: ArchiveApi; me: ArchiveMe; folders: ArchiveFolder[]; reloadFolders: () => Promise<void>; setToast: (m: string) => void;
  initialTab?: SettingsTab | null; onOpen?: (id: number) => void; refreshKey?: number; onChanged?: () => void;
}) {
  const canApprovals = me.canApprove || me.isArchiveAdmin;
  const canFolders = me.isArchiveAdmin || folders.some(f => f.actions.includes('manage'));
  const firstTab: SettingsTab = initialTab === 'approvals' && canApprovals ? 'approvals'
    : initialTab === 'audit' && me.isArchiveAdmin ? 'audit'
    : canApprovals ? 'approvals' : 'folders';
  const [tab, setTab] = useState<SettingsTab>(firstTab);
  // 승인 대기 건수(처리 가능한 요청만) — 0건이면 표시하지 않음
  const [pendingCount, setPendingCount] = useState(0);
  const loadPending = useCallback(() => {
    if (!canApprovals) return;
    api.get<any[]>('/archive/approvals?status=pending').then(r => setPendingCount(r.filter(a => a.canDecide).length)).catch(() => setPendingCount(0));
  }, [api, canApprovals]);
  useEffect(() => { loadPending(); }, [loadPending, refreshKey]);
  const [sel, setSel] = useState<number | null>(null);
  const folder = folders.find(f => f.id === sel) ?? null;
  const canManage = (f: ArchiveFolder | null) => me.isArchiveAdmin || !!f?.actions.includes('manage');
  // 전체 자료 화면과 동일한 폴더 관리 기능(같은 API·같은 folders 상태)
  const fm = useArchiveFolderManager({ api, me, folders, reload: reloadFolders, setToast, idPrefix: 'archive-settings-folder' });
  useEffect(() => { if (sel != null && !folders.some(f => f.id === sel)) setSel(null); }, [folders, sel]);

  const seed = async () => {
    try { await api.post('/archive/folders/seed'); setToast('기본 분류 체계를 생성했습니다.'); await reloadFolders(); }
    catch (e: any) { setToast(e.message); }
  };

  if (!canApprovals && !canFolders) {
    return <div style={S.card} data-testid="archive-settings-denied">자료 관리설정 권한이 없습니다(자료보관함 관리자·승인권자 전용).</div>;
  }
  const tabBtn = (k: SettingsTab, label: React.ReactNode, aria: string) => (
    <button type="button" style={{ ...S.btn, fontWeight: tab === k ? 700 : 400, background: tab === k ? '#eff6ff' : '#fff' }} onClick={() => setTab(k)} data-testid={`archive-settings-tab-${k}`} aria-label={aria}>{label}</button>
  );

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {canApprovals && tabBtn('approvals', <>승인 관리{pendingCount > 0 && <span data-testid="archive-settings-pending" style={{ marginLeft: 6, background: '#dc2626', color: '#fff', borderRadius: 999, padding: '0 7px', fontSize: 11, fontWeight: 700 }}>{pendingCount}</span>}</>, `승인 관리${pendingCount ? ` 대기 ${pendingCount}건` : ''}`)}
        {canFolders && tabBtn('folders', '분류·폴더·권한', '분류·폴더·권한')}
        {me.isArchiveAdmin && tabBtn('audit', '감사로그', '감사로그')}
      </div>

      {tab === 'approvals' && canApprovals && (
        <ArchiveApprovals api={api} onOpen={onOpen ?? (() => {})} setToast={setToast} refreshKey={refreshKey}
          onChanged={() => { loadPending(); onChanged?.(); }} />
      )}

      {tab === 'folders' && canFolders && (
        <>
          {me.isArchiveAdmin && me.folderCount === 0 && folders.length === 0 && (
            <div style={{ ...S.card, marginBottom: 12, background: '#f0f9ff', borderColor: '#bae6fd' }}>
              <div style={{ fontSize: 13, marginBottom: 8 }}>분류 체계가 아직 없습니다. 기본 9개 대분류(회사 경영·관리 ~ 홍보·브랜드)와 소분류를 생성할 수 있습니다.</div>
              <button type="button" style={S.btnPrimary} onClick={seed} data-testid="archive-settings-seed" aria-label="기본 분류 생성">기본 분류 생성</button>
            </div>
          )}
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
            <aside style={{ ...S.card, width: 300, flexShrink: 0, padding: 10, maxHeight: '75vh', overflowY: 'auto' }}>
              <div style={{ ...S.muted, fontWeight: 700, padding: '2px 6px 6px' }}>폴더(비활성 포함)</div>
              {fm.toolbar}
              <ArchiveFolderTree folders={folders} selectedId={sel} onSelect={setSel} showAllOption={false} testIdPrefix="archive-settings-tree"
                renderExtra={fm.enabled ? fm.rowExtra : undefined} onRowContextMenu={fm.enabled ? fm.onRowContextMenu : undefined} />
              {fm.overlay}
            </aside>
            <section style={{ flex: 1, minWidth: 0 }}>
              {!folder && <div style={{ ...S.card, color: '#6b7280' }}>왼쪽에서 폴더를 선택하세요.</div>}
              {folder && canManage(folder) && <FolderEditor key={folder.id} api={api} me={me} folder={folder} folders={folders} reload={reloadFolders} setToast={setToast} />}
              {folder && !canManage(folder) && <div style={S.card}>이 폴더의 설정 권한이 없습니다.</div>}
            </section>
          </div>
        </>
      )}
      {tab === 'audit' && me.isArchiveAdmin && <AuditViewer api={api} />}
    </div>
  );
}

function NewFolder({ api, parentId, label, onDone, setToast }: { api: ArchiveApi; parentId: number | null; label: string; onDone: () => Promise<void>; setToast: (m: string) => void }) {
  const [name, setName] = useState('');
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" style={{ ...S.btn, marginTop: 8, width: '100%' }} onClick={() => setOpen(true)} data-testid={`archive-folder-new-${parentId ?? 'root'}`} aria-label={label}>{label}</button>;
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
      <input style={S.input} value={name} onChange={e => setName(e.target.value)} placeholder="폴더명" autoFocus aria-label="새 폴더명" data-testid={`archive-folder-new-name-${parentId ?? 'root'}`} />
      <button type="button" style={S.btnPrimary} disabled={!name.trim()} data-testid={`archive-folder-new-save-${parentId ?? 'root'}`} aria-label="폴더 추가"
        onClick={async () => {
          try { await api.post('/archive/folders', { parentId, name }); setToast('폴더를 추가했습니다.'); setName(''); setOpen(false); await onDone(); }
          catch (e: any) { setToast(e.message); }
        }}>추가</button>
    </div>
  );
}

function FolderEditor({ api, me, folder, folders, reload, setToast }: { api: ArchiveApi; me: ArchiveMe; folder: ArchiveFolder; folders: ArchiveFolder[]; reload: () => Promise<void>; setToast: (m: string) => void }) {
  const [form, setForm] = useState({ name: folder.name, description: folder.description ?? '', menuKey: folder.menuKey ?? '', sortOrder: folder.sortOrder, parentId: folder.parentId == null ? '' : String(folder.parentId) });
  const [acl, setAcl] = useState<{ own: AclEntry[]; inherited: AclEntry[] } | null>(null);
  const [entries, setEntries] = useState<AclEntry[]>([]);
  useEffect(() => {
    api.get(`/archive/folders/${folder.id}/acl`).then(r => { setAcl(r); setEntries(r.own); }).catch(() => setAcl(null));
  }, [api, folder.id]);

  // 자기 자신·하위 폴더로는 이동 불가
  const descendants = new Set<number>([folder.id]);
  let grew = true;
  while (grew) { grew = false; for (const f of folders) if (f.parentId != null && descendants.has(f.parentId) && !descendants.has(f.id)) { descendants.add(f.id); grew = true; } }

  const save = async (patch: Record<string, unknown>, ok: string) => {
    try { await api.patch(`/archive/folders/${folder.id}`, patch); setToast(ok); await reload(); }
    catch (e: any) { setToast(e.message); }
  };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={S.card}>
        <h3 style={{ ...S.h2, fontSize: 14 }}>폴더 정보 <span style={S.muted}>{folder.path}</span></h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="폴더명"><input style={S.input} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} aria-label="폴더명" data-testid="archive-folder-name" /></Field>
          <Field label="정렬 순서"><input type="number" style={S.input} value={form.sortOrder} onChange={e => setForm(f => ({ ...f, sortOrder: Number(e.target.value) }))} aria-label="정렬 순서" data-testid="archive-folder-sort" /></Field>
          <Field label="하위 메뉴 연결(하위 폴더에 상속)">
            <select style={S.input} value={form.menuKey} onChange={e => setForm(f => ({ ...f, menuKey: e.target.value }))} aria-label="하위 메뉴 연결" data-testid="archive-folder-menukey">
              <option value="">{folder.effectiveMenuKey && !folder.menuKey ? `상위 따름(${ARCHIVE_MENU_LABEL[folder.effectiveMenuKey]})` : '연결 없음(전체 자료에서만)'}</option>
              {MENU_KEYS.map(k => <option key={k} value={k}>{ARCHIVE_MENU_LABEL[k]}</option>)}
            </select>
          </Field>
          <Field label="상위 폴더(이동)">
            <select style={S.input} value={form.parentId} onChange={e => setForm(f => ({ ...f, parentId: e.target.value }))} aria-label="상위 폴더" data-testid="archive-folder-parent" disabled={!me.isArchiveAdmin}>
              <option value="">(최상위)</option>
              {folders.filter(f => !descendants.has(f.id)).map(f => <option key={f.id} value={f.id}>{f.path}</option>)}
            </select>
          </Field>
        </div>
        <Field label="설명"><input style={S.input} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} aria-label="폴더 설명" data-testid="archive-folder-description" /></Field>
        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          <button type="button" style={S.btnPrimary} data-testid="archive-folder-save" aria-label="폴더 저장"
            onClick={() => save({ name: form.name, description: form.description, menuKey: form.menuKey || null, sortOrder: form.sortOrder, ...(String(folder.parentId ?? '') !== form.parentId ? { parentId: form.parentId ? Number(form.parentId) : null } : {}) }, '폴더를 저장했습니다.')}>저장</button>
          <button type="button" style={folder.isActive ? S.btnDanger : S.btn} data-testid="archive-folder-toggle-active" aria-label={folder.isActive ? '폴더 비활성화' : '폴더 활성화'}
            onClick={() => save({ isActive: !folder.isActive }, folder.isActive ? '비활성화했습니다(자료는 보존).' : '활성화했습니다.')}>{folder.isActive ? '비활성화' : '활성화'}</button>
        </div>
        <NewFolder api={api} parentId={folder.id} label="+ 하위 폴더 추가" onDone={reload} setToast={setToast} />
      </div>

      <div style={S.card}>
        <h3 style={{ ...S.h2, fontSize: 14 }}>폴더 접근권한 <span style={S.muted}>(하위 폴더·자료에 상속 · 차단 우선 · 지정 없으면 비공개)</span></h3>
        {!acl ? <div style={S.muted}>불러오는 중…</div> : (
          <>
            <ArchiveAclEditor api={api} entries={entries} onChange={setEntries} inherited={acl.inherited} testIdPrefix="archive-folder-acl" />
            <button type="button" style={{ ...S.btnPrimary, marginTop: 10 }} data-testid="archive-folder-acl-save" aria-label="폴더 권한 저장"
              onClick={async () => { try { await api.put(`/archive/folders/${folder.id}/acl`, { entries }); setToast('폴더 권한을 저장했습니다.'); await reload(); } catch (e: any) { setToast(e.message); } }}>권한 저장</button>
          </>
        )}
      </div>
    </div>
  );
}

function AuditViewer({ api }: { api: ArchiveApi }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [action, setAction] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api.get(`/archive/audit?limit=300${action ? `&action=${action}` : ''}`).then(setRows).catch(e => setErr(e.message)); }, [api, action]);
  return (
    <div style={{ ...S.card, padding: 0, overflowX: 'auto' }}>
      <div style={{ padding: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <h3 style={{ ...S.h2, margin: 0, fontSize: 14, flex: 1 }}>자료보관함 감사로그 <span style={S.muted}>(최근 300건)</span></h3>
        <select style={{ ...S.input, width: 180 }} value={action} onChange={e => setAction(e.target.value)} aria-label="동작 필터" data-testid="archive-audit-filter">
          <option value="">전체 동작</option>
          {Object.entries(AUDIT_ACTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {err && <div style={{ color: '#b91c1c', padding: 12 }}>{err}</div>}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th style={S.th}>일시</th><th style={S.th}>동작</th><th style={S.th}>사용자</th><th style={S.th}>자료</th><th style={S.th}>IP</th><th style={S.th}>내용</th></tr></thead>
        <tbody>
          {rows?.map(r => (
            <tr key={r.id}>
              <td style={{ ...S.td, fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDateTime(r.createdAt)}</td>
              <td style={{ ...S.td, fontSize: 12 }}>{AUDIT_ACTION_LABEL[r.action] ?? r.action}</td>
              <td style={{ ...S.td, fontSize: 12 }}>{r.userName ?? '—'}</td>
              <td style={{ ...S.td, fontSize: 12 }}>{r.documentTitle ?? (r.documentId ? `#${r.documentId}` : r.folderId ? `폴더 #${r.folderId}` : '—')}</td>
              <td style={{ ...S.td, fontSize: 11, color: '#9ca3af' }}>{r.ip ?? ''}</td>
              <td style={{ ...S.td, fontSize: 11, color: '#6b7280', maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.metadata ? JSON.stringify(r.metadata) : ''}>{r.metadata ? JSON.stringify(r.metadata) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
