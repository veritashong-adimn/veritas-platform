// 동일인 수동 확인 — 업로드 자료 vs 후보 기존 Master 비교 및 관리자 판정
//   비교: 업로드(성명·주민번호 보유·이메일·휴대폰·언어·경력) / 후보 Master 등록정보 / 과거 CRM 수행이력 / 통합·제외 관계 / 일치·충돌 근거
//   판정: ① 기존 Master 와 동일인(ID 연결) ② 다른 사람(신규 자격 재판정) ③ 판단 불가(보류). 저장 시 감사로그로 남고 재분석 시 유지된다.
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/constants';

type Cand = {
  id: number; name: string; alive: boolean; active: boolean; linkable: boolean; status: string; mergedFrom: number[]; representativeId: number | null;
  email: string | null; phone: string | null; languages: string | null; region: string | null; education: string | null; bio: string | null; hasRrn: boolean;
  history: { legacyNames: string[]; rows: number; first: string | null; last: string | null }; agreements: string[]; conflicts: string[]; rrnConflict: boolean;
};
type Detail = {
  rowNumber: number; category: string; reason: string; basis: string[]; savedDecision: { decision: string; at: string; note: string | null } | null;
  allowLinkIds: number[]; allowNew: boolean; allowOwnHistory: boolean; rrnConflictIds: number[];
  upload: { name: string; englishName: string | null; hasRrn: boolean; email: string | null; phone: string | null; languages: string | null; services: string | null; region: string | null; education: string | null; career: string | null };
  history: { byName: { n: number; first: string | null; last: string | null; companies: number; with_rrn: number }; byRrn: number; note: string };
  candidates: Cand[];
};

export const DECISION_LABEL = (d: string) => d.startsWith('link:') ? `기존 #${d.slice(5)} 동일인` : d === 'different' ? '다른 사람(자격 재판정)' : d === 'different_own_history' ? '다른 사람·본인 이력 확인' : d === 'new' ? '신규 등록' : '보류';

export function TranslatorReviewDrawer({ token, snapshotId, rowNumber, onClose, onSaved, onToast }: {
  token: string; snapshotId: string; rowNumber: number; onClose: () => void; onSaved: (rowNumber: number, decision: string) => void; onToast: (m: string) => void;
}) {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [d, setD] = useState<Detail | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    (async () => {
      const res = await fetch(api('/api/admin/translators/import-plan/review'), { method: 'POST', headers: auth, body: JSON.stringify({ snapshotId, rowNumber }) });
      const data = await res.json();
      if (!res.ok) { onToast(data?.error || '상세 조회 실패'); onClose(); return; }
      setD(data); setNote(data.savedDecision?.note ?? '');
    })();
  }, [snapshotId, rowNumber]); // eslint-disable-line

  const save = async (decision: string) => {
    setSaving(true);
    try {
      const res = await fetch(api('/api/admin/translators/import-plan/review/decision'), { method: 'POST', headers: auth, body: JSON.stringify({ snapshotId, rowNumber, decision, note }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '판정 저장 실패');
      onToast(`${rowNumber}행 판정 저장: ${DECISION_LABEL(decision)} (감사로그 기록)`);
      onSaved(rowNumber, decision); onClose();
    } catch (e: any) { onToast(e?.message || '판정 저장 실패'); } finally { setSaving(false); }
  };

  const cell: React.CSSProperties = { padding: '5px 8px', borderTop: '1px solid #f3f4f6', fontSize: 12, verticalAlign: 'top' };
  const btn = (color: string, disabled = false): React.CSSProperties => ({ padding: '7px 12px', borderRadius: 8, border: 'none', background: color, color: '#fff', fontWeight: 700, fontSize: 12.5, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 });
  const v = (x: unknown) => (x == null || x === '' ? <span style={{ color: '#9ca3af' }}>(없음)</span> : String(x));

  return (
    <div role="dialog" aria-label="동일인 수동 확인" data-testid="tplan-review-drawer"
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.35)', zIndex: 60, display: 'flex', justifyContent: 'flex-end' }} onClick={onClose}>
      <div style={{ width: 'min(980px, 100%)', height: '100%', overflowY: 'auto', background: '#fff', padding: 18 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>동일인 수동 확인 — 엑셀 {rowNumber}행</div>
          <button onClick={onClose} style={btn('#6b7280')} data-testid="tplan-review-close" aria-label="닫기">닫기</button>
        </div>
        {!d ? <div style={{ padding: 20, color: '#6b7280' }}>불러오는 중…</div> : (<>
          <div style={{ fontSize: 12.5, color: '#991b1b', margin: '8px 0' }}>{d.reason}</div>
          <div style={{ fontSize: 11.5, color: '#6b7280' }}>{d.basis.map((b, i) => <div key={i}>· {b}</div>)}</div>
          {d.savedDecision && <div style={{ marginTop: 6, fontSize: 12, padding: '6px 10px', background: '#eff6ff', borderRadius: 6 }}>저장된 판정: <b>{DECISION_LABEL(d.savedDecision.decision)}</b> · {new Date(d.savedDecision.at).toLocaleString()}{d.savedDecision.note ? ` · 메모: ${d.savedDecision.note}` : ''}</div>}

          <div style={{ fontSize: 13, fontWeight: 800, margin: '14px 0 6px' }}>업로드 자료 · 과거 CRM 수행이력</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}><tbody>
            {[['성명', `${d.upload.name}${d.upload.englishName ? ` (${d.upload.englishName})` : ''}`], ['주민번호', d.upload.hasRrn ? '있음' : '없음'], ['이메일', d.upload.email], ['휴대폰', d.upload.phone], ['언어', d.upload.languages], ['서비스', d.upload.services], ['지역', d.upload.region], ['학력', d.upload.education], ['경력', d.upload.career],
              ['수행이력(성명 일치)', `${d.history.byName.n}건${d.history.byName.n ? ` · ${d.history.byName.first ?? '-'} ~ ${d.history.byName.last ?? '-'} · 거래처 ${d.history.byName.companies}곳 · 주민번호 기재 ${d.history.byName.with_rrn}건` : ''}`],
              ['수행이력(주민번호 일치)', d.upload.hasRrn ? `${d.history.byRrn}건` : '주민번호 없음(비교 불가)']].map(([k, val]) => (
              <tr key={k as string}><td style={{ ...cell, width: 150, color: '#6b7280' }}>{k}</td><td style={cell}>{v(val)}</td></tr>
            ))}
          </tbody></table>
          <div style={{ fontSize: 11.5, color: '#92400e', marginTop: 4 }}>※ {d.history.note}</div>

          <div style={{ fontSize: 13, fontWeight: 800, margin: '14px 0 6px' }}>후보 기존 Master</div>
          {d.candidates.length === 0 && <div style={{ fontSize: 12, color: '#6b7280' }}>후보 Master 없음 — 다른 사람 또는 보류로 판정하세요.</div>}
          <div style={{ display: 'grid', gap: 10 }}>
            {d.candidates.map(c => (
              <div key={c.id} style={{ border: `1px solid ${c.rrnConflict ? '#fecaca' : '#e5e7eb'}`, borderRadius: 8, padding: 10 }} data-testid={`tplan-review-cand-${c.id}`}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ fontWeight: 800 }}>#{c.id} {c.name} <span style={{ fontWeight: 600, fontSize: 12, color: c.alive ? '#065f46' : '#9ca3af' }}>{c.status}</span></div>
                  {c.linkable && !c.rrnConflict
                    ? <button style={btn('#047857', saving)} disabled={saving} onClick={() => save(`link:${c.representativeId ?? c.id}`)} data-testid={`tplan-review-link-${c.id}`} aria-label={`기존 Master ${c.id} 와 동일인으로 연결`}>① 동일인 → #{c.representativeId ?? c.id} 연결</button>
                    : <span style={{ fontSize: 12, color: '#991b1b' }}>{c.rrnConflict ? '주민번호 충돌 — 연결 불가' : c.alive ? '연결 불가' : '제외 Master — 연결·재활성화 불가'}</span>}
                </div>
                <div style={{ fontSize: 12, marginTop: 4, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 4 }}>
                  <div>이메일: {v(c.email)}</div><div>휴대폰: {v(c.phone)}</div><div>주민번호: {c.hasRrn ? '등록됨' : '미등록'}</div>
                  <div>언어: {v(c.languages)}</div><div>지역: {v(c.region)}</div><div>학력: {v(c.education)}</div>
                </div>
                {c.bio && <div style={{ fontSize: 11.5, color: '#4b5563', marginTop: 4 }}>경력: {c.bio}</div>}
                <div style={{ fontSize: 12, marginTop: 4 }}>수행이력(연결됨): {c.history.rows}건{c.history.rows ? ` · ${c.history.first ?? '-'} ~ ${c.history.last ?? '-'}` : ''}{c.history.legacyNames.length ? ` · CRM명 ${c.history.legacyNames.join(', ')}` : ''}</div>
                {(c.mergedFrom.length > 0 || c.representativeId) && <div style={{ fontSize: 12, color: '#6b21a8' }}>통합 관계: {c.representativeId ? `대표 Master #${c.representativeId} 로 통합됨` : ''}{c.mergedFrom.length ? ` 통합된 Master #${c.mergedFrom.join(', #')} 의 대표` : ''}</div>}
                <div style={{ fontSize: 12, marginTop: 4 }}>
                  {c.agreements.map(a => <span key={a} style={{ marginRight: 6, color: '#065f46' }}>✓ {a}</span>)}
                  {c.conflicts.map(a => <span key={a} style={{ marginRight: 6, color: '#b91c1c' }}>✗ {a}</span>)}
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 14, padding: 12, borderRadius: 8, background: '#f9fafb', border: '1px solid #e5e7eb' }}>
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 6 }}>관리자 판정</div>
            <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="판정 근거 메모(선택)" data-testid="tplan-review-note" aria-label="판정 근거 메모"
              style={{ width: '100%', minHeight: 54, padding: 8, borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12.5, boxSizing: 'border-box' }} />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <button style={btn('#1d4ed8', saving)} disabled={saving} onClick={() => save('different')} data-testid="tplan-review-different" aria-label="다른 사람 — 신규 자격 재판정">② 다른 사람 → 신규 자격 재판정{d.upload.hasRrn ? '(주민번호 보유)' : ''}</button>
              {d.allowOwnHistory && <button style={btn('#4338ca', saving)} disabled={saving} onClick={() => save('different_own_history')} data-testid="tplan-review-own-history" aria-label="다른 사람 — 본인 수행이력 확인 후 신규">② 다른 사람 + 수행이력 본인 확인 → 신규</button>}
              <button style={btn('#6b7280', saving)} disabled={saving} onClick={() => save('hold')} data-testid="tplan-review-hold" aria-label="판단 불가 — 보류">③ 판단 불가 → 보류</button>
            </div>
            <div style={{ fontSize: 11.5, color: '#6b7280', marginTop: 6 }}>
              ② 는 실행 시 다시 검증합니다 — 주민번호 보유 또는 본인 수행이력 확인 + 실제 이메일(미사용) + 주민번호 미중복일 때만 신규 생성, 그 외는 등록 제외. 통합·제외 Master·다른 계정 식별정보·주민번호 충돌 건은 신규 생성하지 않습니다.
            </div>
          </div>
        </>)}
      </div>
    </div>
  );
}
