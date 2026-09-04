// ─────────────────────────────────────────────────────────────────────────────
// 수행자·업체 인라인 검색선택 (수정모드 컬럼용, §5·§6·§11).
//  · 개인 → 통번역사 검색 / 외주업체 → 업체 검색 / 경비 → 지급대상 직접입력(선택).
//  · 검색결과 드롭다운은 portal 로 렌더 → 테이블 overflow 에 잘리지 않음(z-index 9600).
//  · 선택 후 성명만 간결 표시(말줄임 + title 로 전체 확인).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useRef, useState, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { C, TYPO, dsInputStd } from '../../lib/ds';
import { Row, VENDOR_TYPE_LABEL } from './performanceShared';
import TranslatorPreviewPopover, { RecentPerformance, phoneLast4, gradeLabel, workTypeLabel } from './TranslatorPreviewPopover';

interface Props {
  r: Row; i: number;
  searchIdx: number | null;
  searchResults: any[];
  onSearchTranslator: (i: number, q: string) => void;
  onSearchVendor: (i: number, q: string) => void;
  onPickTranslator: (i: number, result: any) => void;
  onPickVendor: (i: number, result: any) => void;
  onClear: (i: number) => void;
  onCancelChange: (i: number) => void;
  patch: (p: Partial<Row>) => void;
  fetchRecentPerformances?: (translatorId: number) => Promise<RecentPerformance[]>;
}

// 검색결과 한 줄 식별정보(§1) — 언어·등급·구분·학교·전문분야·지역·연락처 끝4. 상세주소·주민번호·계좌·전화번호 전체는 표시 안 함(§5).
function translatorSummary(x: any): string {
  const last4 = phoneLast4(x.phone);
  return [
    x.languagePairs, gradeLabel(x.grade), workTypeLabel(x.profileWorkTypes),
    x.education, x.specializations, x.region,
    last4 ? `☎ ${last4}` : null,
  ].filter(Boolean).join(' · ');
}

// 변경 취소 시 복원할 수행자·업체 식별정보(§변경취소) — 로컬 복원용, 서버 미변경.
const PERFORMER_FIELDS = [
  'performerCategory', 'lineCategory', 'individualUserId', 'vendorCompanyId',
  'performerNameSnapshot', 'identifierSnapshotMasked', 'vendorTypeSnapshot',
  'residenceCountrySnapshot', 'residencyType', 'withholdingTreatment',
] as const;
const snapshotPerformer = (r: Row): Partial<Row> =>
  Object.fromEntries(PERFORMER_FIELDS.map(k => [k, (r as any)[k] ?? null])) as Partial<Row>;

const inp: React.CSSProperties = { ...dsInputStd(), fontSize: 12, minHeight: 30, padding: '4px 8px', width: '100%' };

export default function InlinePerformerPicker(props: Props) {
  const { r, i, searchIdx, searchResults, onSearchTranslator, onSearchVendor, onPickTranslator, onPickVendor, onClear, onCancelChange, patch, fetchRecentPerformances } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  // 통번역사 상세 미리보기 대상(§2) — 검색결과 클릭 시 즉시 선택하지 않고 이 값에 담아 미리보기를 띄운다. null=미표시.
  const [previewTarget, setPreviewTarget] = useState<any | null>(null);
  // 변경 전 원본 스냅샷(§변경취소) — 변경 시작 시 1회 캡처, 취소/저장 전까지 유지. null이면 진행 중 변경 없음.
  const [orig, setOrig] = useState<Partial<Row> | null>(null);
  const cat = r.performerCategory;
  const open = searchIdx === i && searchResults.length > 0;

  // 변경 시작 — 원본을 아직 안 잡았을 때만 캡처(연속 재선택 시 최초 원본 보존) 후 검색모드 진입.
  const startChange = () => { setOrig(prev => prev ?? snapshotPerformer(r)); onClear(i); };
  // 변경 취소 — 원본으로 즉시 로컬 복원(서버 미호출), 검색상태 초기화. 확정은 최종 저장에서만.
  const cancelChange = () => { if (orig) patch(orig); setOrig(null); onCancelChange(i); };

  useLayoutEffect(() => {
    if (open && inputRef.current) {
      const b = inputRef.current.getBoundingClientRect();
      setRect({ left: b.left, top: b.bottom + 2, width: Math.max(b.width, 240) });
    } else setRect(null);
  }, [open, searchResults]);

  // 경비 — 지급대상 직접입력(선택), 비활성화하지 않음(§6-3)
  if (cat === 'expense') {
    return (
      <input style={inp} value={r.performerNameSnapshot ?? ''} placeholder="지급대상 선택 또는 직접입력"
        onChange={e => patch({ performerNameSnapshot: e.target.value })}
        data-testid={`perf-payee-${i}`} aria-label="지급대상" />
    );
  }

  // 취소 버튼(§변경취소) — 검색모드/선택직후 모두 노출. 원본 미보관(orig=null)이면 표시 안 함.
  const cancelBtn = (
    <button type="button" onClick={cancelChange} title="변경 취소" aria-label="수행자 변경 취소" data-testid={`perf-cancel-change-${i}`}
      style={{ flexShrink: 0, fontSize: 11, lineHeight: 1, padding: '2px 6px', border: `1px solid ${C.g300}`, borderRadius: 4, background: C.bgCard, color: C.textMuted, cursor: 'pointer', whiteSpace: 'nowrap' }}>취소</button>
  );

  // 선택완료 — 성명만 간결 표시. 변경 진행 중(orig)에는 취소 버튼도 함께 노출(신규 선택 후 저장 전 복원 §변경취소).
  if (r.performerNameSnapshot) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }} title={r.performerNameSnapshot}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 600 }}>{r.performerNameSnapshot}</span>
        <button type="button" onClick={startChange} title="변경" aria-label="수행자 변경"
          style={{ flexShrink: 0, fontSize: 11, lineHeight: 1, padding: '2px 6px', border: `1px solid ${C.g300}`, borderRadius: 4, background: C.bgCard, color: C.textMuted, cursor: 'pointer' }}>변경</button>
        {orig && cancelBtn}
      </div>
    );
  }

  const isVendor = cat === 'vendor';
  // 구분값에 맞춘 검색 placeholder(§7) — 예: 장비업체 검색 / 번역업체 검색 / 외주업체 검색 / 통번역사 검색
  const placeholder = isVendor ? `${r.lineCategory || '외주업체'} 검색` : '통번역사 검색';
  const onSearch = (q: string) => (isVendor ? onSearchVendor(i, q) : onSearchTranslator(i, q));
  // 클릭 동작(§2) — 업체는 기존대로 즉시 선택, 통번역사는 상세 미리보기를 먼저 띄운다(선택은 미리보기 하단 버튼에서).
  const onRowClick = (x: any) => (isVendor ? onPickVendor(i, x) : setPreviewTarget(x));
  const confirmPreview = () => { if (previewTarget) onPickTranslator(i, previewTarget); setPreviewTarget(null); };
  const noopRecent = async () => [] as RecentPerformance[];

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input ref={inputRef} style={inp} placeholder={placeholder}
          onChange={e => onSearch(e.target.value)} onFocus={e => onSearch(e.target.value)}
          data-testid={`perf-inline-search-${i}`} aria-label={placeholder} />
        {orig && cancelBtn}
      </div>
      {open && rect && createPortal(
        <div style={{ position: 'fixed', left: rect.left, top: rect.top, width: rect.width, zIndex: 9600, background: C.bgCard, border: `1px solid ${C.g200}`, borderRadius: 8, boxShadow: '0 4px 14px rgba(0,0,0,0.12)', maxHeight: 300, overflowY: 'auto' }}>
          {searchResults.map((x: any) => (
            <button key={x.id} type="button" onMouseDown={e => { e.preventDefault(); onRowClick(x); }}
              data-testid={`perf-search-result-${i}-${x.id}`}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', border: 'none', borderBottom: `1px solid ${C.g100}`, background: previewTarget?.id === x.id ? C.primaryBg : 'transparent', cursor: 'pointer' }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{x.name || x.email}</div>
              <div style={{ ...TYPO.helper, whiteSpace: 'normal', lineHeight: 1.4 }}>
                {isVendor
                  ? `${VENDOR_TYPE_LABEL[x.vendorType] ?? x.vendorType ?? '외주'}${x.businessNumber ? ` · ${x.businessNumber}` : ''}${x.representativeName ? ` · ${x.representativeName}` : ''}`
                  : translatorSummary(x)}
              </div>
            </button>
          ))}
        </div>,
        document.body,
      )}
      {/* 통번역사 상세 미리보기(§2) — 검색 드롭다운 옆에 표시, [이 통번역사 선택] 시 기존 선택 흐름 호출 */}
      {previewTarget && rect && (
        <TranslatorPreviewPopover
          t={previewTarget} anchor={rect}
          fetchRecent={fetchRecentPerformances ?? noopRecent}
          onSelect={confirmPreview} onClose={() => setPreviewTarget(null)} />
      )}
    </>
  );
}
