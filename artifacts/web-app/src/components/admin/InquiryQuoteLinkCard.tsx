/**
 * InquiryQuoteLinkCard — 의뢰건에서 [견적서 작성]으로 진입한 견적의 확인 패널(견적 작성 화면 상단).
 *
 * 네 영역으로 나눠, 정상 처리된 항목은 한 줄로 조용히 보여주고 확인이 필요한 항목만 강조한다.
 *  ① 고객정보·Master — 저장 시 처리(기존 연결 / 신규 등록 / 확인 필요)와 견적에 저장될 고객정보(스냅샷)
 *  ② 상품 매칭 — 의뢰건 조건(서비스·언어·통역 형태)으로 찾은 상품(자동 선택 / 후보 / 일치 없음)
 *  ③ 추가 언어 — 선택 사항 요청(상품 행 자동 추가 안 함)
 *  ④ 견적서 수령 희망일 — 견적일(작성일, KST)과 비교한 기한 상태(경과 / 오늘까지 / D-n). 저장은 막지 않는다.
 * 판정·등록은 서버가 저장 트랜잭션에서 한다. 이 패널은 Master 를 만들거나 수정하지 않는다.
 */
import React from 'react';
import type { QuoteInquiryContext, MatchableProduct } from '../../lib/inquiryHandoff';
import type { CustomerPlan, CustomerChoice, PlanPart } from './useInquiryCustomerPlan';

export interface InquiryProductMatch {
  itemIndex: number;
  label: string;                                   // 예: 통역 · 한국어 → 영어 · 순차통역
  status: 'auto' | 'choose' | 'none';
  autoProduct?: MatchableProduct | null;
  candidates: MatchableProduct[];
}

const box: React.CSSProperties = { border: '1px solid #e0e7ff', background: '#fafbff', borderRadius: 10, padding: '10px 14px', marginBottom: 14, fontSize: 12, color: '#1f2937' };
const sec: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', padding: '5px 0', borderTop: '1px dashed #e5e7eb' };
const head: React.CSSProperties = { fontWeight: 800, minWidth: 84, color: '#3730a3' };
const okS: React.CSSProperties = { color: '#065f46' };
const warnS: React.CSSProperties = { color: '#b45309', fontWeight: 700 };
const infoS: React.CSSProperties = { color: '#1d4ed8', fontWeight: 700 };
const btn: React.CSSProperties = { padding: '2px 9px', fontSize: 11, fontWeight: 700, color: '#fff', background: '#4f46e5', border: 'none', borderRadius: 6, cursor: 'pointer' };
const btnGhost: React.CSSProperties = { ...btn, color: '#4338ca', background: '#fff', border: '1px solid #c7d2fe' };

/** 수령 희망일 상태 — 날짜만 비교(시각을 붙이지 않음) */
export function dueStatus(due?: string | null, issueDate?: string | null): { kind: 'past' | 'today' | 'future'; label: string } | null {
  if (!due || !issueDate) return null;
  const d = Math.round((Date.parse(due.slice(0, 10)) - Date.parse(issueDate.slice(0, 10))) / 86_400_000);
  if (isNaN(d)) return null;
  if (d < 0) return { kind: 'past', label: `견적 요청 기한 경과 (${-d}일 지남)` };
  if (d === 0) return { kind: 'today', label: '오늘까지' };
  return { kind: 'future', label: `D-${d}` };
}

function PlanLine({ title, part, testid, linkedLabel, onPick, onCreate, onSkip, createLabel }: {
  title: string; part: PlanPart | undefined; testid: string; linkedLabel?: string;
  onPick: (id: number) => void; onCreate?: () => void; onSkip?: () => void; createLabel: string;
}) {
  if (!part) return <div style={sec} data-testid={testid}><span style={head}>{title}</span><span style={{ color: '#9ca3af' }}>확인 중…</span></div>;
  return (
    <div style={sec} data-testid={testid}>
      <span style={head}>{title}</span>
      {part.action === 'link' && <span style={okS}>✓ 기존 Master 연결: <b>{linkedLabel ?? part.name}</b> <span style={{ color: '#6b7280' }}>({part.reason})</span></span>}
      {part.action === 'create' && <span style={infoS}>저장 시 신규 등록: {part.name} <span style={{ color: '#6b7280', fontWeight: 400 }}>— {part.reason}</span></span>}
      {part.action === 'none' && <span style={{ color: '#6b7280' }}>{part.reason}</span>}
      {part.action === 'confirm' && (
        <>
          <span style={warnS}>확인 필요 — {part.reason}</span>
          {part.candidates.map(c => (
            <button key={c.id} type="button" style={btnGhost} onClick={() => onPick(c.id)} data-testid={`${testid}-pick-${c.id}`} aria-label={`기존 ${title} ${c.name} 선택`}>
              {c.name}{c.sub ? ` · ${c.sub}` : ''}
            </button>
          ))}
          {onCreate && <button type="button" style={btn} onClick={onCreate} data-testid={`${testid}-create`} aria-label={createLabel}>{createLabel}</button>}
          {onSkip && <button type="button" style={btnGhost} onClick={onSkip} data-testid={`${testid}-skip`} aria-label="담당자 연결 없이 저장">연결 없이 저장</button>}
        </>
      )}
    </div>
  );
}

export function InquiryQuoteLinkCard({ inquiryNumber, ctx, plan, setChoice, issueDate, productMatches, currentProductIds, onPickCompany, onPickContact, onPickProduct }: {
  inquiryNumber?: string | null;
  ctx: QuoteInquiryContext;
  plan: CustomerPlan | null;
  setChoice: (fn: (c: CustomerChoice) => CustomerChoice) => void;
  issueDate: string;
  productMatches: InquiryProductMatch[];
  currentProductIds: Array<number | null>;
  onPickCompany: (id: number) => void;
  onPickContact: (id: number) => void;
  onPickProduct: (itemIndex: number, productId: number) => void;
}) {
  const s = plan?.snapshot;
  const snapLine = s ? [[s.customerContactName, s.customerContactPosition].filter(Boolean).join(' '), s.customerContactDepartment, s.customerCompanyName].filter(Boolean).join(' · ') : '';
  const snapInfo = s ? [s.customerContactPhone && `T ${s.customerContactPhone}`, s.customerContactMobile && `M ${s.customerContactMobile}`, s.customerContactEmail && `E ${s.customerContactEmail}`].filter(Boolean).join(' / ') : '';
  const due = dueStatus(ctx.quoteDueDate, issueDate);

  return (
    <div data-testid="inq-quote-link-card" style={box}>
      <div style={{ fontSize: 13, fontWeight: 800, color: '#312e81', paddingBottom: 4 }}>
        의뢰건 {inquiryNumber ?? ''} 연동 확인 <span style={{ fontWeight: 400, color: '#6366f1', fontSize: 11 }}>— 거래처·담당자 신규 등록은 저장할 때 중복검증 후 함께 처리됩니다.</span>
      </div>

      {/* ① 고객정보·Master */}
      <PlanLine title="거래처" testid="inq-quote-company" part={plan?.company}
        onPick={(id) => { setChoice(c => ({ ...c, createCompany: false })); onPickCompany(id); }}
        onCreate={() => setChoice(c => ({ ...c, createCompany: true }))} createLabel="신규 거래처로 등록" />
      <PlanLine title="담당자" testid="inq-quote-contact" part={plan?.contact}
        onPick={(id) => { setChoice(c => ({ ...c, createContact: false, skipContact: false })); onPickContact(id); }}
        onCreate={() => setChoice(c => ({ ...c, createContact: true, skipContact: false }))} createLabel="신규 담당자로 등록"
        onSkip={() => setChoice(c => ({ ...c, skipContact: true, createContact: false }))} />
      {s && (
        <div style={{ ...sec, borderTop: 'none', paddingTop: 0 }} data-testid="inq-quote-snapshot">
          <span style={head} />
          <span style={{ color: '#4b5563' }}>견적에 저장될 고객정보: <b>{snapLine || '—'}</b>{snapInfo && ` · ${snapInfo}`}</span>
        </div>
      )}

      {/* ② 상품 매칭 */}
      {productMatches.map(m => {
        const cur = currentProductIds[m.itemIndex] ?? null;
        const auto = m.status === 'auto' && m.autoProduct;
        const autoKept = auto && cur === m.autoProduct!.id;
        return (
          <div key={m.itemIndex} style={sec} data-testid={`inq-quote-product-${m.itemIndex}`}>
            <span style={head}>상품 {m.itemIndex + 1}행</span>
            <span style={{ color: '#4b5563' }}>{m.label}</span>
            {autoKept && <span style={okS}>✓ 자동 선택: {m.autoProduct!.name}{m.autoProduct!.code ? ` (${m.autoProduct!.code})` : ''}</span>}
            {auto && !autoKept && (
              <span style={{ color: '#6b7280' }}>추천 {m.autoProduct!.name} — 직원이 다른 상품으로 변경함
                <button type="button" style={{ ...btnGhost, marginLeft: 6 }} onClick={() => onPickProduct(m.itemIndex, m.autoProduct!.id)}
                  data-testid={`inq-quote-product-revert-${m.itemIndex}`} aria-label={`추천 상품 ${m.autoProduct!.name}으로 되돌리기`}>추천 상품으로 되돌리기</button>
              </span>
            )}
            {m.status === 'choose' && <span style={warnS}>일치 상품 {m.candidates.length}개 — 선택해 주세요</span>}
            {m.status === 'none' && <span style={warnS}>조건이 일치하는 상품 없음 — 상품 행에서 직접 선택(수행정보는 유지됨)</span>}
            {m.candidates.length > 0 && <span>{auto ? '· 다른 후보 ' : ''}{m.candidates.map(p => (
              <button key={p.id} type="button" style={{ ...(cur === p.id ? btn : btnGhost), marginLeft: 4 }} onClick={() => onPickProduct(m.itemIndex, p.id)}
                data-testid={`inq-quote-product-pick-${m.itemIndex}-${p.id}`} aria-label={`상품 ${p.name} 선택`}>{p.name}</button>
            ))}</span>}
          </div>
        );
      })}

      {/* ③ 추가 언어 */}
      {(ctx.additionalLanguages?.length ?? 0) > 0 && (
        <div style={sec} data-testid="inq-quote-addl-langs">
          <span style={head}>추가 언어</span>
          <span><b>{ctx.additionalLanguages!.join(', ')}</b> — 상품 행은 자동 추가하지 않았습니다. 필요하면 직접 추가하세요.</span>
        </div>
      )}

      {/* ④ 견적서 수령 희망일 */}
      {ctx.quoteDueDate && (
        <div style={sec} data-testid="inq-quote-duedate">
          <span style={head}>수령 희망일</span>
          <span>고객 요청 기한 <b>{ctx.quoteDueDate}</b> · 견적일 {issueDate}</span>
          {due && <span data-testid="inq-quote-duedate-status" style={due.kind === 'past' ? { ...warnS, color: '#b91c1c' } : due.kind === 'today' ? warnS : okS}>{due.label}</span>}
          <span style={{ color: '#9ca3af' }}>(저장은 가능합니다)</span>
        </div>
      )}
    </div>
  );
}

export default InquiryQuoteLinkCard;
