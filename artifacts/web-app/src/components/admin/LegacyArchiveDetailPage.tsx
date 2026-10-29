// ─── Legacy Archive 상세 (C-4B) ───────────────────────────────────────────────
// sales_list / progress 공용. 상단 normalized 요약 + 하단 CRM 원본정보(source_raw 전체). 원본은 항상 조회 전용.
// 판매건은 [수정] → 운영 판매건 전환(미리보기·확인) 후 운영 판매 상세에서 수정한다(원본 불변).
import React, { useEffect, useState } from 'react';
import { SaleContactInfoPanel, type ContactInfo } from './SaleContactInfoPanel';
import { api } from '../../lib/constants';
import { formatAmountDisplay } from '../../lib/utils';
import { BackToListButton } from './BackToListButton';
import { LegacySaleActivationModal } from './LegacySaleActivationModal';

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
  linkedContactName?: string | null;
  contactReviewNeeded?: boolean;      // 고객 담당자 확인 필요(후보 복수)   // 판매번호에 연결된 고객 담당자 Master(수동 보완·정확 일치 자동 연결)
  translatorName: string | null; productName: string | null; language: string | null;
  supplyAmount: string | null; vatAmount: string | null; totalAmount: string | null; payoutPretax: string | null;
  deliveryDate: string | null; payoutDate: string | null; collectionDate: string | null; collectionStatus: string | null;
  sourceFile: string | null; sourceSheet: string | null; sourceRow: number | null;
  importBatchId: number | null; sourceRaw: Record<string, unknown>; createdAt: string;
  linkedProgress?: LinkedProgress[];
  activation?: { projectId: number; status: string | null } | null;   // 운영 판매건 전환 여부(판매번호 매핑)
};

// (C-4J-2C-15) 주민등록번호 표시(표시 전용). 서버가 '생년월일 6자리-뒷자리 첫 숫자******'로 마스킹해 보낸 값을 그대로 표시한다.
//   서버 마스킹 형식이 아닌 값은 방어적으로 같은 형식으로 마스킹(원본 DB 값은 불변).
function maskRRN(v: unknown): string {
  if (v == null) return '-';
  const s = String(v).trim();
  if (!s) return '-';
  if (/^(\d{6}|\*{6})-(\d|\*)\*{6}$/.test(s)) return s;   // 서버 마스킹 결과
  const m = s.match(/^(\d{6})[-\s]?(\d)\d{6}$/);
  if (m) return `${m[1]}-${m[2]}******`;
  return s.replace(/\d/g, '*');   // 기타 형식: 숫자 전부 마스킹
}

// JSON primitive 안전 렌더(string/number/boolean/null + 예상외 값). 빈문자열과 null 구분.
function renderRawValue(v: unknown): { text: string; muted: boolean } {
  if (v === null || v === undefined) return { text: '(null)', muted: true };
  if (typeof v === 'string') return v === '' ? { text: '(빈 문자열)', muted: true } : { text: v, muted: false };
  if (typeof v === 'number' || typeof v === 'boolean') return { text: String(v), muted: false };
  try { return { text: JSON.stringify(v), muted: false }; } catch { return { text: String(v), muted: false }; }
}

export function LegacyArchiveDetailPage({ id, token, onBack, setToast, onOpenSale }: { id: number; token: string; onBack: () => void; setToast: (m: string) => void; onOpenSale?: (projectId: number) => void }) {
  const [row, setRow] = useState<ArchiveRow | null>(null);
  const [showActivate, setShowActivate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // 고객 담당자 연락처(출처 구분) — 담당자 보완 창과 같은 API(/admin/sales-contact/context)
  const [contactCtx, setContactCtx] = useState<{ company: { name: string } | null; rawCompanyName: string | null; contactInfo: ContactInfo | null } | null>(null);
  useEffect(() => {
    if (row?.sourceType !== 'sales_list') return;
    fetch(api(`/api/admin/sales-contact/context?source=legacy&id=${id}`), { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null).then(setContactCtx).catch(() => setContactCtx(null));
  }, [row?.sourceType, id, token]);

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

  // 판매일(표시 전용) — 판매관리 목록(sales-history)과 동일 규칙: recordDate → 판매번호 앞 날짜 → 세금계산서발행(예정)일.
  const dateOf = (v: unknown) => (typeof v === 'string' ? (v.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null) : null);
  // 고객담당자(거래처 측) — 판매목록 원본에는 고객담당자 칸이 없다(정규화 contactName 은 내부 '영업담당자'). 판매관리 목록과 동일하게
  //   연결 진행행 '고객명'이 단일일 때만 표시하고, 없거나 여러 명이면 '-'. 내부 담당PM 이름으로 대체하지 않는다.
  //   표시 우선순위(목록과 동일): ① 연결된 담당자 Master ② 진행관리표 복원 고객명(미연결) ③ 없음. 무효값(문자 없음·전화번호 형태)·영업담당자 이름 제외.
  const salesRep = String(row?.sourceRaw?.['영업담당자'] ?? '').replace(/\s/g, '');
  const custNames = row ? [...new Set((row.linkedProgress ?? []).map(lp => String(lp.sourceRaw?.['고객명'] ?? '').trim())
    .filter(n => n && /[가-힣A-Za-z]/.test(n) && n.replace(/\D/g, '').length < 7 && n.replace(/\s/g, '') !== salesRep))] : [];
  const customerContact = row?.linkedContactName ? row.linkedContactName
    : custNames.length === 1 ? `${custNames[0]} (미연결)` : (custNames.length > 1 || row?.contactReviewNeeded) ? '확인 필요' : null;
  const saleDate = row ? (dateOf(row.recordDate) ?? dateOf(row.sourceRaw?.['판매번호']) ?? dateOf(row.sourceRaw?.['세금계산서발행(예정)일'])) : null;

  // source_type별 상단 normalized 요약(값 있는 것만 의미있게, 없으면 "-").
  // (C-4J-2C-8) 금액은 천단위 콤마 표시(표시 전용 — 원본값/계산/다운로드 데이터 불변).
  const salesFields: [string, string | null][] = row ? [
    // 첫 줄: 상품명 · 판매일 · 담당자/고객 (거래처명은 상단 제목으로 이동)
    ['상품명', row.productName], ['판매일', saleDate], ['담당자/고객', customerContact],
    ['공급가', formatAmountDisplay(row.supplyAmount) || null], ['VAT', formatAmountDisplay(row.vatAmount) || null],
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
      {showActivate && onOpenSale && (
        <LegacySaleActivationModal legacyRowId={id} token={token} onToast={setToast}
          onClose={() => setShowActivate(false)}
          onActivated={(pid) => { setShowActivate(false); onOpenSale(pid); }} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        {/* (C-4J-2C-10) 통번역사 상세화면과 동일한 공통 '〈 뒤로가기' 버튼 재사용(BackToListButton subtle). 복귀 동작(onBack)은 기존 그대로. */}
        <BackToListButton onClick={onBack} variant="subtle" label="뒤로가기" testId="archive-detail-back" />
        <span style={{ padding: '4px 10px', borderRadius: 6, background: '#fef3c7', color: '#92400e', fontWeight: 800, fontSize: 12 }}>과거 CRM</span>
        {row?.sourceType === 'sales_list' && onOpenSale ? (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {row.activation && <span style={{ fontSize: 12, color: '#1e40af' }}>운영 판매건으로 전환됨</span>}
            <button type="button" onClick={() => row.activation ? onOpenSale(row.activation.projectId) : setShowActivate(true)}
              data-testid="archive-detail-edit" aria-label={row.activation ? '운영 판매 상세에서 수정' : '판매건 수정'}
              style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
              수정
            </button>
          </div>
        ) : (
          <span style={{ fontSize: 12, color: '#6b7280' }}>READ-ONLY · 조회 전용</span>
        )}
      </div>

      {loading && <div style={{ color: '#6b7280' }}>불러오는 중…</div>}
      {notFound && <div style={card} data-testid="archive-detail-notfound">해당 과거자료를 찾을 수 없습니다.</div>}

      {row && !loading && (
        <>
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <span style={{ padding: '3px 10px', borderRadius: 6, background: isSales ? '#dbeafe' : '#ede9fe', color: isSales ? '#1e40af' : '#5b21b6', fontWeight: 800, fontSize: 12 }}>{label}</span>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#111827' }} data-testid="archive-detail-title">{(isSales ? (row.companyName || row.productName) : (row.productName || row.companyName)) || `과거자료 #${row.id}`}</h2>
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

          {/* 고객 담당자 — 판매 당시 원본 연락처와 현재 담당자 Master 연락처를 구분해 표시(확인된 값만, 없으면 '-') */}
          {isSales && contactCtx?.contactInfo && (
            <div style={card} data-testid="archive-detail-contact">
              <div style={{ fontSize: 15, fontWeight: 800, color: '#111827', marginBottom: 10 }}>고객 담당자</div>
              <SaleContactInfoPanel companyName={contactCtx.company?.name ?? contactCtx.rawCompanyName} info={contactCtx.contactInfo} />
            </div>
          )}

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
