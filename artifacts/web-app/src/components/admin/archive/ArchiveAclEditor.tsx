/**
 * 접근권한(ACL) 편집기 — 폴더/문서 공용.
 *  대상: 전 직원 / 역할 / 부서 / 개별 사용자, 효과: 허용 / 차단(차단 우선), 동작: 검색·열람 … 권한설정
 */
import React, { useEffect, useState } from 'react';
import { ACL_PRESETS, ACTION_LABEL, ALL_ACTIONS, S, badgeStyle, type AclEntry, type ArchiveApi } from './archiveApi';

interface Subjects { roles: Array<{ id: number; name: string; description: string | null }>; departments: string[]; users: Array<{ id: number; label: string; department: string | null }> }

let subjectsCache: Subjects | null = null;

export function useSubjects(api: ArchiveApi) {
  const [subjects, setSubjects] = useState<Subjects | null>(subjectsCache);
  useEffect(() => {
    if (subjectsCache) return;
    api.get<Subjects>('/archive/lookup/subjects').then(s => { subjectsCache = s; setSubjects(s); }).catch(() => setSubjects({ roles: [], departments: [], users: [] }));
  }, [api]);
  return subjects;
}

export function describeSubject(e: AclEntry, subjects: Subjects | null): string {
  if (e.subjectType === 'all_staff') return '전 직원';
  if (e.subjectType === 'department') return `부서: ${e.subjectValue}`;
  if (e.subjectType === 'role') return `역할: ${subjects?.roles.find(r => r.id === e.subjectId)?.name ?? `#${e.subjectId}`}`;
  if (e.subjectType === 'user') return `사용자: ${subjects?.users.find(u => u.id === e.subjectId)?.label ?? `#${e.subjectId}`}`;
  if (e.subjectType === 'no_inherit') return '폴더 권한 상속 해제';
  return e.subjectType;
}

export function ArchiveAclEditor({ api, entries, onChange, inherited, testIdPrefix = 'acl' }: {
  api: ArchiveApi;
  entries: AclEntry[];
  onChange: (next: AclEntry[]) => void;
  inherited?: AclEntry[];
  testIdPrefix?: string;
}) {
  const subjects = useSubjects(api);
  const [draft, setDraft] = useState<AclEntry>({ subjectType: 'all_staff', effect: 'allow', actions: ['view', 'preview', 'print'] });
  const editable = entries.filter(e => e.subjectType !== 'no_inherit');

  const toggleAction = (a: string) =>
    setDraft(d => ({ ...d, actions: d.actions.includes(a) ? d.actions.filter(x => x !== a) : [...d.actions, a] }));
  const canAdd = draft.actions.length > 0 && (
    draft.subjectType === 'all_staff' ||
    (draft.subjectType === 'department' && !!draft.subjectValue) ||
    ((draft.subjectType === 'role' || draft.subjectType === 'user') && !!draft.subjectId));
  const add = () => {
    if (!canAdd) return;
    onChange([...entries, { ...draft }]);
    setDraft(d => ({ ...d, subjectId: null, subjectValue: null }));
  };

  return (
    <div data-testid={`${testIdPrefix}-editor`}>
      {inherited && inherited.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ ...S.muted, fontWeight: 600, marginBottom: 4 }}>상위 폴더에서 상속되는 권한</div>
          {inherited.map((e, i) => (
            <div key={i} style={{ fontSize: 12, color: '#6b7280', padding: '3px 0' }}>
              <span style={badgeStyle(e.effect === 'deny' ? '#dc2626' : '#6b7280')}>{e.effect === 'deny' ? '차단' : '허용'}</span>{' '}
              {describeSubject(e, subjects)} — {e.actions.map(a => ACTION_LABEL[a] ?? a).join(', ')}
              {e.fromFolder && <span style={{ color: '#9ca3af' }}> (from {e.fromFolder})</span>}
            </div>
          ))}
        </div>
      )}

      <div style={{ ...S.muted, fontWeight: 600, marginBottom: 4 }}>직접 지정한 권한</div>
      {editable.length === 0 && <div style={{ ...S.muted, padding: '4px 0 8px' }}>직접 지정한 권한이 없습니다.</div>}
      {editable.map((e, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '1px dashed #eef0f3', fontSize: 13 }}>
          <span style={badgeStyle(e.effect === 'deny' ? '#dc2626' : '#059669')}>{e.effect === 'deny' ? '차단' : '허용'}</span>
          <span style={{ minWidth: 140 }}>{describeSubject(e, subjects)}</span>
          <span style={{ flex: 1, color: '#4b5563', fontSize: 12 }}>{e.actions.map(a => ACTION_LABEL[a] ?? a).join(', ')}</span>
          <button type="button" style={{ ...S.btn, padding: '3px 8px', fontSize: 12 }}
            data-testid={`${testIdPrefix}-remove-${i}`} aria-label="권한 항목 삭제"
            onClick={() => onChange(entries.filter(x => x !== e))}>삭제</button>
        </div>
      ))}

      <div style={{ marginTop: 10, padding: 10, background: '#f9fafb', borderRadius: 8, border: '1px solid #eef0f3' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select style={{ ...S.input, width: 120 }} value={draft.effect} aria-label="허용 또는 차단"
            data-testid={`${testIdPrefix}-effect`} onChange={e => setDraft(d => ({ ...d, effect: e.target.value }))}>
            <option value="allow">허용</option>
            <option value="deny">차단(우선)</option>
          </select>
          <select style={{ ...S.input, width: 130 }} value={draft.subjectType} aria-label="권한 대상 유형"
            data-testid={`${testIdPrefix}-subject-type`}
            onChange={e => setDraft(d => ({ ...d, subjectType: e.target.value, subjectId: null, subjectValue: null }))}>
            <option value="all_staff">전 직원</option>
            <option value="role">역할</option>
            <option value="department">부서</option>
            <option value="user">개별 사용자</option>
          </select>
          {draft.subjectType === 'role' && (
            <select style={{ ...S.input, width: 200 }} value={draft.subjectId ?? ''} aria-label="역할 선택" data-testid={`${testIdPrefix}-role`}
              onChange={e => setDraft(d => ({ ...d, subjectId: Number(e.target.value) || null }))}>
              <option value="">역할 선택</option>
              {subjects?.roles.map(r => <option key={r.id} value={r.id}>{r.name}{r.description ? ` — ${r.description}` : ''}</option>)}
            </select>
          )}
          {draft.subjectType === 'department' && (
            <input style={{ ...S.input, width: 200 }} list={`${testIdPrefix}-dept-list`} placeholder="부서명" aria-label="부서명"
              data-testid={`${testIdPrefix}-department`} value={draft.subjectValue ?? ''}
              onChange={e => setDraft(d => ({ ...d, subjectValue: e.target.value }))} />
          )}
          <datalist id={`${testIdPrefix}-dept-list`}>{subjects?.departments.map(d => <option key={d} value={d} />)}</datalist>
          {draft.subjectType === 'user' && (
            <select style={{ ...S.input, width: 220 }} value={draft.subjectId ?? ''} aria-label="사용자 선택" data-testid={`${testIdPrefix}-user`}
              onChange={e => setDraft(d => ({ ...d, subjectId: Number(e.target.value) || null }))}>
              <option value="">사용자 선택</option>
              {subjects?.users.map(u => <option key={u.id} value={u.id}>{u.label}{u.department ? ` (${u.department})` : ''}</option>)}
            </select>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {ACL_PRESETS.map(p => (
            <button key={p.label} type="button" style={{ ...S.btn, padding: '3px 8px', fontSize: 11 }}
              data-testid={`${testIdPrefix}-preset-${p.label}`} aria-label={`프리셋 ${p.label}`}
              onClick={() => setDraft(d => ({ ...d, actions: p.actions }))}>{p.label}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
          {ALL_ACTIONS.map(a => (
            <label key={a} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
              <input type="checkbox" checked={draft.actions.includes(a)} onChange={() => toggleAction(a)}
                data-testid={`${testIdPrefix}-action-${a}`} aria-label={ACTION_LABEL[a]} />
              {ACTION_LABEL[a]}
            </label>
          ))}
        </div>
        <button type="button" style={{ ...S.btnPrimary, marginTop: 8, opacity: canAdd ? 1 : 0.5 }} disabled={!canAdd}
          data-testid={`${testIdPrefix}-add`} aria-label="권한 항목 추가" onClick={add}>항목 추가</button>
      </div>
    </div>
  );
}
