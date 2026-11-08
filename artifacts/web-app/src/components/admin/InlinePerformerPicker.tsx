// ─────────────────────────────────────────────────────────────────────────────
// 수행자·업체 인라인 검색선택 (수정모드 컬럼용, §5·§6·§11).
//  · 개인 → 통번역사 검색 / 외주업체 → 업체 검색 / 경비 → 지급대상 직접입력(선택).
//  · 검색결과 드롭다운은 portal 로 렌더 → 테이블 overflow 에 잘리지 않음(z-index 9600).
//  · 선택 후 성명만 간결 표시(말줄임 + title 로 전체 확인).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useRef, useState, useLayoutEffect, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { C, TYPO, dsInputStd } from '../../lib/ds';
import { Row, VENDOR_TYPE_LABEL } from './performanceShared';
import TranslatorPreviewPopover, { RecentPerformance, TranslatorContactResult, phoneLast4, phoneForDisplay } from './TranslatorPreviewPopover';
import { educationDisplay } from '../../lib/educationDisplay';

interface Props {
  r: Row; i: number;
  searchIdx: number | null;
  searchResults: any[];
  searchState?: 'idle' | 'loading' | 'done' | 'error';
  initialQuery?: string;   // 검색칸 초기값(조회모드 필터어 이어받기)
  onSearchTranslator: (i: number, q: string) => void;
  onSearchVendor: (i: number, q: string) => void;
  onPickTranslator: (i: number, result: any) => void;
  onPickVendor: (i: number, result: any) => void;
  onClear: (i: number) => void;
  onCancelChange: (i: number) => void;
  patch: (p: Partial<Row>) => void;
  fetchRecentPerformances?: (translatorId: number) => Promise<RecentPerformance[]>;
  fetchTranslatorContact?: (translatorId: number) => Promise<TranslatorContactResult>;
}

// 검색결과 카드 항목(동명이인 구분) — 언어 · 최종학력 · 연락처 · 이메일.
//   전체 연락처·이메일은 서버가 배정 권한(project.update) 보유자에게만 내려준다(contactVisible).
//   권한이 없으면 기존처럼 연락처 끝 4자리만, 이메일은 '권한 없음'. 주민번호·계좌·상세주소는 표시하지 않는다.
//   최종학력: 통번역사 목록 '학력' 컬럼과 같은 규칙(educationDisplay — 학력 이력 우선, 없으면 기존 학력값).
function translatorCardFields(x: any): Array<[string, string]> {
  const visible = x.contactVisible === true;
  const last4 = phoneLast4(x.phone);
  const phone = visible ? (x.phone ? phoneForDisplay(String(x.phone)) : '미등록') : (last4 ? `···· ${last4}` : '미등록');
  const email = visible ? (x.email || '미등록') : '권한 없음';
  return [
    ['언어', x.languagePairs || '미등록'],
    ['최종학력', educationDisplay(x.educationHistory, x.education, x.major) || '미등록'],
    ['연락처', phone],
    ['이메일', email],
  ];
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

// 작은 검색결과창 위치·크기 — 업체 검색은 기존 그대로. 통번역사는 카드 정보가 늘어 폭 380px(화면 폭 내),
//   입력칸 바로 아래·왼쪽 정렬, 오른쪽 넘치면 왼쪽으로 당기고, 아래 공간이 부족하고 위가 더 넓으면 입력칸 위에 표시. 내부 스크롤.
function listBox(rect: { left: number; top: number; width: number; inputTop: number; inputBottom: number }, isVendor: boolean): React.CSSProperties {
  if (isVendor) return { left: rect.left, top: rect.top, width: rect.width, maxHeight: 300 };
  const M = 8, GAP = 2, MAX_H = 380;
  const vw = window.innerWidth, vh = window.innerHeight;
  const width = Math.min(Math.max(rect.width, 380), vw - M * 2);
  const left = Math.max(M, Math.min(rect.left, vw - width - M));
  const below = vh - rect.inputBottom - GAP - M, above = rect.inputTop - GAP - M;
  if (below >= Math.min(MAX_H, 220) || below >= above) return { left, top: rect.inputBottom + GAP, width, maxHeight: Math.max(120, Math.min(MAX_H, below)) };
  return { left, bottom: vh - rect.inputTop + GAP, width, maxHeight: Math.min(MAX_H, above) };
}

export default function InlinePerformerPicker(props: Props) {
  const { r, i, searchIdx, searchResults, searchState = 'idle', initialQuery, onSearchTranslator, onSearchVendor, onPickTranslator, onPickVendor, onClear, onCancelChange, patch, fetchRecentPerformances, fetchTranslatorContact } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const [rect, setRect] = useState<{ left: number; top: number; width: number; inputTop: number; inputBottom: number } | null>(null);
  // 통번역사 상세 미리보기 대상(§2) — 검색결과 클릭 시 즉시 선택하지 않고 이 값에 담아 미리보기를 띄운다. null=미표시.
  const [previewTarget, setPreviewTarget] = useState<any | null>(null);
  // 작은 검색결과창 숨김 — 상세 미리보기를 연 뒤에는 목록을 숨기고, 미리보기 '닫기' 후에도 자동 재표시하지 않는다.
  //   사용자가 검색어를 다시 입력하거나 입력칸을 다시 클릭(포커스)하면 해제.
  const [listHidden, setListHidden] = useState(false);
  const openPreview = (x: any) => { setListHidden(true); setPreviewTarget(x); };
  // 변경 전 원본 스냅샷(§변경취소) — 변경 시작 시 1회 캡처, 취소/저장 전까지 유지. null이면 진행 중 변경 없음.
  const [orig, setOrig] = useState<Partial<Row> | null>(null);
  const cat = r.performerCategory;
  // 결과가 없을 때도 검색 중·결과 없음·조회 오류를 드롭다운에 구분 표시(검색어 없음=idle 은 닫힘)
  const open = searchIdx === i && (searchResults.length > 0 || searchState !== 'idle');
  const emptyMsg = searchState === 'loading' ? '검색 중…'
    : searchState === 'error' ? '조회 오류 — 잠시 후 다시 입력해 주세요'
    : '검색 결과가 없습니다';

  // Enter 검색(§검색 간소화) — Enter 시점의 검색어. 검색 응답(최신 검색어 결과만 반영됨)이 도착하면 결과 수에 따라 처리:
  //   1명 → 상세 미리보기 자동 표시(배정은 미리보기의 [이 통번역사 선택]에서만) / 2명 이상 → 목록 유지(자동 선택 없음) / 0명 → 안내 유지.
  const pendingEnter = useRef<string | null>(null);
  useEffect(() => {
    if (pendingEnter.current == null || cat === 'vendor' || searchIdx !== i) return;
    if (searchState === 'loading' || searchState === 'idle') return;   // 응답 대기
    pendingEnter.current = null;
    if (searchState === 'done' && searchResults.length === 1) openPreview(searchResults[0]);
  }, [searchState, searchResults, searchIdx, i, cat]);

  // 변경 시작 — 원본을 아직 안 잡았을 때만 캡처(연속 재선택 시 최초 원본 보존) 후 검색모드 진입.
  const startChange = () => { setOrig(prev => prev ?? snapshotPerformer(r)); onClear(i); };
  // 변경 취소 — 원본으로 즉시 로컬 복원(서버 미호출), 검색상태 초기화. 확정은 최종 저장에서만.
  const cancelChange = () => { if (orig) patch(orig); setOrig(null); onCancelChange(i); };

  // 검색 입력칸 위치(드롭다운·상세 미리보기 기준). 표시 중에는 가로·세로 스크롤(테이블 포함)·창 크기 변경 시 다시 계산.
  const tracking = open || !!previewTarget;
  useLayoutEffect(() => {
    if (!tracking || !inputRef.current) { setRect(null); return; }
    const measure = () => {
      if (!inputRef.current) return;
      const b = inputRef.current.getBoundingClientRect();
      setRect({ left: b.left, top: b.bottom + 2, width: Math.max(b.width, 240), inputTop: b.top, inputBottom: b.bottom });
    };
    measure();
    window.addEventListener('scroll', measure, true);   // capture: 테이블 등 내부 스크롤 컨테이너 포함
    window.addEventListener('resize', measure);
    return () => { window.removeEventListener('scroll', measure, true); window.removeEventListener('resize', measure); };
  }, [tracking, searchResults]);

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
  const onRowClick = (x: any) => (isVendor ? onPickVendor(i, x) : openPreview(x));
  const confirmPreview = () => { if (previewTarget) onPickTranslator(i, previewTarget); setPreviewTarget(null); };
  const noopRecent = async () => [] as RecentPerformance[];
  // 입력 중에는 미리보기를 자동으로 열지 않는다 — Enter 이후 검색어가 바뀌면 대기 중인 Enter 처리 취소.
  const onInputChange = (v: string) => {
    if (pendingEnter.current != null && v.trim() !== pendingEnter.current) pendingEnter.current = null;
    setListHidden(false);
    onSearch(v);
  };
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isVendor) return;   // 업체 검색은 기존 동작 유지
    e.preventDefault();                            // 폼 제출·새로고침 방지
    const q = e.currentTarget.value.trim();
    if (!q) return;
    if (!previewTarget) setListHidden(false);     // 결과 0명·여러 명이면 목록(안내)을 다시 보여준다 — 1명이면 openPreview 가 숨김
    pendingEnter.current = q;                      // 한글 조합 중 Enter(중복 keydown)도 같은 값으로 1회 처리
    if (searchIdx === i && searchState === 'done') {
      pendingEnter.current = null;
      if (searchResults.length === 1) openPreview(searchResults[0]);   // 같은 대상이면 상태만 동일 → 팝업 중복 없음
    } else if (searchIdx !== i || searchState === 'idle' || searchState === 'error') {
      onSearch(q);                                 // 검색 결과가 없거나 다른 행 결과면 재검색 → 응답 도착 시 위 effect 가 처리
    }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input ref={inputRef} style={inp} placeholder={placeholder} defaultValue={initialQuery || undefined}
          onChange={e => onInputChange(e.target.value)} onFocus={e => { if (!previewTarget) setListHidden(false); onSearch(e.target.value); }} onKeyDown={onInputKeyDown}
          data-testid={`perf-inline-search-${i}`} aria-label={placeholder} />
        {orig && cancelBtn}
      </div>
      {open && rect && !listHidden && !previewTarget && createPortal(
        <div style={{ position: 'fixed', zIndex: 9600, background: C.bgCard, border: `1px solid ${C.g200}`, borderRadius: 8, boxShadow: '0 4px 14px rgba(0,0,0,0.12)', overflowY: 'auto', ...listBox(rect, isVendor) }}
          data-testid={`perf-search-list-${i}`}>
          {searchResults.length === 0 && (
            <div role="status" data-testid={`perf-search-empty-${i}`} aria-label={emptyMsg}
              style={{ padding: '8px 10px', fontSize: 12, color: searchState === 'error' ? C.danger : C.textMuted }}>{emptyMsg}</div>
          )}
          {searchResults.map((x: any) => (
            <button key={x.id} type="button" onMouseDown={e => { e.preventDefault(); onRowClick(x); }}
              data-testid={`perf-search-result-${i}-${x.id}`} aria-label={`${x.name || x.email || ''} 상세 보기`}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: isVendor ? '7px 10px' : '9px 12px', border: 'none', borderBottom: `1px solid ${isVendor ? C.g100 : C.g200}`, background: previewTarget?.id === x.id ? C.primaryBg : 'transparent', cursor: 'pointer' }}>
              <div style={{ fontWeight: isVendor ? 600 : 700, fontSize: 13 }}>{x.name || x.email}
                {!isVendor && x.isActive === false && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: C.textSecondary, border: `1px solid ${C.g300}`, borderRadius: 999, padding: '0 6px' }}>비활성</span>}
              </div>
              {isVendor
                ? <div style={{ ...TYPO.helper, whiteSpace: 'normal', lineHeight: 1.4 }}>
                    {`${VENDOR_TYPE_LABEL[x.vendorType] ?? x.vendorType ?? '외주'}${x.businessNumber ? ` · ${x.businessNumber}` : ''}${x.representativeName ? ` · ${x.representativeName}` : ''}`}
                  </div>
                : <div style={{ display: 'grid', gridTemplateColumns: '56px 1fr', gap: '2px 8px', marginTop: 4, lineHeight: 1.45 }}>
                    {translatorCardFields(x).map(([label, value]) => (
                      <React.Fragment key={label}>
                        <span style={{ ...TYPO.helper, color: C.textMuted }}>{label}</span>
                        <span style={{ fontSize: 12, color: C.textPrimary, minWidth: 0, whiteSpace: 'normal', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>{value}</span>
                      </React.Fragment>
                    ))}
                  </div>}
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
          fetchContact={fetchTranslatorContact}
          onSelect={confirmPreview} onClose={() => setPreviewTarget(null)} />
      )}
    </>
  );
}
