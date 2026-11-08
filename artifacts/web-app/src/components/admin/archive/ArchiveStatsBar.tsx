/**
 * 전체 자료 상단 통계(구 '자료 현황' 통합) — 핵심 4개 지표를 한 줄로, 상세 통계는 접기/펼치기(기존 ArchiveOverview 재사용).
 * 검색·필터·폴더·목록이 밀리지 않도록 기본은 접힘. 통계 API(/archive/stats)는 기존 그대로.
 */
import React, { useEffect, useState } from 'react';
import { S, type ArchiveApi, type ArchiveMe } from './archiveApi';
import { ArchiveOverview } from './ArchiveOverview';

const OPEN_KEY = 'archiveStatsOpen';

export function ArchiveStatsBar({ api, me, refreshKey, onNavigate, onOpen }: {
  api: ArchiveApi; me: ArchiveMe; refreshKey: number; onNavigate: (view: string) => void; onOpen: (id: number) => void;
}) {
  const [s, setS] = useState<any>(null);
  const [open, setOpen] = useState<boolean>(() => { try { return sessionStorage.getItem(OPEN_KEY) === '1'; } catch { return false; } });
  useEffect(() => { api.get('/archive/stats').then(setS).catch(() => setS(null)); }, [api, refreshKey]);
  const toggle = () => setOpen(o => { try { sessionStorage.setItem(OPEN_KEY, o ? '0' : '1'); } catch { /* 무시 */ } return !o; });
  const canApprovals = me.canApprove || me.isArchiveAdmin;

  const chip = (label: string, value: number | undefined, testId: string, color: string, onClick?: () => void) => {
    const body = <><span style={{ color: '#6b7280' }}>{label}</span> <b style={{ color, fontSize: 15, marginLeft: 4 }}>{value ?? '—'}</b></>;
    const st: React.CSSProperties = { display: 'inline-flex', alignItems: 'baseline', gap: 2, padding: '5px 12px', border: '1px solid #e5e7eb', borderRadius: 999, background: '#fff', fontSize: 12 };
    return onClick
      ? <button key={testId} type="button" onClick={onClick} data-testid={testId} aria-label={`${label} ${value ?? 0}건`} style={{ ...st, cursor: 'pointer' }}>{body}</button>
      : <span key={testId} data-testid={testId} style={st}>{body}</span>;
  };

  return (
    <div style={{ marginBottom: 10 }} data-testid="archive-stats-bar">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {chip('전체 자료', s?.total, 'archive-stat-total', '#111827')}
        {/* 승인 대기: 승인권자는 자료 관리설정 › 승인 관리로 이동, 일반 직원은 본인 요청 건수 표시만 */}
        {chip('승인 대기', s?.pendingApprovals, 'archive-stat-pending', '#d97706', canApprovals ? () => onNavigate('approvals') : undefined)}
        {chip('검토 필요', s?.reviewNeededCount, 'archive-stat-review', '#7c3aed')}
        {chip('AI 분석 진행 중', s ? (s.ai?.byStatus?.analyzing ?? 0) : undefined, 'archive-stat-analyzing', '#2563eb')}
        <button type="button" onClick={toggle} data-testid="archive-stats-toggle" aria-label={open ? '상세 통계 접기' : '상세 통계 펼치기'} aria-expanded={open}
          style={{ ...S.btn, marginLeft: 'auto', fontSize: 12 }}>{open ? '상세 통계 접기 ▲' : '상세 통계 ▼'}</button>
      </div>
      {open && <div style={{ marginTop: 10 }} data-testid="archive-stats-detail"><ArchiveOverview api={api} onOpen={onOpen} onNavigate={onNavigate} refreshKey={refreshKey} /></div>}
    </div>
  );
}
