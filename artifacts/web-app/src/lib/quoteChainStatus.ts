// ─── 견적 리비전 체인(원견적·변경견적) 표시 상태 — 화면 표시 전용 SSOT ─────────────────
//  견적서 목록 · 견적 상세 · 관련 견적(Version) 이력이 모두 이 함수 하나로 상태명을 정한다.
//  DB status / is_current / 판매 연결은 변경하지 않으며, 판매 여부(status='approved')만으로 현재유효를 판단하지 않는다.
//   · 삭제        : deletedAt 존재 → 'deleted' (기존 삭제 처리 화면 유지)
//   · 거절        : status='rejected'
//   · 승인대기    : 변경견적(revision) + status='pending' (판매취소로 대기 복귀한 현재유효 변경견적 포함 — 재승인 필요)
//                   단, 현재유효보다 낮은 버전의 대기 변경견적은 과거본(chainStatusMap 에서 family 기준 판정)
//   · 현재유효    : is_current=true
//   · 과거본      : 그 외(승인 후 다른 견적으로 대체된 원견적·변경견적)
//  분할(derived)·추가(additional) 견적은 체인 구성원이 아니므로 null(기존 표시 유지).

export type QuoteChainStatus = 'current' | 'pending_revision' | 'superseded' | 'rejected' | 'deleted';

export type QuoteChainLike = {
  relationType?: string | null;
  status?: string | null;
  isCurrent?: boolean | null;
  deletedAt?: string | Date | null;
};

export function isRevisionChainMember(q: QuoteChainLike): boolean {
  return q.relationType == null || q.relationType === 'revision';
}

export function quoteChainStatus(q: QuoteChainLike): QuoteChainStatus | null {
  if (!isRevisionChainMember(q)) return null;
  if (q.deletedAt) return 'deleted';
  if (q.status === 'rejected') return 'rejected';
  if (q.relationType === 'revision' && q.status === 'pending') return 'pending_revision';
  if (q.isCurrent === true) return 'current';
  return 'superseded';
}

export const QUOTE_CHAIN_STATUS_LABEL: Record<QuoteChainStatus, string> = {
  current: '현재유효',
  pending_revision: '승인대기',
  superseded: '과거본',
  rejected: '거절',
  deleted: '삭제',
};

export const QUOTE_CHAIN_STATUS_COLOR: Record<QuoteChainStatus, { bg: string; color: string }> = {
  current:          { bg: '#dcfce7', color: '#15803d' },
  pending_revision: { bg: '#fef9c3', color: '#854d0e' },
  superseded:       { bg: '#f3f4f6', color: '#6b7280' },
  rejected:         { bg: '#fee2e2', color: '#dc2626' },
  deleted:          { bg: '#f3f4f6', color: '#9ca3af' },
};

export const QUOTE_CHAIN_STATUS_TITLE: Record<QuoteChainStatus, string> = {
  current: '현재 유효한 견적입니다. 다음 변경견적은 이 견적에서 생성합니다.',
  pending_revision: '승인대기 변경견적입니다. [변경견적 승인] 또는 [거절]로 확정합니다.',
  superseded: '승인된 다른 견적으로 대체된 과거본입니다. 조회·PDF 출력만 가능하며 변경견적 생성 기준으로 사용할 수 없습니다.',
  rejected: '거절된 변경견적입니다.',
  deleted: '삭제된 견적입니다.',
};

// family 단위 판정 — 서버 resolveChainCurrent 와 같은 규칙으로 '유효본 공백'을 보정한다.
//  (변경견적 승인 → 판매취소 → 거절/삭제로 체인에 is_current 가 하나도 없을 때, 미삭제·미거절·비대기 최신 버전을 현재유효로 표시.
//   family API 가 화면에 내려주는 값과 동일. DB 는 바꾸지 않는다.)
export function chainStatusMap<T extends QuoteChainLike & { id: number; version?: number | null }>(family: T[]): Map<number, QuoteChainStatus> {
  const chain = family.filter(q => isRevisionChainMember(q) && !q.deletedAt);
  let restoredId: number | null = null;
  if (!chain.some(q => q.isCurrent === true)) {
    const cand = chain
      .filter(q => q.status !== 'rejected' && !(q.relationType === 'revision' && q.status === 'pending'))
      .sort((a, b) => Number(b.version ?? 0) - Number(a.version ?? 0) || b.id - a.id)[0];
    restoredId = cand?.id ?? null;
  }
  // 현재유효 견적보다 낮은 버전의 '대기' 변경견적 = 과거본(판매취소로 approved→pending 복귀한 대체본). 서버 isSupersededPendingRevision 과 동일.
  const cur = chain.find(q => q.isCurrent === true) ?? (restoredId != null ? chain.find(q => q.id === restoredId) : undefined);
  const out = new Map<number, QuoteChainStatus>();
  for (const q of family) {
    let s = quoteChainStatus(restoredId === q.id ? { ...q, isCurrent: true } : q);
    if (s === 'pending_revision' && cur && cur.id !== q.id && Number(cur.version ?? 0) > Number(q.version ?? 0)) s = 'superseded';
    if (s) out.set(q.id, s);
  }
  return out;
}
