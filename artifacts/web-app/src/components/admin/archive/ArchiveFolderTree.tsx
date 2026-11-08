/** 폴더 트리(깊이 제한 없음) — 탐색·선택 공용 */
import React, { useMemo, useState } from 'react';
import type { ArchiveFolder } from './archiveApi';

export function buildChildren(folders: ArchiveFolder[]) {
  const m = new Map<number | null, ArchiveFolder[]>();
  for (const f of folders) {
    const k = f.parentId != null && folders.some(x => x.id === f.parentId) ? f.parentId : null;
    const arr = m.get(k) ?? []; arr.push(f); m.set(k, arr);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'ko'));
  return m;
}

export function ArchiveFolderTree({ folders, selectedId, onSelect, showAllOption = true, testIdPrefix = 'folder-tree', renderExtra, onRowContextMenu }: {
  folders: ArchiveFolder[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  showAllOption?: boolean;
  testIdPrefix?: string;
  renderExtra?: (f: ArchiveFolder) => React.ReactNode;
  onRowContextMenu?: (f: ArchiveFolder, e: React.MouseEvent) => void;   // 폴더 관리 메뉴(관리자 전용)
}) {
  const children = useMemo(() => buildChildren(folders), [folders]);
  const [open, setOpen] = useState<Record<number, boolean>>({});

  const node = (f: ArchiveFolder, depth: number): React.ReactNode => {
    const kids = children.get(f.id) ?? [];
    const isOpen = open[f.id] ?? false;
    const active = selectedId === f.id;
    return (
      <div key={f.id}>
        <div onContextMenu={onRowContextMenu ? (e) => onRowContextMenu(f, e) : undefined} style={{
          display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px', paddingLeft: 6 + depth * 14, borderRadius: 6,
          background: active ? '#eff6ff' : 'transparent', color: f.isActive ? (active ? '#1d4ed8' : '#374151') : '#9ca3af', fontSize: 13,
        }}>
          <button type="button" aria-label={isOpen ? `${f.name} 접기` : `${f.name} 펼치기`} data-testid={`${testIdPrefix}-toggle-${f.id}`}
            onClick={() => setOpen(o => ({ ...o, [f.id]: !isOpen }))}
            style={{ width: 16, border: 0, background: 'none', cursor: kids.length ? 'pointer' : 'default', color: '#9ca3af', padding: 0, visibility: kids.length ? 'visible' : 'hidden' }}>
            {isOpen ? '▾' : '▸'}
          </button>
          <button type="button" data-testid={`${testIdPrefix}-select-${f.id}`} aria-label={`폴더 ${f.name} 선택`}
            onClick={() => onSelect(f.id)}
            style={{ flex: 1, textAlign: 'left', border: 0, background: 'none', cursor: 'pointer', color: 'inherit', fontWeight: active ? 700 : 400, padding: 0, fontSize: 13 }}>
            📁 {f.name}{!f.isActive && ' (비활성)'}
            {f.docCount != null && f.docCount > 0 && <span style={{ color: '#9ca3af', fontSize: 11 }}> {f.docCount}</span>}
          </button>
          {renderExtra?.(f)}
        </div>
        {isOpen && kids.map(k => node(k, depth + 1))}
      </div>
    );
  };

  return (
    <div data-testid={testIdPrefix}>
      {showAllOption && (
        <button type="button" data-testid={`${testIdPrefix}-all`} aria-label="전체 폴더" onClick={() => onSelect(null)}
          style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 8px', borderRadius: 6, border: 0, cursor: 'pointer', fontSize: 13,
            background: selectedId == null ? '#eff6ff' : 'transparent', fontWeight: selectedId == null ? 700 : 400, color: selectedId == null ? '#1d4ed8' : '#374151' }}>
          🗂️ 전체
        </button>
      )}
      {(children.get(null) ?? []).map(f => node(f, 0))}
      {folders.length === 0 && <div style={{ fontSize: 12, color: '#9ca3af', padding: 8 }}>표시할 폴더가 없습니다.</div>}
    </div>
  );
}
