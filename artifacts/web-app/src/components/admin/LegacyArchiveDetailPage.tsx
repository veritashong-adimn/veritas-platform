// ─── Legacy Archive 상세 (C-4B) — 완전 READ-ONLY ─────────────────────────────
// sales_list / progress 공용. 상단 normalized 요약 + 하단 CRM 원본정보(source_raw 전체).
// 수정/삭제/판매전환/배정/정산/입금처리/workflow/Master 생성·mapping 없음.
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/constants';

type ArchiveRow = {
  id: number; sourceType: 'sales_list' | 'progress'; sourceSystem: string;
  recordDate: string | null; companyName: string | null; contactName: string | null;
  translatorName: string | null; productName: string | null; language: string | null;
  supplyAmount: string | null; vatAmount: string | null; totalAmount: string | null; payoutPretax: string | null;
  deliveryDate: string | null; payoutDate: string | null; collectionDate: string | null; collectionStatus: string | null;
  sourceFile: string | null; sourceSheet: string | null; sourceRow: number | null;
  importBatchId: number | null; sourceRaw: Record<string, unknown>; createdAt: string;
};

// JSON primitive 안전 렌더(string/number/boolean/null + 예상외 값). 빈문자열과 null 구분.
function renderRawValue(v: unknown): { text: string; muted: boolean } {
  if (v === null || v === undefined) return { text: '(null)', muted: true };
  if (typeof v === 'string') return v === '' ? { text: '(빈 문자열)', muted: true } : { text: v, muted: false };
  if (typeof v === 'number' || typeof v === 'boolean') return { text: String(v), muted: false };
  try { return { text: JSON.stringify(v), muted: false }; } catch { return { text: String(v), muted: false }; }
}

export function LegacyArchiveDetailPage({ id, token, onBack, setToast }: { id: number; token: string; onBack: () => void; setToast: (m: string) => void }) {
  const [row, setRow] = useState<ArchiveRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setNotFound(false);
      try {
        const res = await fetch(api(`/api/admin/legacy-archive/${id}`), { headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 404) { if (alive) setNotFound(true); return; }
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || '조회 실패');
        if (alive) setRow(data);
      } catch (e: any) { setToast(e?.message || '조회 실패'); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [id, token]);

  const isSales = row?.sourceType === 'sales_list';
  const label = isSales ? '판매' : '진행관리';

  // source_type별 상단 normalized 요약(값 있는 것만 의미있게, 없으면 "-").
  const salesFields: [string, string | null][] = row ? [
    ['판매일', row.recordDate], ['거래처', row.companyName], ['담당자/고객', row.contactName],
    ['상품명', row.productName], ['공급가', row.supplyAmount], ['VAT', row.vatAmount],
    ['총액', row.totalAmount], ['입금일', row.collectionDate], ['입금상태', row.collectionStatus],
  ] : [];
  const progressFields: [string, string | null][] = row ? [
    ['일자', row.recordDate], ['거래처', row.companyName], ['담당자/고객', row.contactName],
    ['상품', row.productName], ['통번역사', row.translatorName], ['언어', row.language],
    ['납품일', row.deliveryDate], ['지급일', row.payoutDate], ['지급액(세전)', row.payoutPretax],
  ] : [];
  const fields = isSales ? salesFields : progressFields;

  const card: React.CSSProperties = { border: '1px solid #e5e7eb', borderRadius: 10, padding: 20, background: '#fff', marginBottom: 16 };

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px 0' }} data-testid="legacy-archive-detail">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <button onClick={onBack} aria-label="목록으로" data-testid="archive-detail-back"
                style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontWeight: 700 }}>← 목록</button>
        <span style={{ padding: '4px 10px', borderRadius: 6, background: '#fef3c7', color: '#92400e', fontWeight: 800, fontSize: 12 }}>과거 CRM</span>
        <span style={{ fontSize: 12, color: '#6b7280' }}>READ-ONLY · 조회 전용</span>
      </div>

      {loading && <div style={{ color: '#6b7280' }}>불러오는 중…</div>}
      {notFound && <div style={card} data-testid="archive-detail-notfound">해당 과거자료를 찾을 수 없습니다.</div>}

      {row && !loading && (
        <>
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <span style={{ padding: '3px 10px', borderRadius: 6, background: isSales ? '#dbeafe' : '#ede9fe', color: isSales ? '#1e40af' : '#5b21b6', fontWeight: 800, fontSize: 12 }}>{label}</span>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#111827' }}>{row.productName || row.companyName || `과거자료 #${row.id}`}</h2>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              {fields.map(([k, v]) => (
                <div key={k} style={{ padding: '8px 10px', background: '#f9fafb', borderRadius: 8, border: '1px solid #f0f0f0' }}>
                  <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>{k}</div>
                  <div style={{ fontSize: 14, color: '#111827', fontWeight: 600, wordBreak: 'break-word' }}>{v != null && v !== '' ? v : '-'}</div>
                </div>
              ))}
            </div>
          </div>

          {/* CRM 원본정보 — source_raw 전체 */}
          <div style={card} data-testid="archive-detail-sourceraw">
            <div style={{ fontSize: 15, fontWeight: 800, color: '#111827', marginBottom: 12 }}>CRM 원본정보</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 6 }}>
              {Object.entries(row.sourceRaw || {}).map(([k, v]) => {
                const rv = renderRawValue(v);
                return (
                  <div key={k} style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 12, padding: '6px 8px', borderBottom: '1px solid #f3f4f6' }}>
                    <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 600, wordBreak: 'break-word' }}>{k}</div>
                    <div style={{ fontSize: 13, color: rv.muted ? '#9ca3af' : '#111827', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontStyle: rv.muted ? 'italic' : 'normal' }}>{rv.text}</div>
                  </div>
                );
              })}
              {Object.keys(row.sourceRaw || {}).length === 0 && <div style={{ color: '#9ca3af' }}>원본 필드 없음</div>}
            </div>
          </div>

          {/* Source 정보(원본 추적) */}
          <div style={card} data-testid="archive-detail-source">
            <div style={{ fontSize: 13, fontWeight: 800, color: '#374151', marginBottom: 10 }}>원본 출처</div>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12, color: '#4b5563' }}>
              <span>자료구분: <b>{label}</b></span>
              <span>원본 파일: <b>{row.sourceFile ?? '-'}</b></span>
              <span>Sheet: <b>{row.sourceSheet ?? '-'}</b></span>
              <span>원본 행: <b>{row.sourceRow ?? '-'}</b></span>
              <span>Import batch: <b>#{row.importBatchId ?? '-'}</b></span>
              <span>source_system: <b>{row.sourceSystem}</b></span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
