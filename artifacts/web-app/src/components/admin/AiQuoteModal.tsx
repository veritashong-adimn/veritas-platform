/**
 * AiQuoteModal — AI 견적 생성 v1
 *
 * 파일 업로드 두 영역:
 *   ① 고객 요청자료 — 이메일·발주서·이미지 등 (서비스 의도 파악용)
 *   ② 번역 원문     — 실제 번역 대상 파일 (글자수·단어수·페이지수 추출용)
 *
 * AI는 절대 자동 저장하지 않는다.
 * 관리자가 Preview 검토 후 "견적에 반영"을 눌렀을 때만 Workspace Row에 추가된다.
 */
import React, { useState, useRef, useEffect } from 'react';
import { api } from '../../lib/constants';
import { C, BD, TYPO, SP, BTN } from '../../lib/ds';
import { getPolicy } from '../../lib/languagePagePolicy';

// ─── 타입 ─────────────────────────────────────────────────────────────────────

type ServiceType = 'translation' | 'interpretation' | 'equipment' | 'expense';

export interface AiDraftRow {
  sourceFileId?:    string;   // 서버 할당 파일 고유 ID (source-0, source-1, …)
  productId:        number | null;
  productName:      string;
  productType:      ServiceType;
  quantity:         number;
  unit:             string;
  unitPrice:        number;
  memo:             string;
  sourceLanguage:   string;
  targetLanguage:   string;
  fileName:         string;
  fileFormat:       string;
  wordCount:        number;
  charCount:        number;
  countBasis:       string;
  interpretDate:    string;
  interpretEndDate: string;
  startTime:        string;
  endTime:          string;
  interpretPlace:   string;
  interpreterCount: number;
  eventStartDate:   string;
  eventEndDate:     string;
  itemLocation:     string;
  usagePeriod:      number;
  expenseType:      string;
  warnings:         string[];
  needsReview:      boolean;
}

export interface AiDraftResult {
  draftRows:  AiDraftRow[];
  warnings:   string[];
  confidence: 'high' | 'medium' | 'low';
}

interface Props {
  onApply: (rows: AiDraftRow[]) => void;
  onClose: () => void;
}

// ─── 서비스 유형 설정 ─────────────────────────────────────────────────────────

const SVC_CFG: Record<ServiceType, { label: string; color: string; bg: string }> = {
  translation:    { label: '번역',  color: C.primary,     bg: C.primaryBg },
  interpretation: { label: '통역',  color: C.successText, bg: C.successBg },
  equipment:      { label: '장비',  color: C.warning,     bg: C.warningBg },
  expense:        { label: '기타',  color: C.textMuted,   bg: C.g50       },
};

const CONF_CFG: Record<string, { label: string; color: string; bg: string }> = {
  high:   { label: '높음', color: '#15803d', bg: '#f0fdf4' },
  medium: { label: '보통', color: '#d97706', bg: '#fffbeb' },
  low:    { label: '낮음', color: '#dc2626', bg: '#fee2e2' },
};

// ─── 서비스별 상세 문자열 ─────────────────────────────────────────────────────

function getLangName(code: string): string {
  if (!code) return '';
  return getPolicy(code)?.languageName ?? code;
}

function fmtDetailText(row: AiDraftRow): string {
  const parts: string[] = [];
  switch (row.productType) {
    case 'interpretation':
      if (row.interpretDate) {
        parts.push(row.interpretEndDate
          ? `${row.interpretDate}~${row.interpretEndDate}` : row.interpretDate);
      }
      {
        const time = [row.startTime, row.endTime].filter(Boolean).join('~');
        if (time) parts.push(time);
      }
      if (row.interpretPlace)       parts.push(row.interpretPlace);
      if (row.interpreterCount > 0) parts.push(`${row.interpreterCount}명`);
      break;
    case 'equipment':
      if (row.eventStartDate) {
        parts.push(row.eventEndDate
          ? `${row.eventStartDate}~${row.eventEndDate}` : row.eventStartDate);
      }
      if (row.itemLocation)    parts.push(row.itemLocation);
      if (row.usagePeriod > 0) parts.push(`${row.usagePeriod}일`);
      break;
    case 'expense':
      if (row.expenseType) parts.push(row.expenseType);
      break;
    default: break;
  }
  return parts.join(' / ') || '-';
}

// 번역 Row 서비스별 상세 — 파일명 / 형식 / 분석 기준 / 단어수 / 글자수 / 페이지 표시
function TranslationDetail({ row }: { row: AiDraftRow }) {
  const src = getLangName(row.sourceLanguage);
  const tgt = getLangName(row.targetLanguage);

  const LBL: React.CSSProperties = { color: '#9ca3af', paddingRight: 8, whiteSpace: 'nowrap', fontSize: 11 };
  const VAL: React.CSSProperties = { color: '#374151', fontSize: 12 };

  const hasAny = src || tgt || row.fileName || row.wordCount || row.charCount;
  if (!hasAny) return <span style={{ color: '#9ca3af', fontSize: 12 }}>-</span>;

  return (
    <div style={{ fontSize: 12, lineHeight: 1.6 }}>
      {(src || tgt) && (
        <div style={{ fontWeight: 700, color: '#1e40af', marginBottom: 4 }}>
          {src && tgt ? `${src} → ${tgt}` : src || tgt}
        </div>
      )}
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <tbody>
          {row.fileName && (
            <tr>
              <td style={LBL}>파일명</td>
              <td style={{ ...VAL, wordBreak: 'break-all' }}>{row.fileName}</td>
            </tr>
          )}
          {row.fileFormat && (
            <tr>
              <td style={LBL}>형식</td>
              <td style={VAL}>{row.fileFormat}</td>
            </tr>
          )}
          {row.countBasis && (
            <tr>
              <td style={LBL}>분석 기준</td>
              <td style={{ ...VAL, fontWeight: 600, color: '#1d4ed8' }}>{row.countBasis}</td>
            </tr>
          )}
          {row.wordCount > 0 && (
            <tr>
              <td style={LBL}>단어수</td>
              <td style={VAL}>{row.wordCount.toLocaleString()}</td>
            </tr>
          )}
          {row.charCount > 0 && (
            <tr>
              <td style={LBL}>글자수</td>
              <td style={VAL}>{row.charCount.toLocaleString()}</td>
            </tr>
          )}
          {row.quantity > 0 && (
            <tr>
              <td style={LBL}>페이지</td>
              <td style={{ ...VAL, fontWeight: 700, color: '#2563eb' }}>{row.quantity.toLocaleString()}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function calcSupply(row: AiDraftRow): number {
  const cnt  = row.productType === 'interpretation' ? (row.interpreterCount || 1) : 1;
  const days = row.productType === 'equipment'      ? (row.usagePeriod      || 1) : 1;
  return Math.round(days * cnt * (row.quantity || 1) * (row.unitPrice || 0));
}

// ─── 파일 업로드 Card ─────────────────────────────────────────────────────────

interface FileUploadCardProps {
  label:       string;
  description: string;
  accept:      string;
  files:       File[];
  onAdd:       (files: FileList | File[]) => void;
  onRemove:    (idx: number) => void;
  testId:      string;
}

function FileUploadCard({ label, description, accept, files, onAdd, onRemove, testId }: FileUploadCardProps) {
  const [dragOver, setDragOver] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  return (
    <div style={{
      border: BD.card, borderRadius: BD.radius.lg,
      overflow: 'hidden',
    }}>
      {/* 카드 헤더 */}
      <div style={{
        padding: '10px 14px',
        background: C.g50,
        borderBottom: BD.card,
        display: 'flex', alignItems: 'baseline', gap: 8,
      }}>
        <span style={{ ...TYPO.fieldLabel }}>{label}</span>
        <span style={{ ...TYPO.helper }}>{description}</span>
      </div>

      {/* 드롭 영역 */}
      <div style={{ padding: '12px 14px' }}>
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); onAdd(e.dataTransfer.files); }}
          onClick={() => ref.current?.click()}
          style={{
            border: `2px dashed ${dragOver ? C.primary : C.g300}`,
            borderRadius: BD.radius.md,
            padding: '14px 12px',
            textAlign: 'center',
            cursor: 'pointer',
            background: dragOver ? C.primaryBg : C.bgCard,
            transition: 'all 0.15s',
          }}
          data-testid={testId}
        >
          <div style={{ fontSize: 20, marginBottom: 4 }}>📎</div>
          <div style={{ ...TYPO.helper, color: C.textMuted }}>
            클릭하거나 드래그하여 업로드
          </div>
          <input ref={ref} type="file" accept={accept} multiple style={{ display: 'none' }}
            onChange={e => e.target.files && onAdd(e.target.files)} />
        </div>

        {/* 파일 목록 */}
        {files.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {files.map((f, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '5px 10px',
                background: C.g50, borderRadius: BD.radius.sm, border: BD.card,
              }}>
                <span style={{ fontSize: 13 }}>📄</span>
                <span style={{ ...TYPO.inputValue, flex: 1, overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                <span style={{ ...TYPO.helper, flexShrink: 0 }}>
                  {(f.size / 1024).toFixed(0)}KB
                </span>
                <button
                  onClick={e => { e.stopPropagation(); onRemove(i); }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer',
                    color: C.textMuted, fontSize: 16, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
                  aria-label={`${f.name} 제거`}
                >×</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── 스타일 ───────────────────────────────────────────────────────────────────

const OVERLAY: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000,
  background: 'rgba(0,0,0,0.45)',
};

// MODAL 위치는 pos 여부에 따라 컴포넌트 내부에서 동적으로 계산
const MODAL_BASE: React.CSSProperties = {
  background: C.bgCard,
  borderRadius: BD.radius.xl,
  boxShadow: BD.shadow.modal,
  width: '92vw', maxWidth: 960,
  maxHeight: '90vh',
  display: 'flex', flexDirection: 'column',
  overflow: 'hidden',
  position: 'fixed',
};

const THEAD_CELL = (align: 'left' | 'center' | 'right' = 'left'): React.CSSProperties => ({
  ...TYPO.gridHeader,
  textAlign: align,
  padding: '8px 10px',
  background: C.g50,
  borderBottom: `2px solid ${C.g200}`,
  whiteSpace: 'nowrap',
});

const TD = (align: 'left' | 'center' | 'right' = 'left'): React.CSSProperties => ({
  ...TYPO.inputValue,
  textAlign: align,
  padding: '8px 10px',
  borderBottom: `1px solid ${C.g100}`,
  verticalAlign: 'top',
});

// ─── 메인 컴포넌트 ────────────────────────────────────────────────────────────

export default function AiQuoteModal({ onApply, onClose }: Props) {
  const [requestText,  setRequestText]  = useState('');
  const [reqFiles,     setReqFiles]     = useState<File[]>([]);
  const [srcFiles,     setSrcFiles]     = useState<File[]>([]);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState('');
  const [result,       setResult]       = useState<AiDraftResult | null>(null);

  // ── 드래그 이동 ───────────────────────────────────────────────────────────
  // pos=null → 화면 중앙 (초기·리셋). pos 설정 후 → fixed 절대 좌표
  const [pos,        setPos]        = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const drag     = useRef({ active: false, mouseX: 0, mouseY: 0, startX: 0, startY: 0 });

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!drag.current.active) return;
      const dx = e.clientX - drag.current.mouseX;
      const dy = e.clientY - drag.current.mouseY;
      const modal   = modalRef.current;
      const w       = modal?.offsetWidth  ?? 900;
      const HEADER  = 60;
      const newX    = Math.max(-(w - 120), Math.min(window.innerWidth - 120,  drag.current.startX + dx));
      const newY    = Math.max(0,          Math.min(window.innerHeight - HEADER, drag.current.startY + dy));
      setPos({ x: newX, y: newY });
    };
    const onUp = () => {
      if (!drag.current.active) return;
      drag.current.active = false;
      setIsDragging(false);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    };
  }, []);

  const handleHeaderMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return; // 닫기 버튼 제외
    const rect = modalRef.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = { active: true, mouseX: e.clientX, mouseY: e.clientY, startX: rect.left, startY: rect.top };
    setPos({ x: rect.left, y: rect.top });
    setIsDragging(true);
    e.preventDefault();
  };

  const addTo = (setter: React.Dispatch<React.SetStateAction<File[]>>) =>
    (incoming: FileList | File[]) => {
      const arr = Array.from(incoming);
      setter(prev => {
        const names = new Set(prev.map(f => f.name));
        return [...prev, ...arr.filter(f => !names.has(f.name))];
      });
    };

  const removeFrom = (setter: React.Dispatch<React.SetStateAction<File[]>>) =>
    (idx: number) => setter(prev => prev.filter((_, i) => i !== idx));

  // AI 분석 실행
  const handleAnalyze = async () => {
    if (!requestText.trim() && reqFiles.length === 0 && srcFiles.length === 0) {
      setError('요청내용을 입력하거나 파일을 업로드해 주세요.');
      return;
    }
    setError('');
    setLoading(true);
    setResult(null);

    try {
      const fd = new FormData();
      fd.append('requestText', requestText);
      reqFiles.forEach(f => fd.append('requestFiles', f));
      srcFiles.forEach(f => fd.append('sourceFiles',  f));

      const token = localStorage.getItem('auth_token');
      const resp  = await fetch(api('/api/quotes/ai-draft'), {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${resp.status}`);
      }

      const data = (await resp.json()) as AiDraftResult;
      console.log("[AI-DRAFT] Client received — rows:", data.draftRows.length, "confidence:", data.confidence);
      data.draftRows.forEach((r, i) => {
        console.log(
          `[AI-DRAFT] Row[${i}] ${r.fileName ?? "(no file)"} (${r.productType}):`,
          `countBasis=${r.countBasis}`,
          `wordCount=${r.wordCount}`,
          `charCount=${r.charCount}`,
          `quantity=${r.quantity}`,
          `unit=${r.unit}`,
        );
      });
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI 견적 생성 중 오류가 발생했습니다. 다시 시도해 주세요.');
    } finally {
      setLoading(false);
    }
  };

  // 견적에 반영
  const handleApply = () => {
    if (!result?.draftRows.length) return;
    onApply(result.draftRows);
    onClose();
  };

  const confCfg = result ? (CONF_CFG[result.confidence] ?? CONF_CFG.medium) : null;
  const hasAnyFile = reqFiles.length > 0 || srcFiles.length > 0;

  // 드래그 위치가 설정되면 절대 좌표, 아니면 화면 중앙 고정
  const modalStyle: React.CSSProperties = pos
    ? { ...MODAL_BASE, left: pos.x, top: pos.y }
    : { ...MODAL_BASE, left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };

  return (
    <div style={OVERLAY} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={modalRef} style={modalStyle}>

        {/* ── 헤더 (Drag Handle) ── */}
        <div
          onMouseDown={handleHeaderMouseDown}
          style={{
            padding: '18px 24px 14px',
            borderBottom: BD.card,
            display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
            cursor: isDragging ? 'grabbing' : 'grab',
            userSelect: 'none',
          }}
        >
          <span style={{ fontSize: 20 }}>🤖</span>
          <div>
            <div style={{ ...TYPO.sectionTitle }}>AI 견적 생성</div>
            <div style={{ ...TYPO.helper, marginTop: 2 }}>
              AI가 초안을 생성합니다. 검토 후 &quot;견적에 반영&quot;을 클릭하세요. 저장은 자동으로 이루어지지 않습니다.
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 20, color: C.textMuted, lineHeight: 1, padding: 4 }}
            aria-label="닫기"
          >×</button>
        </div>

        {/* ── 본문 (스크롤) ── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: SP[6] }}>

          {/* 1. 고객 요청내용 */}
          <div>
            <label style={{ ...TYPO.fieldLabel, display: 'block', marginBottom: SP[3] }}>
              고객 요청내용
            </label>
            <textarea
              value={requestText}
              onChange={e => setRequestText(e.target.value)}
              placeholder={`고객이 요청한 번역/통역/장비/기타 내용을 입력하세요.\n예: 한영 계약서 번역, PDF 3개, 납기 7월 15일, 긴급 건입니다.`}
              rows={4}
              style={{
                width: '100%', boxSizing: 'border-box',
                border: BD.input, borderRadius: BD.radius.lg,
                padding: '10px 12px', fontSize: 13, color: C.textPrimary,
                resize: 'vertical', outline: 'none', fontFamily: 'inherit',
                lineHeight: 1.6,
              }}
              data-testid="ai-request-text"
            />
          </div>

          {/* 2. 파일 업로드 — 2분할 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[5] }}>
            {/* ① 고객 요청자료 */}
            <FileUploadCard
              label="① 고객 요청자료"
              description="이메일·발주서·견적요청서 등 — 서비스 의도 파악용"
              accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.txt,.ppt,.pptx"
              files={reqFiles}
              onAdd={addTo(setReqFiles)}
              onRemove={removeFrom(setReqFiles)}
              testId="ai-req-drop"
            />

            {/* ② 번역 원문 */}
            <FileUploadCard
              label="② 번역 원문"
              description="번역 대상 파일 — 글자수·단어수·페이지수 자동 분석"
              accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.txt,.ppt,.pptx,.xls,.xlsx,.hwp,.hwpx"
              files={srcFiles}
              onAdd={addTo(setSrcFiles)}
              onRemove={removeFrom(setSrcFiles)}
              testId="ai-src-drop"
            />
          </div>

          {/* 3. 오류 메시지 */}
          {error && (
            <div style={{
              padding: '10px 14px', borderRadius: BD.radius.md,
              background: C.dangerBg, border: `1px solid ${C.dangerBorder}`,
              ...TYPO.inputValue, color: C.dangerText,
            }}>
              {error}
            </div>
          )}

          {/* 4. AI 분석하기 */}
          <button
            onClick={handleAnalyze}
            disabled={loading}
            style={{
              ...BTN.base, ...BTN.size.lg,
              ...(loading
                ? { background: C.g200, color: C.textDisabled, cursor: 'not-allowed' }
                : { background: C.ai, color: '#ffffff' }),
              width: '100%', justifyContent: 'center',
            }}
            data-testid="ai-analyze-btn"
          >
            {loading ? '⏳ AI 분석 중…' : `🤖 AI 분석하기${hasAnyFile ? ` (파일 ${reqFiles.length + srcFiles.length}개)` : ''}`}
          </button>

          {/* 5. Preview */}
          {result && (
            <div>
              {/* 신뢰도 + 전역 경고 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: SP[4] }}>
                <div style={{ ...TYPO.fieldLabel }}>AI 분석 결과</div>
                {confCfg && (
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 99,
                    background: confCfg.bg, color: confCfg.color,
                  }}>
                    신뢰도: {confCfg.label}
                  </span>
                )}
                <span style={{ ...TYPO.helper }}>
                  총 {result.draftRows.length}건
                </span>
              </div>

              {result.warnings.length > 0 && (
                <div style={{
                  padding: '8px 12px', borderRadius: BD.radius.md, marginBottom: SP[4],
                  background: C.warningBg, border: `1px solid ${C.warningBorder}`,
                }}>
                  {result.warnings.map((w, i) => (
                    <div key={i} style={{ ...TYPO.helper, color: C.warningText }}>⚠ {w}</div>
                  ))}
                </div>
              )}

              {result.draftRows.length === 0 ? (
                <div style={{
                  padding: '24px', textAlign: 'center',
                  ...TYPO.inputValue, color: C.textMuted,
                  background: C.g50, borderRadius: BD.radius.lg, border: BD.card,
                }}>
                  분석 가능한 항목을 찾지 못했습니다. 요청내용을 더 상세하게 입력해 보세요.
                </div>
              ) : (
                <div style={{ border: BD.card, borderRadius: BD.radius.lg, overflow: 'hidden' }}>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr>
                          <th style={THEAD_CELL('center')}>#</th>
                          <th style={THEAD_CELL()}>유형</th>
                          <th style={THEAD_CELL()}>추천 상품</th>
                          <th style={THEAD_CELL()}>서비스별 상세</th>
                          <th style={THEAD_CELL('right')}>수량</th>
                          <th style={THEAD_CELL('center')}>단위</th>
                          <th style={THEAD_CELL('right')}>단가</th>
                          <th style={THEAD_CELL('right')}>공급가액</th>
                          <th style={THEAD_CELL()}>비고 / 확인</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.draftRows.map((row, i) => {
                          const cfg    = SVC_CFG[row.productType] ?? SVC_CFG.expense;
                          const supply = calcSupply(row);
                          const hasW   = row.needsReview || row.warnings.length > 0;
                          return (
                            <tr key={i} style={{ background: hasW ? '#fffbeb' : undefined }}>
                              <td style={TD('center')}>{i + 1}</td>
                              <td style={TD()}>
                                <span style={{
                                  display: 'inline-block', fontSize: 11, fontWeight: 700,
                                  padding: '2px 6px', borderRadius: 4,
                                  background: cfg.bg, color: cfg.color, whiteSpace: 'nowrap',
                                }}>{cfg.label}</span>
                              </td>
                              <td style={TD()}>
                                {row.productId ? (
                                  <span style={{ color: C.textPrimary }}>{row.productName}</span>
                                ) : (
                                  <span style={{
                                    color: C.dangerText, fontSize: 11, fontWeight: 700,
                                    background: C.dangerBg, padding: '1px 5px', borderRadius: 4,
                                  }}>상품 확인 필요</span>
                                )}
                              </td>
                              <td style={{ ...TD(), maxWidth: 280 }}>
                                {row.productType === 'translation'
                                  ? <TranslationDetail row={row} />
                                  : <span style={{ color: C.textSecondary }}>{fmtDetailText(row)}</span>
                                }
                              </td>
                              <td style={TD('right')}>{row.quantity.toLocaleString()}</td>
                              <td style={TD('center')}>{row.unit}</td>
                              <td style={TD('right')}>
                                {row.unitPrice > 0
                                  ? row.unitPrice.toLocaleString()
                                  : <span style={{ color: C.dangerText, fontSize: 11, fontWeight: 700 }}>확인필요</span>
                                }
                              </td>
                              <td style={{ ...TD('right'), fontWeight: 600, color: C.amount }}>
                                {supply > 0 ? supply.toLocaleString() : '-'}
                              </td>
                              <td style={TD()}>
                                {row.memo && <div style={{ color: C.textMuted }}>{row.memo}</div>}
                                {row.warnings.map((w, wi) => (
                                  <div key={wi} style={{
                                    fontSize: 11, color: C.warningText,
                                    background: C.warningBg, padding: '1px 5px',
                                    borderRadius: 3, marginTop: 2, display: 'inline-block',
                                  }}>⚠ {w}</div>
                                ))}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── 하단 버튼 ── */}
        <div style={{
          padding: '14px 24px',
          borderTop: BD.card,
          display: 'flex', justifyContent: 'flex-end', gap: 10,
          flexShrink: 0, background: C.bgCard,
        }}>
          <button
            onClick={onClose}
            style={{ ...BTN.base, ...BTN.size.md, ...BTN.variant.secondary, border: `1px solid ${C.g300}` }}
            data-testid="ai-cancel-btn"
          >
            취소
          </button>
          {result && result.draftRows.length > 0 && (
            <button
              onClick={handleApply}
              style={{ ...BTN.base, ...BTN.size.md, ...BTN.variant.ai }}
              data-testid="ai-apply-btn"
              aria-label="AI 초안을 현재 견적에 반영"
            >
              ✅ 견적에 반영 ({result.draftRows.length}건)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
