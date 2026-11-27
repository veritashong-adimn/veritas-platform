// ─── 견적 수신자 '담당자 정보 갱신' ─────────────────────────────────────────────
// 견적별 고객정보 고정: 저장된 견적서의 수신자(거래처명·담당자)는 저장 시점 값으로 고정되어,
// 판매 담당자 연결이나 담당자 Master 수정으로 자동 변경되지 않는다.
// 고정값과 현재 담당자 Master 가 실질적으로 다를 때만 이 안내를 보여 주고, 사용자가 [담당자 정보 갱신]을 눌렀을 때만 바꾼다.
// 비교 기준은 lib/quoteRecipientCompare 의 compareRecipient 하나로 통일한다.
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/constants';
import { compareRecipient, RECIPIENT_FIELDS, type RecipientValues as R } from '../../lib/quoteRecipientCompare';
import { GhostBtn } from '../ui';

const norm = (v: string | null | undefined) => (v ?? '').trim();
// 비교 대상 전체(거래처 포함)를 보여 줘야 어떤 항목이 다른지 화면에서 확인할 수 있다
const summary = (r: R) => RECIPIENT_FIELDS.map(f => norm(r[f.key])).filter(Boolean).join(' · ') || '담당자 없음';

type State = { kind: 'ok'; fixed: R; live: R | null } | { kind: 'error' } | null;

// 견적 상세 응답(또는 같은 값) → 표시 상태
const stateOf = (d: any): State => {
  if (!d.customerSnapshotFixed) return null;   // 고정값 없는 견적은 현재 Master 를 그대로 출력 — 비교 대상 아님
  const fixed = Object.fromEntries(RECIPIENT_FIELDS.map(f => [f.key, d[f.key] ?? null])) as R;
  return { kind: 'ok', fixed, live: (d.liveRecipient ?? null) as R | null };
};

export function QuoteRecipientRefreshBar({ quoteId, token, onToast, refreshKey, onRefreshed, data }: {
  quoteId: number; token: string; onToast: (m: string) => void;
  refreshKey?: unknown;            // 바뀌면 다시 조회(견적 저장 직후 등)
  onRefreshed?: () => void;
  // 공유 모드(판매 상세): 상위 화면이 이미 조회한 견적 수신자 값(customerSnapshotFixed·고정값·liveRecipient)을 넘기면 따로 조회하지 않는다.
  //   null = 조회 실패(견적 없음). 갱신 후 최신값은 onRefreshed 로 상위가 다시 조회해 넘긴다. 생략(undefined)하면 기존처럼 직접 조회.
  data?: Record<string, any> | null;
}) {
  const shared = data !== undefined;
  const [state, setState] = useState<State>(null);
  const [busy, setBusy] = useState(false);
  const reqSeq = useRef(0);        // 늦게 도착한 이전 견적 응답이 현재 화면을 덮지 않도록
  const authH = { Authorization: `Bearer ${token}` };

  const load = async () => {
    const seq = ++reqSeq.current;
    try {
      const r = await fetch(api(`/api/admin/quotes/${quoteId}`), { headers: authH });
      if (seq !== reqSeq.current) return;
      if (!r.ok) { setState({ kind: 'error' }); return; }
      const d = await r.json();
      if (seq !== reqSeq.current) return;
      setState(stateOf(d));
    } catch {
      if (seq === reqSeq.current) setState({ kind: 'error' });
    }
  };
  useEffect(() => { if (!shared) setState(null); }, [quoteId]);   // 다른 견적으로 이동 시 이전 견적 결과 제거
  useEffect(() => { if (!shared && refreshKey !== true) load(); }, [quoteId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const view: State = shared ? (data ? stateOf(data) : { kind: 'error' }) : state;
  const recheck = () => (shared ? onRefreshed?.() : load());
  if (!view) return null;

  const barStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', marginBottom: 12,
    background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, fontSize: 13 };

  if (view.kind === 'error') {
    return (
      <div data-testid="quote-recipient-check-error" style={barStyle}>
        <div style={{ flex: 1, minWidth: 0, fontWeight: 700, color: '#92400e' }}>현재 담당자 정보를 조회하지 못해 견적서 수신자 정보 일치 여부를 확인할 수 없습니다.</div>
        <GhostBtn onClick={recheck} data-testid="btn-quote-recipient-recheck" aria-label="수신자 정보 다시 확인"
          style={{ whiteSpace: 'nowrap', fontSize: 12, padding: '6px 12px' }}>다시 확인</GhostBtn>
      </div>
    );
  }

  const cmp = compareRecipient(view.fixed, view.live);
  if (cmp.status === 'same') return null;

  if (cmp.status === 'no_live_contact') {
    // 갱신하면 고정된 담당자 정보가 지워지므로 갱신 버튼을 제공하지 않는다
    return (
      <div data-testid="quote-recipient-no-live" style={barStyle}>
        <div style={{ flex: 1, minWidth: 0, lineHeight: 1.6 }}>
          <div style={{ fontWeight: 700, color: '#92400e' }}>확인 필요 — 현재 연결된 담당자 정보를 확인할 수 없습니다</div>
          <div style={{ color: '#374151' }}>견적서 출력(고정): <b data-testid="quote-recipient-fixed">{summary(view.fixed)}</b></div>
        </div>
      </div>
    );
  }

  const refresh = async () => {
    if (!window.confirm('견적서 수신자 정보를 현재 담당자 정보로 갱신합니다.\n이후 견적서·거래명세서 출력에 새 정보가 표시됩니다. 계속할까요?')) return;
    setBusy(true);
    try {
      const r = await fetch(api(`/api/admin/quotes/${quoteId}/recipient-refresh`), { method: 'POST', headers: { ...authH, 'Content-Type': 'application/json' } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { onToast(d?.error || '담당자 정보 갱신 실패'); return; }
      onToast('견적서 수신자 정보를 현재 담당자 정보로 갱신했습니다.');
      if (!shared) await load();
      onRefreshed?.();   // 공유 모드: 상위가 상세를 다시 조회하면 새 수신자 값이 내려온다
    } finally { setBusy(false); }
  };

  // 같은 담당자일 때만 갱신이 기존 고정값을 유지한다(다른 담당자면 전부 현재 값으로 바뀜 — 서버 recipient-refresh 규칙)
  const samePerson = !cmp.diffs.some(d => d.key === 'customerContactName');
  const missing = samePerson ? cmp.diffs.filter(d => d.liveMissing) : [];
  return (
    <div data-testid="quote-recipient-refresh" style={barStyle}>
      <div style={{ flex: 1, minWidth: 0, lineHeight: 1.6 }}>
        <div style={{ fontWeight: 700, color: '#92400e' }}>견적서 수신자 정보가 현재 담당자 정보와 다릅니다 ({cmp.diffs.map(d => d.label).join('·')})</div>
        <div style={{ color: '#374151' }}>견적서 출력(고정): <b data-testid="quote-recipient-fixed">{summary(view.fixed)}</b></div>
        <div style={{ color: '#374151' }}>현재 담당자: <b data-testid="quote-recipient-live">{summary(view.live!)}</b></div>
        {missing.length > 0 && (
          <div data-testid="quote-recipient-live-missing" style={{ color: '#6b7280', fontSize: 12 }}>
            현재 담당자 정보에 {missing.map(d => d.label).join('·')} 값이 없습니다 — 갱신해도 기존 값이 유지되므로 담당자 정보에서 보완해 주세요.
          </div>
        )}
      </div>
      {cmp.refreshable && (
        <GhostBtn onClick={refresh} disabled={busy} data-testid="btn-quote-recipient-refresh" aria-label="담당자 정보 갱신"
          style={{ whiteSpace: 'nowrap', fontSize: 12, padding: '6px 12px' }}>{busy ? '갱신 중…' : '담당자 정보 갱신'}</GhostBtn>
      )}
    </div>
  );
}
