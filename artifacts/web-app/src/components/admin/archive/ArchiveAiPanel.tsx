/**
 * AI 지식관리 — Phase 3 기반 기능만 실제 동작. 미구현 기능은 명확히 '미구현'으로 표시한다.
 * 근거 검색: 요청자 권한 + AI 허용 + 최신 승인본만 대상(서버 강제). 외부 AI API 호출 없음.
 */
import React, { useEffect, useState } from 'react';
import { S, badgeStyle, type ArchiveApi } from './archiveApi';

const FEATURES: Array<[string, string]> = [
  ['textExtraction', '문서 본문 추출(검색용 텍스트 별도 보관)'], ['keywordRetrieval', '권한 필터 근거 검색(키워드)'], ['citations', '근거 문서·버전 표시'],
  ['semanticSearch', '의미 기반(임베딩) 검색'], ['aiSummary', 'AI 요약'], ['autoClassification', '문서 유형 자동 분류'],
  ['revisionSuggestion', '중복·오래된 자료 감지 / 개정 제안'], ['aiWorkforceAgents', 'AI 직원별 지식 접근 범위(영업·운영·인사·재무·법무·경영 AI)'],
];

export function ArchiveAiPanel({ api, onOpen }: { api: ArchiveApi; onOpen: (id: number) => void }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [features, setFeatures] = useState<Record<string, boolean> | null>(null);
  useEffect(() => { api.get('/archive/stats').then(s => setFeatures(s.ai.features)).catch(() => {}); }, [api]);

  const search = async (e: React.FormEvent) => {
    e.preventDefault(); setLoading(true); setErr('');
    try { const r = await api.post('/archive/knowledge/search', { q }); setRes(r); if (r.features) setFeatures(r.features); }
    catch (e2: any) { setErr(e2.message); setRes(null); }
    finally { setLoading(false); }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(360px, 2fr) minmax(260px, 1fr)', gap: 16, alignItems: 'start' }}>
      <div style={S.card}>
        <h2 style={S.h2}>AI 지식 검색 <span style={{ ...S.muted, fontWeight: 400 }}>(근거 기반 · 권한 필터)</span></h2>
        <form onSubmit={search} style={{ display: 'flex', gap: 8 }}>
          <input style={{ ...S.input, flex: 1 }} value={q} onChange={e => setQ(e.target.value)} placeholder="예: 재직증명서 발급 절차, 번역 납품 기준" aria-label="AI 지식 검색어" data-testid="archive-ai-q" />
          <button type="submit" style={S.btnPrimary} disabled={q.trim().length < 2 || loading} data-testid="archive-ai-search" aria-label="지식 검색">{loading ? '검색 중…' : '검색'}</button>
        </form>
        <div style={{ ...S.muted, marginTop: 6 }}>
          검색 대상: 내가 열람 권한을 가진 자료 중 <b>AI 활용 허용</b> + <b>최신 승인본</b>만. 초안·검토중·폐기·삭제 자료는 제외됩니다. 현재는 키워드 검색이며 AI 답변 생성은 하지 않습니다.
        </div>
        {err && <div style={{ color: '#b91c1c', marginTop: 10 }}>{err}</div>}
        {res && (
          <div style={{ marginTop: 14 }}>
            <div style={{ ...S.muted, marginBottom: 6 }}>검색 가능 자료 {res.eligibleCount}건 중 {res.results.length}건 · 방식: {res.mode === 'keyword' ? '키워드' : res.mode}</div>
            {res.results.length === 0 && <div style={{ ...S.muted, padding: 16, textAlign: 'center' }}>근거 자료를 찾지 못했습니다.</div>}
            {res.results.map((r: any) => (
              <div key={r.versionId} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, marginBottom: 8 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button type="button" onClick={() => onOpen(r.documentId)} data-testid={`archive-ai-open-${r.documentId}`} aria-label={`${r.title} 근거 자료 열기`}
                    style={{ border: 0, background: 'none', color: '#1d4ed8', fontWeight: 700, cursor: 'pointer', padding: 0, fontSize: 13 }}>📄 {r.title}</button>
                  <span style={badgeStyle('#059669')}>승인본 v{r.versionNo}</span>
                  <span style={S.muted}>{r.folderPath}</span>
                </div>
                <div style={{ fontSize: 12, color: '#374151', marginTop: 6, lineHeight: 1.6 }}>…{r.snippet}…</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={S.card}>
        <h2 style={S.h2}>구현 현황</h2>
        {FEATURES.map(([k, label]) => {
          const on = features?.[k];
          return (
            <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '5px 0', borderBottom: '1px solid #f3f4f6', fontSize: 12 }}>
              <span style={badgeStyle(on ? '#059669' : '#9ca3af')}>{on ? '사용 중' : '미구현'}</span>
              <span>{label}</span>
            </div>
          );
        })}
        <div style={{ ...S.muted, marginTop: 10 }}>
          미구현 항목은 유료 AI API 사용 승인과 AI 직원(에이전트) 신원·권한 체계 구축 후 활성화됩니다. AI 직원은 승인 요청·초안 작성까지만 가능하며 승인 권한을 가질 수 없도록 설계되어 있습니다.
        </div>
      </div>
    </div>
  );
}
