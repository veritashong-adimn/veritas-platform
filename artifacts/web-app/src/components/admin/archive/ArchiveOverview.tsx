/** 자료 현황 대시보드 — 서버가 사용자 권한 범위로 집계(관리자는 전체 관리 현황) */
import React, { useEffect, useState } from 'react';
import { STATUS_COLOR, STATUS_LABEL, S, badgeStyle, fmtDate, fmtSize, type ArchiveApi } from './archiveApi';

export function ArchiveOverview({ api, onOpen, onNavigate, refreshKey }: {
  api: ArchiveApi; onOpen: (id: number) => void; onNavigate: (view: string) => void; refreshKey: number;
}) {
  const [s, setS] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.get('/archive/stats').then(setS).catch(e => setErr(e.message)); }, [api, refreshKey]);
  if (err) return <div style={{ ...S.card, color: '#b91c1c' }}>{err}</div>;
  if (!s) return <div style={S.card}>불러오는 중…</div>;

  const tile = (label: string, value: React.ReactNode, sub?: string, onClick?: () => void, testId?: string) => {
    const body = (
      <>
        <div style={S.muted}>{label}</div>
        <div style={{ fontSize: 24, fontWeight: 700, color: '#111827', marginTop: 4 }}>{value}</div>
        {sub && <div style={{ ...S.muted, marginTop: 2 }}>{sub}</div>}
      </>
    );
    return onClick
      ? <button type="button" onClick={onClick} data-testid={testId} aria-label={label} style={{ ...S.card, textAlign: 'left', cursor: 'pointer', minWidth: 0 }}>{body}</button>
      : <div style={{ ...S.card, minWidth: 0 }}>{body}</div>;
  };
  const list = (title: string, rows: any[], extra?: (r: any) => React.ReactNode) => (
    <div style={S.card}>
      <h3 style={{ ...S.h2, fontSize: 14 }}>{title}</h3>
      {rows.length === 0 && <div style={S.muted}>없음</div>}
      {rows.map(r => (
        <button key={r.id} type="button" onClick={() => onOpen(r.id)} data-testid={`archive-overview-open-${title}-${r.id}`} aria-label={`${r.title} 열기`}
          style={{ display: 'flex', width: '100%', gap: 8, alignItems: 'center', padding: '6px 0', border: 0, borderBottom: '1px solid #f3f4f6', background: 'none', cursor: 'pointer', textAlign: 'left' }}>
          <span style={{ flex: 1, fontSize: 13, color: '#1d4ed8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
          <span style={badgeStyle(STATUS_COLOR[r.status] ?? '#6b7280')}>{STATUS_LABEL[r.status] ?? r.status}</span>
          <span style={{ ...S.muted, whiteSpace: 'nowrap' }}>{extra ? extra(r) : fmtDate(r.updatedAt)}</span>
        </button>
      ))}
    </div>
  );
  const aiStatus = s.ai.byStatus as Record<string, number>;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {s.scope === 'user' && <div style={{ ...S.muted }}>※ 열람 권한이 있는 자료만 집계됩니다.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        {tile('전체 자료', s.total, undefined, () => onNavigate('all'), 'archive-overview-total')}
        {tile('승인 대기', s.pendingApprovals, '처리 가능·본인 요청', () => onNavigate('approvals'), 'archive-overview-pending')}
        {tile('검토 필요', s.reviewNeededCount, '초안·검토중·개정중')}
        {tile('만료 예정(30일)', s.expiringCount, '만료일·보존기한 기준')}
        {tile('AI 활용 가능', s.ai.eligible, '승인본·AI 허용 자료', () => onNavigate('ai'), 'archive-overview-ai')}
        {tile('저장공간', fmtSize(s.storage.bytes), `${s.storage.versions}개 버전 · ${s.storage.scope === 'all' ? '전체' : '열람 범위'}`)}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
        <div style={S.card}>
          <h3 style={{ ...S.h2, fontSize: 14 }}>분류별 자료 수</h3>
          {s.byCategory.length === 0 && <div style={S.muted}>없음</div>}
          {s.byCategory.map((c: any) => {
            const max = Math.max(...s.byCategory.map((x: any) => x.count), 1);
            return (
              <div key={c.folderId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 13 }}>
                <span style={{ width: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                <div style={{ flex: 1, background: '#f3f4f6', borderRadius: 4, height: 10 }}><div style={{ width: `${(c.count / max) * 100}%`, background: '#0ea5e9', height: 10, borderRadius: 4 }} /></div>
                <span style={{ width: 36, textAlign: 'right', fontWeight: 600 }}>{c.count}</span>
              </div>
            );
          })}
        </div>
        <div style={S.card}>
          <h3 style={{ ...S.h2, fontSize: 14 }}>AI 분석 처리 현황</h3>
          {[['classified', '자동 분류 완료'], ['analyzing', '분석 중'], ['needs_review', '분류 확인 필요'], ['failed', '분석 실패'], ['extracted', '본문 추출(기존 등록)'], ['empty', '본문 없음'], ['skipped', '추출 대상 아님'], ['none', '미처리']].map(([k, l]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}><span>{l}</span><b>{aiStatus[k] ?? 0}</b></div>
          ))}
          <div style={{ ...S.muted, marginTop: 8 }}>등록 시 AI가 유형·폴더·요약·키워드를 자동 정리합니다. 이미지 OCR은 사용하지 않습니다.</div>
        </div>
        {s.admin && (
          <div style={S.card}>
            <h3 style={{ ...S.h2, fontSize: 14 }}>관리 현황(관리자)</h3>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}><span>폴더 수</span><b>{s.admin.totalFolders}</b></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}><span>권한 설정 항목</span><b>{s.admin.aclEntries}</b></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}><span>휴지통 자료</span><b>{s.admin.trashCount}</b></div>
            {Object.entries(s.byStatus as Record<string, number>).map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}><span>상태: {STATUS_LABEL[k] ?? k}</span><b>{v}</b></div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
        {list('최근 등록 자료', s.recentCreated, r => fmtDate(r.createdAt))}
        {list('최근 수정 자료', s.recentUpdated)}
        {list('검토 필요 자료', s.reviewNeeded)}
        {list('만료 예정 자료', s.expiring, r => fmtDate(r.expiresAt ?? r.retentionUntil))}
      </div>
    </div>
  );
}
