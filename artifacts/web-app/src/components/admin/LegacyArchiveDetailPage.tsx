// ─── Legacy Archive 상세 (C-4B) — 완전 READ-ONLY ─────────────────────────────
// sales_list / progress 공용. 상단 normalized 요약 + 하단 CRM 원본정보(source_raw 전체).
// 수정/삭제/판매전환/배정/정산/입금처리/workflow/Master 생성·mapping 없음.
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/constants';
import { formatAmountDisplay } from '../../lib/utils';
import { BackToListButton } from './BackToListButton';

// (C-4J-2C-7) 판매건에 연결된 통번역 진행관리 수행행(READ-ONLY). 매핑 테이블 조회 결과. 원본값 그대로.
type LinkedProgress = {
  progressRowId: number; sourceRow: number | null;
  translatorName: string | null; language: string | null; productName: string | null;
  recordDate: string | null; deliveryDate: string | null; payoutDate: string | null; payoutPretax: string | null;
  sourceRaw: Record<string, unknown>; matchMethod: string | null; matchKey: string | null;
};

type ArchiveRow = {
  id: number; sourceType: 'sales_list' | 'progress'; sourceSystem: string;
  recordDate: string | null; companyName: string | null; contactName: string | null;
  translatorName: string | null; productName: string | null; language: string | null;
  supplyAmount: string | null; vatAmount: string | null; totalAmount: string | null; payoutPretax: string | null;
  deliveryDate: string | null; payoutDate: string | null; collectionDate: string | null; collectionStatus: string | null;
  sourceFile: string | null; sourceSheet: string | null; sourceRow: number | null;
  importBatchId: number | null; sourceRaw: Record<string, unknown>; createdAt: string;
  linkedProgress?: LinkedProgress[];
};

// (C-4J-2C-15) 주민등록번호 기본 마스킹(표시 전용). 생년월일 6자리만 노출, 뒤 7자리 마스킹.
//   원문 노출은 별도 권한처리 영역 — 현재 화면은 항상 마스킹한다(원본 DB 값은 불변).
function maskRRN(v: unknown): string {
  if (v == null) return '-';
  const s = String(v).trim();
  if (!s) return '-';
  const m = s.match(/^(\d{6})[-\s]?\d{7}$/);
  if (m) return `${m[1]}-*******`;
  return s.replace(/\d/g, '*');   // 기타 형식: 숫자 전부 마스킹
}

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
  // (C-4J-2C-8) 금액은 천단위 콤마 표시(표시 전용 — 원본값/계산/다운로드 데이터 불변).
  const salesFields: [string, string | null][] = row ? [
    ['판매일', row.recordDate], ['거래처', row.companyName], ['담당자/고객', row.contactName],
    ['상품명', row.productName], ['공급가', formatAmountDisplay(row.supplyAmount) || null], ['VAT', formatAmountDisplay(row.vatAmount) || null],
    // (C-4J-2C-14) 입금일(원본 입금일 normalized) + 입금내역(원문 보존, 상태 변환 없음). 값 없으면 '-'.
    ['총액', formatAmountDisplay(row.totalAmount) || null], ['입금일', row.collectionDate],
    ['입금내역', typeof row.sourceRaw?.['입금내역'] === 'string' ? (row.sourceRaw['입금내역'] as string) : null],
  ] : [];
  const progressFields: [string, string | null][] = row ? [
    ['일자', row.recordDate], ['거래처', row.companyName], ['담당자/고객', row.contactName],
    ['상품', row.productName], ['통번역사', row.translatorName], ['언어', row.language],
    ['납품일', row.deliveryDate], ['지급일', row.payoutDate], ['지급액(세전)', formatAmountDisplay(row.payoutPretax) || null],
  ] : [];
  const fields = isSales ? salesFields : progressFields;

  const card: React.CSSProperties = { border: '1px solid #e5e7eb', borderRadius: 10, padding: 20, background: '#fff', marginBottom: 16 };

  return (
    <div style={{ width: '94%', maxWidth: 2000, margin: '0 auto', padding: '24px 0' }} data-testid="legacy-archive-detail">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        {/* (C-4J-2C-10) 통번역사 상세화면과 동일한 공통 '〈 뒤로가기' 버튼 재사용(BackToListButton subtle). 복귀 동작(onBack)은 기존 그대로. */}
        <BackToListButton onClick={onBack} variant="subtle" label="뒤로가기" testId="archive-detail-back" />
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

          {/* (C-4J-2C-7) 통번역사 수행정보 — 판매건에 연결된 progress 수행행(READ-ONLY, 매핑 테이블 조회) */}
          {isSales && (() => {
            const links = row.linkedProgress ?? [];
            const d = (v: unknown) => (v === null || v === undefined || v === '' ? '-' : String(v));
            return (
              <div style={card} data-testid="archive-detail-performance">
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: '#111827' }}>통번역사 수행정보</div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>연결된 수행행 {links.length}건 · 원본값 그대로</div>
                </div>
                {links.length === 0 ? (
                  <div style={{ padding: '14px 12px', borderRadius: 8, background: '#f9fafb', border: '1px dashed #d1d5db', color: '#6b7280', fontSize: 13 }} data-testid="archive-detail-performance-empty">
                    연결된 통번역사 수행정보 없음
                  </div>
                ) : (
                  // 화면이 좁을 때만(=minWidth 미만) 가로 스크롤. 넓을 땐 카드 100% 폭으로 균형 배분.
                  <div style={{ overflowX: 'auto', width: '100%' }}>
                    {/* 열: 통번역사 | 주민번호 | 상세정보 | 상품/내용 | 파일명 | 납품일 | 지급일 | 지급액(세전) | 지급액(세후) */}
                    <table style={{ width: '100%', minWidth: 1080, tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 12.5 }}>
                      <thead>
                        <tr style={{ background: '#f3f4f6', textAlign: 'left' }}>
                          {([['통번역사', '11%'], ['주민번호', '10%'], ['상세정보', '16%'], ['상품/내용', '19%'], ['파일명', '16%'], ['납품일', '7%'], ['지급일', '7%'], ['지급액(세전)', '7%'], ['지급액(세후)', '7%']] as [string, string][]).map(([h, w]) => (
                            <th key={h} style={{ width: w, padding: '8px', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {links.map((lp, i) => {
                          const raw = (k: string) => { const v = lp.sourceRaw?.[k]; return v == null ? null : (typeof v === 'string' ? v : String(v)); };
                          const nae = raw('내용');
                          return (
                          <tr key={lp.progressRowId} data-testid={`archive-detail-performance-row-${lp.progressRowId}`}
                              style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 ? '#fafafa' : '#fff' }}>
                            <td style={{ padding: '8px', fontWeight: 700, wordBreak: 'break-word' }}>{d(lp.translatorName)}</td>
                            <td style={{ padding: '8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontVariantNumeric: 'tabular-nums' }} data-testid="perf-rrn">{maskRRN(raw('주민등록번호'))}</td>
                            <td style={{ padding: '8px', wordBreak: 'break-word' }} title={raw('상세정보') ?? undefined}>{d(raw('상세정보'))}</td>
                            <td style={{ padding: '8px', wordBreak: 'break-word' }}>{d(lp.productName ?? raw('상품명'))}{nae ? <span style={{ color: '#6b7280' }}> · {nae}</span> : null}</td>
                            <td style={{ padding: '8px', wordBreak: 'break-word', color: '#374151' }} title={raw('파일명') ?? undefined}>{d(raw('파일명'))}</td>
                            <td style={{ padding: '8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d(lp.deliveryDate)}</td>
                            <td style={{ padding: '8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d(lp.payoutDate)}</td>
                            <td style={{ padding: '8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'right' }}>{formatAmountDisplay(lp.payoutPretax) || '-'}</td>
                            <td style={{ padding: '8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'right' }}>{formatAmountDisplay(raw('지금액(세후)')) || '-'}</td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <div style={{ marginTop: 6, fontSize: 11.5, color: '#9ca3af' }}>과거 CRM 진행관리표 원본 수행행을 그대로 표시합니다(병합·추정 없음). 주민번호는 마스킹 표시이며, 지급액은 판매금액과 별개인 통번역사 지급금액(세후는 원본값, 미보유 시 '-')입니다.</div>
                  </div>
                )}
              </div>
            );
          })()}

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
