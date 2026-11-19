// ─────────────────────────────────────────────────────────────────────────────
// 서비스 유형별 상세정보 셀(§3~§9·§14·§17) — 연결된 판매상품 유형에 맞는 필드만 한 줄에 표시.
//  · 통역: 기간·시간·인원·장소 / 장비: 사용기간·설치일시·사용일수·장소 / 번역: 파일명·작업량(수량+단위).
//  · 편집 가능 필드는 실제 수행 컬럼(performanceStartDate/EndDate)·번역 작업량 스냅샷에 바인딩.
//  · 계산 수량·단위(quantity·unit)는 우측 수량·단위 칸 한 곳에서만 입력한다(2026-11 입력 위치 통합).
//    상세정보는 기간·장소·시간·작업량 등 업무 정보 중심. 경비 행만 우측 칸이 없어 여기서 수량·단위를 입력한다.
//  · 판매 참조값(saleUnitPrice 등)은 읽기전용 표시 — 계약단가로 복사하지 않음(§10).
//  · 존재하지 않는 값(단어수 등)은 만들지 않고, 실제 스냅샷에 있는 값만 표시.
// ─────────────────────────────────────────────────────────────────────────────
import React from 'react';
import { createPortal } from 'react-dom';
import { C, TYPO, dsInputStd } from '../../lib/ds';
import { ClickSelect } from '../ui';
import { Row, UNIT_OPTS, dateVal, num, isTranslationKind, isInterpretationKind, countQtyPatch, unitChangePatch, periodDays, qtyFollowsPeriod } from './performanceShared';
import { formatScheduleRange } from '../../lib/dateFormat';
import { DateField } from './DatePickerShared';

const mini: React.CSSProperties = { ...dsInputStd(), minHeight: 28, padding: '3px 6px', fontSize: 12 };
const ref: React.CSSProperties = { ...TYPO.helper, color: C.textMuted, whiteSpace: 'nowrap' };
const wrap: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' };

// ── 기간(Date Range) 단일 필드(§1) — 클릭 시 시작·종료를 한 번에 선택하는 포털 팝오버. ──
//  · 표에 가로 오버플로우가 있어 절대배치는 잘리므로 ClickSelect와 동일하게 body 포털 + fixed 배치.
//  · 값은 상위 상태로 즉시 반영(controlled). 계산·저장 로직은 상위(patch)에서 처리.
function DateRangeField({ start, end, onChange, label, placeholder = '기간 선택' }: {
  start?: string | null; end?: string | null;
  onChange: (start: string, end: string) => void;
  label: string; placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const s = dateVal(start), e = dateVal(end);

  const calc = React.useCallback(() => {
    const el = btnRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: r.left, top: r.bottom + 4 });
  }, []);
  React.useLayoutEffect(() => { if (open) calc(); else setPos(null); }, [open, calc]);
  React.useEffect(() => {
    if (!open) return;
    const reposition = () => calc();
    const onDown = (ev: MouseEvent) => {
      if (btnRef.current?.contains(ev.target as Node)) return;
      if (panelRef.current?.contains(ev.target as Node)) return;
      setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setOpen(false); };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, calc]);

  const trig: React.CSSProperties = { ...mini, width: 190, textAlign: 'left', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, background: C.bgCard };
  const fieldLbl: React.CSSProperties = { ...TYPO.helper, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, whiteSpace: 'nowrap' };
  return (
    <>
      <button type="button" ref={btnRef} aria-label={label} data-testid="perf-daterange"
        onClick={() => setOpen(o => !o)} style={trig} title={label}>
        <span style={{ color: (s || e) ? C.textPrimary : C.textMuted, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {s || e ? `${s || '____-__-__'} ~ ${e || '____-__-__'}` : placeholder}
        </span>
        <span aria-hidden style={{ color: C.textMuted, fontSize: 11 }}>▾</span>
      </button>
      {open && pos && createPortal(
        <div ref={panelRef} role="dialog" aria-label={`${label} 선택`}
          style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 9500, background: C.bgCard, border: `1px solid ${C.g200}`, borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.15)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 230 }}>
          <label style={fieldLbl}>시작일
            <DateField value={s} max={e || undefined} style={{ ...mini, width: 150 }}
              onChange={v => onChange(v, e)} ariaLabel={`${label} 시작일`} testid="perf-daterange-start" />
          </label>
          <label style={fieldLbl}>종료일
            <DateField value={e} min={s || undefined} style={{ ...mini, width: 150 }}
              onChange={v => onChange(s, v)} ariaLabel={`${label} 종료일`} testid="perf-daterange-end" />
          </label>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setOpen(false)} aria-label="기간 선택 완료" data-testid="perf-daterange-done"
              style={{ fontSize: 12, padding: '4px 12px', border: `1px solid ${C.g300}`, borderRadius: 6, background: C.bgCard, cursor: 'pointer' }}>확인</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

export type SvcKind = 'interpretation' | 'equipment' | 'translation' | 'expense' | 'generic';

// 서비스 유형 판별(§3) — serviceType(판매 item_type) → canonicalKey → productType 순.
export function svcKind(r: Row): SvcKind {
  const snap = (r.serviceDetailSnapshot ?? {}) as any;
  const t = String(r.serviceType || snap.itemType || '').toLowerCase();
  const ck = String(snap.canonicalKey || '').toLowerCase();
  const pt = String(snap.productType || '').toLowerCase();
  if (isInterpretationKind(r)) return 'interpretation';   // 통역 계열 판정은 performanceShared 단일 출처 사용
  if (/equip|장비/.test(t) || ck.startsWith('eq:') || /equip/.test(pt)) return 'equipment';
  if (isTranslationKind(r)) return 'translation';   // 번역 계열 판정은 performanceShared 단일 출처 사용
  if (r.performerCategory === 'expense') return 'expense';
  return 'generic';
}

const joinRef = (parts: (string | number | null | undefined)[]) =>
  parts.filter(v => v != null && v !== '').join(' · ');

// 번역 파일명 칩 — 업로드 원본 파일명(확장자 포함). 길면 말줄임(…) + 마우스오버 전체표시. 없으면 null.
function FileNameChip({ name }: { name?: string | null }) {
  if (!name) return null;
  return (
    <span title={name} style={{ display: 'inline-block', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>{name}</span>
  );
}

// 보조 라벨(작업기간/파일명) — 작고 옅은 회색. 값보다 강하지 않게. 표시전용(§1).
function SubLabel({ children }: { children: React.ReactNode }) {
  return <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 500, color: C.textMuted, opacity: 0.85 }}>{children}</span>;
}
// 필드 구분자 — 얇은 세로 구분선. 작업기간 | 파일명 | 수량 을 눈으로 즉시 구분(§1·§4).
function FieldDivider() {
  return <span aria-hidden style={{ flexShrink: 0, alignSelf: 'center', width: 1, height: 10, background: C.g200 }} />;
}

// 번역 작업량 세그먼트 — 파일명 뒤에 작업량(단어수/글자수)만 표시. 페이지수는 표시하지 않는다
//   (판매정보의 수량/단위 컬럼에서 확인 — 중복표시 금지). pageCount 는 스냅샷에 계속 저장되며 표시만 제외.
function translationSegments(r: Row, snap: any): string[] {
  // 판매정보 원본 작업량 보존(§2·§3·§7) — 단어수·글자수가 있으면 둘 다(순서: 단어→글자), 없는 항목은 표시 안 함.
  const segs: string[] = [];
  if (snap.wordCount && num(snap.wordCount) > 0) segs.push(`${num(snap.wordCount).toLocaleString()}단어`);
  if (snap.charCount && num(snap.charCount) > 0) segs.push(`${num(snap.charCount).toLocaleString()}글자`);
  if (segs.length) return segs;
  // 구 스냅샷 폴백 — 단어/글자 상세필드가 없을 때만 판매 수량·단위 표시. 단, 페이지는 제외(중복표시 금지).
  const unit = snap.saleUnit ?? r.unit ?? '';
  if (unit === '페이지') return [];
  const q = snap.saleQuantity != null ? snap.saleQuantity : (r.quantity != null && r.quantity !== '' ? r.quantity : null);
  if (q == null || q === '') return [];
  return [`${num(q).toLocaleString()}${unit}`];
}

// 번역 표시용 요약(파일명 · 작업량) — 조회·수정 화면 공통 렌더러.
//   수정화면에서도 이 요약을 그대로 사용해 '사용자가 보는 상세정보'를 조회화면과 동일 기준으로 통일한다.
//   (편집용 수량/단위 입력필드는 이 요약과 분리해 별도로 유지 — 표시용 요약 ≠ 편집 컨트롤.)
//   내용이 없으면 null 반환(조회화면은 '—' 폴백, 수정화면은 입력필드만 노출).
function renderTranslationSummary(r: Row, snap: any): React.ReactElement | null {
  const fname = snap.fileName ?? '';
  const segs = translationSegments(r, snap);
  const parts: React.ReactNode[] = [];
  if (fname) parts.push(<FileNameChip key="file" name={fname} />);
  segs.forEach((s, i) => parts.push(<span key={`seg${i}`} style={{ flexShrink: 0 }}>{s}</span>));
  if (parts.length === 0) return null;
  return (
    <span style={{ ...ref, color: C.textSecondary, display: 'inline-flex', alignItems: 'baseline', gap: 4, maxWidth: '100%' }} title={fname || undefined}>
      {parts.map((node, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <span style={{ flexShrink: 0, color: C.textMuted }}>/</span> : null}
          {node}
        </React.Fragment>
      ))}
    </span>
  );
}

// 임대기간 표시 — 저장된 수행 임대기간 날짜 수 우선, 없으면 판매 사용일수(usagePeriod). 재계산·저장 없음(표시 전용).
function equipPeriodLabel(r: Row, snap: any, period: string): string {
  const pd = periodDays(r.performanceStartDate, r.performanceEndDate);
  const days = pd ?? (snap.usagePeriod ? num(snap.usagePeriod) : null);
  return [period, days ? `(${days.toLocaleString()}일간)` : ''].filter(Boolean).join(' ');
}
// 판매 당시 수량 참고값 — 수행 수량과 다르거나(수정됨) 장비 사용일수가 판매수량에 합산된 경우에만 '판매 …'로 구분 표시.
//   현재값처럼 보이지 않도록 '판매' 접두어를 붙인다. 판매정보 자체는 읽기만 한다.
function saleRefLabel(r: Row, snap: any): string {
  if (snap.saleQuantity == null || snap.saleQuantity === '') return '';
  const sq = num(snap.saleQuantity), unit = snap.saleUnit ?? '';
  const usage = num(snap.usagePeriod);
  const isEquip = svcKind(r) === 'equipment';
  if (isEquip && usage > 1) return `판매 ${(sq / usage).toLocaleString()}${unit} × ${usage.toLocaleString()}일`;
  const q = r.quantity == null || r.quantity === '' ? null : num(r.quantity);
  if (r.quantityFromSale || q == null || q === sq) return '';
  return `판매 ${sq.toLocaleString()}${unit}`;
}

interface Props { r: Row; editable: boolean; patch: (p: Partial<Row>) => void; onEndDateChange?: (v: string) => void; }

export default function ServiceDetailCell({ r, editable, patch, onEndDateChange }: Props) {
  const snap = (r.serviceDetailSnapshot ?? {}) as any;
  const kind = svcKind(r);
  // 종료일 변경은 납품일 자동연동 처리(§8)를 거친다 — onEndDateChange 우선.
  const endOn = (v: string) => (onEndDateChange ? onEndDateChange(v) : patch({ performanceEndDate: v }));
  // 기간 변경 처리(§1·§3·§4) — 시작/종료는 각 필드로 저장(종료는 납품일 연동 endOn 경유).
  //   수행일수 자동 제안(2026-11)은 통역만, 그리고 현재 수량이 기존 기간 일수를 그대로 따를 때만(qtyFollowsPeriod).
  //   사용자가 확정한 수량(0.5일·시간 단위 등)은 기간을 바꿔도 유지. 장비(수량=세트·대수)·유형 미판별 행은 자동 계산하지 않는다.
  const onRangeChange = (start: string, end: string) => {
    const p: Partial<Row> = {};
    if (start !== dateVal(r.performanceStartDate)) p.performanceStartDate = start;
    if (kind === 'interpretation' && start && qtyFollowsPeriod(r)) {
      const d = periodDays(start, end);
      if (d != null) { p.quantity = d; if (!r.unit) p.unit = '일'; }
    }
    if (Object.keys(p).length) patch(p);
    if (end !== dateVal(r.performanceEndDate)) endOn(end);
  };
  // 경비 행 전용 수량·단위 입력(경비는 우측 수량·단위 칸이 없음 — 중복 아님)
  const qtyUnit = (
    <>
      {/* 판매수량 복사값(과거 CRM 전환)은 개별 수행 수량이 아니므로 비워 보여준다 — 입력하기 전까지 저장값은 그대로 */}
      <input type="number" min={0} inputMode="numeric" style={{ ...mini, width: 72, textAlign: 'right' }}
        value={r.quantityFromSale || r.quantity == null || r.quantity === '' ? '' : String(r.quantity)} onChange={e => patch({ quantity: e.target.value, quantityFromSale: false })} aria-label="수량"
        placeholder={r.quantityFromSale ? '미상' : '수량'} title={r.quantityFromSale ? `판매수량(${r.quantity}) 복사값 — 개별 수행 수량 미상` : undefined} />
      <div style={{ width: 76 }}><ClickSelect value={r.unit ?? ''} onChange={(v: string) => patch(unitChangePatch(r, v))} triggerStyle={mini} menuStyle={{ fontSize: 12 }} options={UNIT_OPTS} /></div>
    </>
  );

  // 작업량(단어·글자·페이지) 입력 — 스냅샷에 저장하고 수량·단위에 반영(countQtyPatch: 선택 산정단위 우선·지급완료 행 보호).
  const COUNT_FIELDS: { key: 'wordCount' | 'charCount' | 'pageCount'; unit: string; label: string }[] = [
    { key: 'wordCount', unit: '단어', label: '단어수' }, { key: 'charCount', unit: '글자', label: '글자수' }, { key: 'pageCount', unit: '페이지', label: '페이지수' },
  ];
  const countInputs = COUNT_FIELDS.map(f => (
    <input key={f.key} type="number" min={0} inputMode="numeric" style={{ ...mini, width: 70, textAlign: 'right' }}
      value={snap[f.key] == null || snap[f.key] === '' ? '' : String(snap[f.key])} placeholder={f.label} aria-label={f.label} title={f.label}
      data-testid={`perf-${f.key}`}
      onChange={e => { const next = { ...snap, [f.key]: e.target.value === '' ? null : e.target.value }; patch({ serviceDetailSnapshot: next, ...countQtyPatch(r, next, f.unit) }); }} />
  ));

  // ── 조회모드: 컴팩트 텍스트(§17) ──
  if (!editable) {
    // 번역: 작업기간 · 파일명(말줄임+툴팁) · 작업량(단어/글자). 계산식·금액은 표시하지 않음(§7 — 기간+작업량 모두 표시).
    if (kind === 'translation') {
      // 작업기간 | 파일명 | 수량 을 보조라벨+구분선으로 시각 분리(§1·§4). 파일명은 넓게 + 말줄임 시 tooltip 전체표시(§2·§3).
      const tperiod = formatScheduleRange(r.performanceStartDate, r.performanceEndDate);
      const fname = (snap.fileName ?? '') as string;
      const segs = translationSegments(r, snap);
      if (!tperiod && !fname && segs.length === 0) return <span style={{ ...ref, color: C.textSecondary }}>—</span>;
      return (
        <span style={{ ...ref, color: C.textSecondary, display: 'inline-flex', alignItems: 'baseline', gap: 6, maxWidth: '100%', minWidth: 0 }}>
          {tperiod && (
            <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'baseline', gap: 3 }}>
              <SubLabel>작업기간</SubLabel>
              <span>{tperiod}</span>
            </span>
          )}
          {tperiod && (fname || segs.length > 0) && <FieldDivider />}
          {fname && (
            <span style={{ flex: '1 1 auto', minWidth: 60, display: 'inline-flex', alignItems: 'baseline', gap: 3, overflow: 'hidden' }}>
              <SubLabel>파일명</SubLabel>
              <span title={fname} style={{ maxWidth: 460, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fname}</span>
            </span>
          )}
          {fname && segs.length > 0 && <FieldDivider />}
          {segs.length > 0 && (
            <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
              {segs.map((s, i) => (
                <React.Fragment key={i}>
                  {i > 0 ? <span style={{ color: C.textMuted }}>/</span> : null}
                  <span>{s}</span>
                </React.Fragment>
              ))}
            </span>
          )}
        </span>
      );
    }
    const period = formatScheduleRange(r.performanceStartDate, r.performanceEndDate);
    let text = '';
    if (kind === 'interpretation') {
      // 수행기간(N일간)은 저장된 수행기간의 날짜 수(기간 정보). 계산 수량은 우측 수량 칸(저장된 수행 수량)에 표시(2026-11).
      //   판매 당시 수량은 수행 수량과 다를 때만 '판매 …' 참고값으로 구분 표시.
      const pd = periodDays(r.performanceStartDate, r.performanceEndDate);
      const periodWithDays = [period, pd ? `(${pd}일간)` : ''].filter(Boolean).join(' ');
      // 인원수(interpreterCount)는 판매상품 전체 인원이므로 개별 수행정보(통역사 1명 단위)에는 표시하지 않는다.
      //   원본 스냅샷 데이터는 보존 — 표시에서만 제외(§10-2).
      text = joinRef([periodWithDays, snap.operationHours, snap.interpretDuration, snap.interpretPlace, saleRefLabel(r, snap)]);
    } else if (kind === 'equipment') {
      // 임대기간(N일간) = 저장된 수행 임대기간의 날짜 수(없으면 판매 사용일수). 장비 수량은 우측 수량 칸(저장값)에만 표시 —
      //   상세정보에 수량을 중복 표시하지 않는다(2026-11). 판매 당시 수량은 다를 때·사용일수 합산 시에만 참고값으로 표시.
      text = joinRef([equipPeriodLabel(r, snap, period), snap.itemLocation, snap.operationHours ? `설치 ${snap.operationHours}` : '', saleRefLabel(r, snap)]);
    } else if (kind === 'expense') {
      text = joinRef([r.productNameSnapshot, r.quantity != null && r.quantity !== '' ? `${num(r.quantity).toLocaleString()}${r.unit ?? ''}` : '']);
    } else {
      // 유형 미판별·기타 — 기간만. 계산 수량·단위는 우측 칸(저장된 수행 수량)에 표시(중복 표시 제거, 2026-11).
      text = period;
    }
    return <span style={{ ...ref, color: C.textSecondary }} title={text}>{text || '—'}</span>;
  }

  // ── 수정모드: 유형별 입력(§7·§14) — 한 줄 가로 배치 ──
  if (kind === 'interpretation') {
    return (
      <div style={wrap}>
        <DateRangeField start={r.performanceStartDate} end={r.performanceEndDate} onChange={onRangeChange} label="수행기간" />
        {(() => { const pd = periodDays(r.performanceStartDate, r.performanceEndDate); return pd ? <span style={ref} data-testid="perf-period-days">({pd}일간)</span> : null; })()}
        {/* 인원수는 개별 수행정보(통역사 1명 단위)에 표시하지 않음 — 스냅샷 데이터는 보존, 표시만 제외. */}
        <span style={ref}>{joinRef([snap.operationHours, snap.interpretDuration, snap.interpretPlace])}</span>
      </div>
    );
  }
  if (kind === 'equipment') {
    return (
      <div style={wrap}>
        <DateRangeField start={r.performanceStartDate} end={r.performanceEndDate} onChange={onRangeChange} label="임대기간" />
        {/* 임대기간과 장비 수량은 독립 — 기간을 바꿔도 우측 수량(세트·대수)은 바뀌지 않는다. 수량은 우측 칸에서만 입력. */}
        <span style={ref}>{joinRef([equipPeriodLabel(r, snap, ''), snap.itemLocation, snap.operationHours ? `설치 ${snap.operationHours}` : '', saleRefLabel(r, snap)])}</span>
      </div>
    );
  }
  if (kind === 'translation') {
    // 번역 수정모드: 작업기간(편집) + 작업량(단어/글자, 표시). 페이지 수량/단위 편집 UI는 두지 않는다 —
    //   페이지수는 판매정보에만 존재하며 수행원가(계약단가×단어/글자)에 사용하지 않는다(작업량은 판매 스냅샷 고정값).
    //   번역은 (a) 수량(quantity) 미변경(작업량=단어/글자, §10) (b) 납품일 자동연동 안 함 — 작업기간과 납품일은 독립(§3·§11).
    const onTransRange = (start: string, end: string) => {
      const p: Partial<Row> = {};
      if (start !== dateVal(r.performanceStartDate)) p.performanceStartDate = start;
      if (end !== dateVal(r.performanceEndDate)) p.performanceEndDate = end;
      if (Object.keys(p).length) patch(p);
    };
    return (
      <div style={wrap}>
        <DateRangeField start={r.performanceStartDate} end={r.performanceEndDate} onChange={onTransRange} label="작업기간" />
        {countInputs}
        {snap.fileName ? <FileNameChip name={snap.fileName} /> : null}
      </div>
    );
  }
  if (kind === 'expense') {
    return (
      <div style={wrap}>
        {qtyUnit}
        <span style={ref}>금액은 「기본수행료」 셀의 금액상세에서 입력</span>
      </div>
    );
  }
  return (
    <div style={wrap}>
      <DateRangeField start={r.performanceStartDate} end={r.performanceEndDate} onChange={onRangeChange} label="수행기간" />
      {countInputs}
    </div>
  );
}
