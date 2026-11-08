// 역할관리 — 권한 설정 영역(현재 사이드메뉴 업무 영역별 · 접기/펼치기 · 메뉴 접근권한 / 기능 실행권한 구분).
//  · 체크박스 구조·전체 선택/해제·권한 저장(상위 화면) 방식은 기존과 같다.
//  · 미사용(deprecated) 권한은 표시하지 않는다 — 서버가 저장 시 기존 연결을 보존한다.
//  · 각 기능 권한에 서버 검증 여부(API 검증 / 메뉴만 / 검증 예정)를 작게 표시한다.
import React, { useState } from 'react';

export type PermItem = { key: string; name: string; category: 'menu' | 'action'; group?: string; deprecated?: boolean; enforce?: 'api' | 'menu' | 'none' };
const GROUPS: { id: string; label: string }[] = [
  { id: 'dashboard', label: '대시보드' }, { id: 'customer', label: '고객·거래처' }, { id: 'sales', label: '영업관리' },
  { id: 'resource', label: '리소스' }, { id: 'product', label: '상품관리' }, { id: 'settlement', label: '정산' },
  { id: 'collection', label: '수금관리' }, { id: 'data', label: '데이터 자산' }, { id: 'system', label: '시스템' }, { id: 'trash', label: '휴지통' },
];
const ENFORCE_LABEL: Record<string, { t: string; c: string; title: string }> = {
  api: { t: 'API 검증', c: '#047857', title: '서버 API 에서 이 권한을 검사합니다' },
  menu: { t: '메뉴·페이지', c: '#1d4ed8', title: '사이드메뉴 표시와 페이지 접근에 적용됩니다' },
  none: { t: '검증 예정', c: '#b45309', title: '권한 항목만 등록 — 서버 API 검사는 다음 단계에서 적용 예정' },
};

export function RolePermissionGroups({ perms, selected, onChange }: {
  perms: PermItem[]; selected: Set<string>; onChange: (fn: (prev: Set<string>) => Set<string>) => void;
}) {
  const visible = perms.filter(p => !p.deprecated);
  const [open, setOpen] = useState<Record<string, boolean>>({ sales: true, settlement: true });
  const setKeys = (keys: string[], on: boolean) => onChange(prev => { const n = new Set(prev); keys.forEach(k => (on ? n.add(k) : n.delete(k))); return n; });
  const toggle = (k: string, on: boolean) => setKeys([k], on);
  const allKeys = visible.map(p => p.key);
  const btn: React.CSSProperties = { padding: '3px 10px', fontSize: 11, fontWeight: 600, border: '1px solid #d1d5db', borderRadius: 6, background: '#f9fafb', cursor: 'pointer', color: '#374151' };

  const box = (p: PermItem) => {
    const on = selected.has(p.key); const menu = p.category === 'menu'; const ef = p.enforce ? ENFORCE_LABEL[p.enforce] : null;
    return (
      <label key={p.key} data-testid={`perm-${p.key}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 10px', border: `1px solid ${on ? (menu ? '#3b82f6' : '#10b981') : '#e5e7eb'}`, borderRadius: 8, cursor: 'pointer', background: on ? (menu ? '#eff6ff' : '#ecfdf5') : '#fff' }}>
        <input type="checkbox" checked={on} onChange={e => toggle(p.key, e.target.checked)} aria-label={`${p.name} 권한`} style={{ width: 15, height: 15, cursor: 'pointer', marginTop: 1 }} />
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 12.5, fontWeight: on ? 600 : 400, color: on ? (menu ? '#1d4ed8' : '#065f46') : '#374151' }}>{p.name}</p>
          <p style={{ margin: 0, fontSize: 10, color: '#9ca3af' }}>{p.key}{ef && <span title={ef.title} style={{ marginLeft: 6, color: ef.c, fontWeight: 700 }}>· {ef.t}</span>}</p>
        </div>
      </label>
    );
  };

  return (
    <div style={{ padding: 20 }} data-testid="role-permission-groups">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontSize: 12, color: '#6b7280' }}>현재 사이드메뉴 영역 기준 · <b style={{ color: '#1d4ed8' }}>메뉴 접근권한</b>(메뉴 표시·페이지 접근) / <b style={{ color: '#047857' }}>기능 실행권한</b>(작업 실행)</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" style={btn} onClick={() => setKeys(allKeys, true)} aria-label="전체 권한 선택" data-testid="perm-all-on">전체 선택</button>
          <button type="button" style={btn} onClick={() => setKeys(allKeys, false)} aria-label="전체 권한 해제" data-testid="perm-all-off">전체 해제</button>
          <button type="button" style={btn} onClick={() => setOpen(Object.fromEntries(GROUPS.map(g => [g.id, true])))} aria-label="모든 영역 펼치기">모두 펼치기</button>
          <button type="button" style={btn} onClick={() => setOpen({})} aria-label="모든 영역 접기">모두 접기</button>
        </div>
      </div>
      {GROUPS.map(g => {
        const items = visible.filter(p => (p.group ?? 'system') === g.id);
        if (!items.length) return null;
        const menus = items.filter(p => p.category === 'menu'), actions = items.filter(p => p.category === 'action');
        const cnt = items.filter(p => selected.has(p.key)).length; const isOpen = !!open[g.id];
        return (
          <div key={g.id} style={{ border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 10, overflow: 'hidden' }} data-testid={`perm-group-${g.id}`}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', background: '#f8fafc', cursor: 'pointer' }}
              onClick={() => setOpen(o => ({ ...o, [g.id]: !o[g.id] }))} role="button" aria-expanded={isOpen} aria-label={`${g.label} 영역 ${isOpen ? '접기' : '펼치기'}`} data-testid={`perm-group-toggle-${g.id}`}>
              <span style={{ fontSize: 11, color: '#64748b', width: 10 }}>{isOpen ? '▾' : '▸'}</span>
              <b style={{ fontSize: 13, color: '#111827' }}>{g.label}</b>
              <span style={{ fontSize: 11.5, color: cnt ? '#1d4ed8' : '#9ca3af' }}>{cnt}/{items.length}</span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
                <button type="button" style={btn} onClick={() => setKeys(items.map(p => p.key), true)} aria-label={`${g.label} 전체 선택`}>전체 선택</button>
                <button type="button" style={btn} onClick={() => setKeys(items.map(p => p.key), false)} aria-label={`${g.label} 전체 해제`}>전체 해제</button>
              </span>
            </div>
            {isOpen && (
              <div style={{ padding: '10px 12px' }}>
                {menus.length > 0 && <>
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: '#1d4ed8', margin: '0 0 6px' }}>메뉴 접근권한</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8, marginBottom: actions.length ? 12 : 0 }}>{menus.map(box)}</div>
                </>}
                {actions.length > 0 && <>
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: '#047857', margin: '0 0 6px' }}>기능 실행권한</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>{actions.map(box)}</div>
                </>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
