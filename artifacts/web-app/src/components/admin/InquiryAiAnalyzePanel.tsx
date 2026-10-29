/**
 * InquiryAiAnalyzePanel — 의뢰건 AI 분석 및 자동입력
 *
 * 흐름: 자료 입력(복수 파일 + 텍스트 붙여넣기) → AI 분석 → 등록폼 자동입력 → PM 검토/수정 → PM이 직접 등록.
 *
 * ⚠ 이 패널은 "분석·자동입력"만 한다. 의뢰건을 자동으로 등록하지 않는다.
 *    분석 결과는 onApply 로 상위 폼 상태에 채워지고, 최종 등록은 기존 「의뢰건 등록」 버튼(PM 수동)으로만 이루어진다.
 *
 * 백엔드: POST /api/admin/inquiries/ai-analyze (extractText + GPT-4o, DB 저장 없음).
 * 지원 형식: 이미지/PDF/Word/HWP/HWPX/Excel/TXT · 복수 파일.
 */
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/constants';

/** AI가 채워줄 의뢰건 필드(등록폼 InquiryFormState 의 부분집합, 모두 문자열). */
export interface AiInquiryFields {
  // 고객 접수일시(원문의 고객 제출 일시가 있을 때만 날짜/시각) + 상태·출처
  customerReceivedDate?: string; customerReceivedTime?: string; customerReceivedStatus?: string; customerReceivedSource?: string;
  channel?: string; serviceType?: string;
  serviceTypes?: string[]; otherServices?: string[];   // 복수 서비스 제안(자동 입력 제안 전용)
  customerCompanyName?: string; department?: string; contactName?: string; contactPosition?: string;
  contactPhone?: string; contactMobile?: string; contactEmail?: string;
  languageFrom?: string; languageTo?: string;
  subject?: string; requirements?: string; quoteDueDate?: string;
  interpretType?: string; scheduleFrom?: string; scheduleTo?: string; interpretDuration?: string; place?: string;
  documentType?: string; documentUsage?: string; volume?: string; desiredCompletionDate?: string;
}
export interface AiInquiryEquipment {
  kind: string; quantity: string; unit: string; location: string; note: string; days?: string;
  // 원문 값(장비명·Quantity·Hr/Day·단가·금액)과 해석 표시 — 패널의 「장비 분석」 표에서 원문과 적용값을 나란히 보여 준다
  sourceName?: string; sourceQuantity?: string; sourceHrDay?: string; unitPrice?: string; amount?: string;
  inferred?: string[]; kindBasis?: 'exact' | 'synonym' | 'none'; unitBasis?: 'source' | 'name' | 'default' | 'none';
}

/** AI 적용 결과(상위 등록 탭이 반환) — 패널이 사용자에게 보여준다 */
export interface AiApplyReport {
  /** 사용자 수정값/Master 연결값과 AI 새 값이 다른 항목(현재 값 유지, 사용자가 선택) */
  conflicts: Array<{ key: string; current: string; ai: string; reason: 'user' | 'master' }>;
  /** 이전 AI 값이 재분석으로 바뀐 항목(사용자 미수정) */
  replaced: Array<{ key: string; prev: string; ai: string }>;
}

interface AnalyzeResponse {
  fields: AiInquiryFields;
  equipment: AiInquiryEquipment[];
  confidence: 'high' | 'medium' | 'low' | string;
  warnings: string[];
  extractedText?: Array<{ name: string; method: string; text: string }>;              // 파일/이미지에서 추출한 원문
  additionalLanguagePairs?: Array<{ from: string; to: string; context: string; note: string }>; // 주 언어 외 추가 조합
  meta?: { fileCount: number; perFile?: Array<{ name: string; chars: number; method: string; warning?: string }>; engine?: string };
  verification?: Record<string, { value: string; status: 'verified' | 'inferred'; evidence: string }>;
  channelGuess?: { channel: string; evidence: string; certain: boolean };
  emailDates?: { received?: { value: string; line: string }; sent?: { value: string; line: string } };
  receivedAtInfo?: { status: 'confirmed' | 'needs_review' | 'not_provided'; evidence?: string; candidates: Array<{ kind: string; label: string; date: string; time: string | null; line: string }> };
  dateFields?: Record<string, { label: string; raw: string; normalized: string | null; yearBasis: 'explicit' | 'document' | 'uncertain'; status: 'confirmed' | 'needs_review' }>;
  trace?: unknown;   // 개발환경 전용 단계별 추적
  // 이메일 업무 맥락(업무 유형·작성자/수신자 역할) + 기존 CRM·의뢰/프로젝트 후보(조회만 — 자동 연결·생성 없음)
  emailContext?: {
    emailTypeLabels: string[]; direction: 'inbound' | 'outbound' | 'unknown';
    customer: { company: string; contactName: string; contactTitle: string; basis: string; status: 'verified' | 'inferred' } | null;
    internalStaff: Array<{ name: string; title: string; evidence: string }>;
    companies: Array<{ name: string; role: string; roleLabel: string }>;
  };
  fieldConfidence?: Record<string, 'high' | 'medium' | 'low'>;
  crmMatch?: { company: { action: string; name?: string; reason: string }; contact: { action: string; name?: string; reason: string; candidates: Array<{ id: number; name: string }> } } | null;
  projectCandidates?: Array<{ kind: 'inquiry' | 'project'; id: number; label: string; date: string | null; status: string; reasons: string[] }>;
}

/** 폼 필드 키 → 화면 라벨(보존 안내용) */
const FIELD_LABELS: Record<string, string> = {
  customerReceivedDate: '고객 접수일', customerReceivedTime: '고객 접수시각', customerReceivedStatus: '접수일시 확인 상태', customerReceivedSource: '접수일시 출처',
  channel: '접수경로', serviceType: '서비스 유형', customerCompanyName: '회사명', department: '부서', contactName: '담당자',
  contactPosition: '직함', contactPhone: '전화번호', contactMobile: '휴대폰', contactEmail: '이메일',
  languageFrom: '출발 언어', languageTo: '도착 언어', subject: '주제', requirements: '요구사항', quoteDueDate: '견적서 수령 희망일',
  interpretType: '통역 형태', scheduleFrom: '시작일', scheduleTo: '종료일', interpretDuration: '1일 통역시간', place: '장소',
  documentType: '원문서 형태', documentUsage: '문서 사용처', volume: '분량', desiredCompletionDate: '완료 희망일',
};

const DIRECTION_NAMES: Record<string, string> = { inbound: '고객 → 베리타스', outbound: '베리타스 → 외부', unknown: '' };
const CRM_ACTION_NAMES: Record<string, string> = { link: '기존 연결', create: '신규 등록 예정', confirm: '확인 필요', none: '정보 부족' };
const KEY_FIELD_NAMES: Record<string, string> = { customerCompanyName: '고객사', contactName: '담당자', schedule: '일정', language: '언어', place: '장소', interpretType: '통역 형태' };
const CHANNEL_NAMES: Record<string, string> = { email: '이메일', phone: '전화', homepage: '홈페이지', kakao: '카카오', other: '기타' };

const sectionTitle: React.CSSProperties = { fontSize: 13, fontWeight: 800, color: '#111827', margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: 8 };
const CONF_META: Record<string, { label: string; color: string; bg: string; border: string }> = {
  high:   { label: '높음', color: '#065f46', bg: '#ecfdf5', border: '#a7f3d0' },
  medium: { label: '보통', color: '#92400e', bg: '#fffbeb', border: '#fde68a' },
  low:    { label: '낮음', color: '#991b1b', bg: '#fef2f2', border: '#fecaca' },
};

export function InquiryAiAnalyzePanel({ token, onApply, onToast, onDirtyChange, onResetAi, onResolveConflict }: {
  token: string;
  /** 반환값: 충돌(사용자 수정값·Master 연결값 유지) / 재분석으로 바뀐 AI 값 */
  onApply: (fields: AiInquiryFields, equipment: AiInquiryEquipment[]) => AiApplyReport | void;
  onToast: (m: string) => void;
  /** 「분석 초기화」 — 상위가 확인창·AI 입력값 되돌리기 후 패널을 리마운트한다 */
  onResetAi?: () => void | Promise<void>;
  /** 충돌 항목에서 「AI 값 적용」 선택 */
  onResolveConflict?: (key: string, value: string) => void;
  onDirtyChange?: (dirty: boolean) => void;   // 미분석 입력(텍스트/파일/결과) 존재 여부 보고 — 상위 초기화 확인창용
}) {
  const [open, setOpen] = useState(true);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [drag, setDrag] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [report, setReport] = useState<AiApplyReport>({ conflicts: [], replaced: [] });
  const [showSource, setShowSource] = useState(false);
  const [showTrace, setShowTrace] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 상위(등록 탭)에 미분석 입력 존재 여부를 보고 → 초기화 확인창 판단에 사용.
  useEffect(() => {
    onDirtyChange?.(text.trim().length > 0 || files.length > 0 || result !== null);
  }, [text, files, result, onDirtyChange]);

  const addFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setFiles(prev => [...prev, ...Array.from(list)]);
  };
  const removeFile = (i: number) => setFiles(prev => prev.filter((_, j) => j !== i));

  const analyze = async () => {
    if (!text.trim() && files.length === 0) { onToast('분석할 텍스트를 입력하거나 파일을 추가하세요.'); return; }
    setAnalyzing(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('text', text);
      files.forEach(f => fd.append('files', f));
      const url = api('/api/admin/inquiries/ai-analyze');
      console.info('[INQ-AI] POST', url, `files=${files.length} text=${text.length}ch`);
      const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });

      // 본문을 먼저 텍스트로 읽어 JSON 여부를 판별한다.
      // 구버전 API 서버(라우트 미배포)는 404 또는 SPA fallback(HTML)을 반환하는데,
      // 이때 res.json()이 조용히 실패해 빈 결과로 진행되던 문제(자동입력 무반영)를 방지한다.
      const rawBody = await res.text();
      let data: AnalyzeResponse | null = null;
      try { data = JSON.parse(rawBody) as AnalyzeResponse; } catch { /* JSON 아님 */ }

      if (!res.ok || !data || typeof data !== 'object' || !('fields' in data)) {
        console.error('[INQ-AI] 비정상 응답', { status: res.status, ok: res.ok, bodyPreview: rawBody.slice(0, 200) });
        const looksHtml = res.status === 404 || /<!doctype html|<html/i.test(rawBody);
        onToast(looksHtml
          ? 'AI 분석 엔드포인트를 찾을 수 없습니다. API 서버 재빌드/재시작이 필요할 수 있습니다.'
          : ((data as { error?: string } | null)?.error ?? `AI 분석 실패 (HTTP ${res.status})`));
        return;
      }

      setResult(data);
      const filled = Object.values(data.fields ?? {}).filter(v => typeof v === 'string' && v.trim()).length;
      const eqCount = data.equipment?.length ?? 0;
      console.info('[INQ-AI] 응답 수신', { confidence: data.confidence, filled, equipment: eqCount });
      const rep = onApply(data.fields ?? {}, data.equipment ?? []) || { conflicts: [], replaced: [] };
      setReport(rep);
      onToast(filled === 0 && eqCount === 0
        ? 'AI가 자동입력할 항목을 찾지 못했습니다. 경고를 확인하세요.'
        : `AI 분석 완료 — 자동입력했습니다${rep.conflicts.length ? ` (직접 수정한 값과 다른 ${rep.conflicts.length}개 항목은 유지, 아래에서 확인)` : ''}. 검토 후 등록하세요.`);
    } catch (e) {
      console.error('[INQ-AI] 요청 오류', e);
      onToast('AI 분석 중 오류가 발생했습니다. (네트워크/서버 상태를 확인하세요)');
    } finally {
      setAnalyzing(false);
    }
  };

  const conf = result ? (CONF_META[result.confidence] ?? CONF_META.medium) : null;

  return (
    <div data-testid="inq-ai-panel" style={{ border: '1px solid #ddd6fe', background: '#faf5ff', borderRadius: 12, padding: '16px 18px', marginBottom: 18 }}>
      <div style={sectionTitle}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span aria-hidden style={{ fontSize: 15 }}>✨</span> AI 자동분석 <span style={{ fontSize: 11, fontWeight: 700, color: '#7c3aed', background: '#ede9fe', border: '1px solid #ddd6fe', borderRadius: 6, padding: '1px 7px' }}>베타</span>
        </span>
        <button type="button" onClick={() => setOpen(o => !o)} data-testid="inq-ai-toggle" aria-expanded={open}
          style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: '#7c3aed', background: 'none', border: 'none', cursor: 'pointer' }}>
          {open ? '접기' : '펼치기'}
        </button>
      </div>

      {open && (
        <>
          <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
            고객 이메일·문서·이미지를 올리거나 내용을 붙여넣으면 AI가 접수 항목을 분석해 아래 폼에 자동입력합니다.
            <b style={{ color: '#7c3aed' }}> AI는 분석·자동입력만 하며, 최종 등록은 검토 후 직접 진행합니다.</b>
          </p>

          {/* 텍스트 붙여넣기 */}
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 }}>내용 붙여넣기 <span style={{ color: '#9ca3af', fontWeight: 400 }}>(이메일/메신저 대화 등)</span></label>
          <textarea
            value={text} onChange={e => setText(e.target.value)} data-testid="inq-ai-text"
            rows={4} placeholder="예) 안녕하세요, 9월 1일 코엑스에서 열리는 세미나 동시통역(한↔영) 견적 부탁드립니다..."
            style={{ width: '100%', boxSizing: 'border-box', padding: '9px 11px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 8, outline: 'none', resize: 'vertical' }} />

          {/* 파일 드롭존 (복수) */}
          <div
            data-testid="inq-ai-dropzone"
            role="button" tabIndex={0} aria-label="분석할 파일 선택 또는 끌어다 놓기"
            onClick={() => inputRef.current?.click()}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
            onDragOver={e => { e.preventDefault(); if (!drag) setDrag(true); }}
            onDragLeave={e => { e.preventDefault(); setDrag(false); }}
            onDrop={e => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
            style={{
              marginTop: 10, border: `1.5px dashed ${drag ? '#7c3aed' : '#c4b5fd'}`,
              background: drag ? '#f5f3ff' : '#fff', borderRadius: 10, padding: '18px', textAlign: 'center', cursor: 'pointer',
            }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: drag ? '#7c3aed' : '#4b5563' }}>파일을 선택하거나 여기에 끌어다 놓으세요 (복수 가능)</div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>이미지 · PDF · Word · 한글(HWP/HWPX) · Excel · PowerPoint · TXT</div>
          </div>
          <input ref={inputRef} type="file" multiple data-testid="inq-ai-files"
            accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.txt,.ppt,.pptx,.xls,.xlsx,.hwp,.hwpx"
            onChange={e => { addFiles(e.target.files); e.target.value = ''; }} style={{ display: 'none' }} />

          {files.length > 0 && (
            <ul data-testid="inq-ai-filelist" style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: '#374151' }}>
              {files.map((f, i) => (
                <li key={i}>{f.name} <span style={{ color: '#9ca3af' }}>({Math.round(f.size / 1024)}KB)</span>
                  <button type="button" onClick={() => removeFile(i)} data-testid={`inq-ai-file-del-${i}`} aria-label={`${f.name} 제거`}
                    style={{ marginLeft: 6, fontSize: 11, color: '#dc2626', border: 'none', background: 'none', cursor: 'pointer' }}>삭제</button>
                </li>
              ))}
            </ul>
          )}

          {/* 분석 초기화 · 분석 버튼 */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            {onResetAi && (
              <button type="button" onClick={() => { void onResetAi(); }} disabled={analyzing} data-testid="inq-ai-reset" aria-label="AI 분석 초기화"
                style={{ padding: '9px 16px', borderRadius: 8, border: '1px solid #c4b5fd', background: '#fff', color: '#7c3aed', fontSize: 13, fontWeight: 700, cursor: analyzing ? 'not-allowed' : 'pointer' }}>
                분석 초기화
              </button>
            )}
            <button type="button" onClick={analyze} disabled={analyzing} data-testid="inq-ai-analyze"
              style={{ padding: '9px 22px', borderRadius: 8, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, background: analyzing ? '#c4b5fd' : '#7c3aed', cursor: analyzing ? 'not-allowed' : 'pointer' }}>
              {analyzing ? 'AI 분석 중…' : 'AI 분석 → 자동입력'}
            </button>
          </div>

          {/* 결과 요약 */}
          {result && (
            <div data-testid="inq-ai-result" style={{ marginTop: 12, padding: '12px 14px', background: '#fff', border: '1px solid #e9d5ff', borderRadius: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700, color: '#4b5563' }}>
                분석 신뢰도
                {conf && <span style={{ fontSize: 11, fontWeight: 800, color: conf.color, background: conf.bg, border: `1px solid ${conf.border}`, borderRadius: 6, padding: '1px 8px' }}>{conf.label}</span>}
                <span style={{ marginLeft: 'auto', fontWeight: 400, color: '#9ca3af' }}>자동입력됨 · 아래 폼에서 모든 항목을 수정할 수 있습니다(수정한 값은 재분석해도 유지)</span>
                {result.meta?.engine && <span data-testid="inq-ai-engine" style={{ fontWeight: 400, color: '#c4b5fd', fontSize: 10 }}>{result.meta.engine}</span>}
              </div>
              {report.conflicts.length > 0 && (
                <div data-testid="inq-ai-conflicts" style={{ marginTop: 8, padding: '8px 10px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, fontSize: 12, color: '#1e3a8a' }}>
                  <b>충돌 항목</b> — 현재 값을 유지했습니다. AI 값으로 바꾸려면 「AI 값 적용」을 누르세요.
                  {report.conflicts.map(c => (
                    <div key={c.key} data-testid={`inq-ai-conflict-${c.key}`} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, minWidth: 72 }}>{FIELD_LABELS[c.key] ?? c.key}</span>
                      <span>현재 「{c.current || '(빈 값)'}」{c.reason === 'master' ? ' · 기존 담당자 연결값' : ' · 직접 수정'}</span>
                      <span style={{ color: '#6b7280' }}>/ AI 「{c.ai}」</span>
                      <button type="button" data-testid={`inq-ai-conflict-apply-${c.key}`} aria-label={`${FIELD_LABELS[c.key] ?? c.key} AI 값 적용`}
                        onClick={() => { onResolveConflict?.(c.key, c.ai); setReport(r => ({ ...r, conflicts: r.conflicts.filter(x => x.key !== c.key) })); }}
                        style={{ marginLeft: 'auto', padding: '3px 10px', fontSize: 11, fontWeight: 700, color: '#fff', background: '#2563eb', border: 'none', borderRadius: 6, cursor: 'pointer' }}>AI 값 적용</button>
                      <button type="button" data-testid={`inq-ai-conflict-keep-${c.key}`} aria-label={`${FIELD_LABELS[c.key] ?? c.key} 현재 값 유지`}
                        onClick={() => setReport(r => ({ ...r, conflicts: r.conflicts.filter(x => x.key !== c.key) }))}
                        style={{ padding: '3px 10px', fontSize: 11, fontWeight: 700, color: '#1e40af', background: '#fff', border: '1px solid #bfdbfe', borderRadius: 6, cursor: 'pointer' }}>현재 값 유지</button>
                    </div>
                  ))}
                </div>
              )}
              {result.emailContext && (
                <div data-testid="inq-ai-email-context" style={{ marginTop: 8, padding: '8px 10px', fontSize: 12, color: '#374151', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, lineHeight: 1.7 }}>
                  {result.emailContext.emailTypeLabels.length > 0 && (
                    <div data-testid="inq-ai-email-type">업무 유형: <b>{result.emailContext.emailTypeLabels.join(' · ')}</b>
                      {DIRECTION_NAMES[result.emailContext.direction] && <span style={{ color: '#6b7280' }}> ({DIRECTION_NAMES[result.emailContext.direction]})</span>}
                      {!result.emailContext.emailTypeLabels.includes('신규 고객 의뢰') && <span style={{ color: '#b45309' }}> — 신규 의뢰가 아닐 수 있습니다. 신규 등록은 확인 후 진행하세요.</span>}
                    </div>
                  )}
                  {result.emailContext.customer && (
                    <div data-testid="inq-ai-customer-basis">고객: <b>{[result.emailContext.customer.company, result.emailContext.customer.contactName && `${result.emailContext.customer.contactName}${result.emailContext.customer.contactTitle ? ` ${result.emailContext.customer.contactTitle}` : ''}`].filter(Boolean).join(' / ')}</b>
                      <span style={{ color: '#6b7280' }}> — {result.emailContext.customer.status === 'verified' ? '확인' : '문맥 추론'} · {result.emailContext.customer.basis}</span>
                    </div>
                  )}
                  {result.emailContext.internalStaff.length > 0 && (
                    <div data-testid="inq-ai-internal-staff">베리타스 내부 담당자: <b>{result.emailContext.internalStaff.map(s => `${s.name}${s.title ? ` ${s.title}` : ''}`).join(', ')}</b> <span style={{ color: '#6b7280' }}>(담당 PM은 자동 배정하지 않습니다)</span></div>
                  )}
                  {result.emailContext.companies.filter(c => c.role !== 'customer').length > 0 && (
                    <div data-testid="inq-ai-company-roles">기타 회사: {result.emailContext.companies.filter(c => c.role !== 'customer').map(c => `${c.name}(${c.roleLabel})`).join(', ')}</div>
                  )}
                  {result.fieldConfidence && Object.keys(result.fieldConfidence).length > 0 && (
                    <div data-testid="inq-ai-field-confidence">항목별 신뢰도: {Object.entries(result.fieldConfidence).map(([k, v]) => (
                      <span key={k} style={{ marginRight: 8, color: CONF_META[v]?.color ?? '#374151' }}>{KEY_FIELD_NAMES[k] ?? k} {CONF_META[v]?.label ?? v}</span>
                    ))}</div>
                  )}
                  {result.crmMatch && (
                    <div data-testid="inq-ai-crm-match">기존 CRM: 거래처 <b>{CRM_ACTION_NAMES[result.crmMatch.company.action] ?? result.crmMatch.company.action}</b>{result.crmMatch.company.name ? ` 「${result.crmMatch.company.name}」` : ''}
                      {' · '}담당자 <b>{CRM_ACTION_NAMES[result.crmMatch.contact.action] ?? result.crmMatch.contact.action}</b>{result.crmMatch.contact.name ? ` 「${result.crmMatch.contact.name}」` : ''}
                      {result.crmMatch.contact.action === 'confirm' && result.crmMatch.contact.candidates.length > 0 && <span style={{ color: '#6b7280' }}> (후보: {result.crmMatch.contact.candidates.map(c => c.name).join(', ')})</span>}
                      <span style={{ color: '#9ca3af' }}> — 실제 연결은 저장 시 기존 절차로 진행</span>
                    </div>
                  )}
                  {(result.projectCandidates?.length ?? 0) > 0 && (
                    <div data-testid="inq-ai-project-candidates">기존 의뢰·프로젝트 연결 후보(자동 연결 없음):
                      <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
                        {result.projectCandidates!.map(p => (
                          <li key={`${p.kind}-${p.id}`}>{p.kind === 'inquiry' ? '의뢰건' : '프로젝트'} {p.label}{p.date ? ` (${p.date})` : ''} <span style={{ color: '#6b7280' }}>— {p.reasons.join(', ')}</span></li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
              {result.channelGuess && (
                <div data-testid="inq-ai-channel" style={{ marginTop: 8, fontSize: 12, color: result.channelGuess.channel ? '#374151' : '#b45309' }}>
                  접수경로: <b>{CHANNEL_NAMES[result.channelGuess.channel] ?? '확인 필요'}</b>
                  {result.channelGuess.evidence && <span style={{ color: '#6b7280' }}> — 근거 「{result.channelGuess.evidence}」{result.channelGuess.certain ? '' : ' (추정)'}</span>}
                </div>
              )}
              {result.receivedAtInfo && (
                <div data-testid="inq-ai-receivedat" style={{ marginTop: 6, fontSize: 12, color: '#374151' }}>
                  {result.receivedAtInfo.status === 'confirmed'
                    ? <>고객 접수일시: <b>확정</b> <span style={{ color: '#6b7280' }}>— 근거 「{result.receivedAtInfo.evidence}」</span></>
                    : result.receivedAtInfo.status === 'needs_review'
                      ? <span style={{ color: '#b45309' }}>고객 접수일시 <b>확인 필요</b> — 고객 제출 일시를 확정할 수 없습니다. 아래 후보는 제출 시각과 같다고 단정할 수 없습니다.</span>
                      : <span style={{ color: '#6b7280' }}>고객 접수일시 <b>미기재</b> — 원문에 고객 제출·메일 수신 일시가 없어 공란으로 두었습니다.</span>}
                  {result.receivedAtInfo.status !== 'confirmed' && onResolveConflict && result.receivedAtInfo.candidates.filter(c => /^\d{4}-/.test(c.date)).map(c => (
                    <div key={c.kind} data-testid={`inq-ai-receivedat-cand-${c.kind}`} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                      {c.label} <b>{c.date}{c.time ? ` ${c.time}` : ''}</b> <span style={{ color: '#9ca3af' }}>「{c.line}」</span>
                      <button type="button" data-testid={`inq-ai-receivedat-apply-${c.kind}`} aria-label={`${c.label}을 고객 접수일시로 적용`}
                        onClick={() => {
                          // 직원 결정으로 적용 — 출처는 후보 종류 그대로 기록(제출 일시로 둔갑시키지 않음)
                          onResolveConflict('customerReceivedDate', c.date);
                          onResolveConflict('customerReceivedTime', c.time ?? '');
                          onResolveConflict('customerReceivedStatus', 'confirmed');
                          onResolveConflict('customerReceivedSource', c.kind === 'received' ? 'email_received' : c.kind === 'sent' ? 'email_sent' : 'unknown');
                        }}
                        style={{ padding: '3px 10px', fontSize: 11, fontWeight: 700, color: '#7c3aed', background: '#fff', border: '1px solid #c4b5fd', borderRadius: 6, cursor: 'pointer' }}>고객 접수일시로 적용</button>
                    </div>
                  ))}
                </div>
              )}
              {result.dateFields?.quoteDueDate && (
                <div data-testid="inq-ai-quotedue" style={{ marginTop: 6, fontSize: 12, color: result.dateFields.quoteDueDate.status === 'confirmed' ? '#374151' : '#b45309' }}>
                  견적서 수령 희망일: 원문 「{result.dateFields.quoteDueDate.raw}」({result.dateFields.quoteDueDate.label})
                  {result.dateFields.quoteDueDate.normalized
                    ? <> → <b>{result.dateFields.quoteDueDate.normalized}</b> <span style={{ color: '#9ca3af' }}>{result.dateFields.quoteDueDate.yearBasis === 'document' ? '(연도: 문서 날짜 기준)' : ''}</span></>
                    : <> → <b>확인 필요</b> (연도를 확정할 수 없어 입력하지 않음)</>}
                </div>
              )}
              {report.replaced.length > 0 && (
                <div data-testid="inq-ai-replaced" style={{ marginTop: 8, fontSize: 12, color: '#4b5563' }}>
                  재분석으로 바뀐 AI 입력값: {report.replaced.map(r => `${FIELD_LABELS[r.key] ?? r.key} 「${r.prev}」→「${r.ai}」`).join(' · ')}
                </div>
              )}
              {(result.additionalLanguagePairs?.length ?? 0) > 0 && (
                <div data-testid="inq-ai-addl-langs" style={{ marginTop: 8, padding: '8px 10px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 12, color: '#92400e' }}>
                  <b>추가 언어 조합</b> — 주 언어는 {result.fields.languageFrom || '?'} → {result.fields.languageTo || '?'}로 입력했습니다. 아래 조합은 요구사항에 기록했습니다.
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {result.additionalLanguagePairs!.map((p, i) => <li key={i}><b>{p.from} → {p.to}</b> <span style={{ color: '#b45309' }}>({p.note})</span> — <span style={{ color: '#6b7280' }}>{p.context}</span></li>)}
                  </ul>
                </div>
              )}
              {result.equipment?.length > 0 && <EquipmentAnalysis rows={result.equipment} />}
              {result.warnings.length > 0 && (
                <ul data-testid="inq-ai-warnings" style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: '#92400e' }}>
                  {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
              {result.trace != null && (
                <div style={{ marginTop: 8 }}>
                  <button type="button" onClick={() => setShowTrace(v => !v)} data-testid="inq-ai-trace-toggle" aria-expanded={showTrace} aria-label="분석 단계 추적 보기(개발용)"
                    style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
                    {showTrace ? '▾' : '▸'} 분석 단계 추적 (개발환경 전용)
                  </button>
                  {showTrace && (
                    <pre data-testid="inq-ai-trace" style={{ margin: '6px 0 0', maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 11, lineHeight: 1.45, padding: '8px 10px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6 }}>
                      {JSON.stringify({ verification: result.verification, ...(result.trace as object) }, null, 2)}
                    </pre>
                  )}
                </div>
              )}
              {(result.extractedText?.length ?? 0) > 0 && (
                <div style={{ marginTop: 8 }}>
                  <button type="button" onClick={() => setShowSource(v => !v)} data-testid="inq-ai-source-toggle" aria-expanded={showSource} aria-label="파일에서 추출한 원문 보기"
                    style={{ fontSize: 12, fontWeight: 700, color: '#7c3aed', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
                    {showSource ? '▾' : '▸'} 파일·이미지에서 추출한 원문 보기
                  </button>
                  {showSource && result.extractedText!.map((x, i) => (
                    <div key={i} data-testid={`inq-ai-source-${i}`} style={{ marginTop: 6 }}>
                      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>{x.name}</div>
                      <pre style={{ margin: 0, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5, padding: '8px 10px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, fontFamily: 'inherit' }}>
                        {x.text.trim() || '(텍스트를 읽지 못했습니다)'}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default InquiryAiAnalyzePanel;

// 장비 분석 — AI가 읽은 원문 값과 화면에 적용한 값을 나란히(해석값·기본값은 표시). 적용값은 아래 장비 목록에서 수정한다.
function EquipmentAnalysis({ rows }: { rows: AiInquiryEquipment[] }) {
  const th: React.CSSProperties = { padding: '4px 6px', textAlign: 'left', fontWeight: 700, color: '#6b7280', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '4px 6px', borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' };
  const tag = (t: string, color = '#b45309') => <span style={{ marginLeft: 4, fontSize: 10, fontWeight: 700, color, border: `1px solid ${color}55`, borderRadius: 4, padding: '0 4px' }}>{t}</span>;
  const kindBasis = { exact: '', synonym: '동의어', none: '목록 외' } as const;
  return (
    <div data-testid="inq-ai-equipment" style={{ marginTop: 10, fontSize: 12 }}>
      <div style={{ fontWeight: 700, color: '#374151', marginBottom: 4 }}>장비 분석 <span style={{ fontWeight: 400, color: '#9ca3af' }}>— 원문 → 적용값 (해석·기본값은 확인 필요)</span></div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th style={th}>원문 장비명</th><th style={th}>원문 수량/일수</th><th style={th}>적용 장비 종류</th><th style={th}>적용 수량 · 대여일수</th><th style={th}>사용 장소</th></tr></thead>
        <tbody>
          {rows.map((r, i) => {
            const inf = new Set(r.inferred ?? []);
            return (
              <tr key={i} data-testid={`inq-ai-eq-${i}`}>
                <td style={td}>{r.sourceName || r.kind}</td>
                <td style={{ ...td, color: '#6b7280', whiteSpace: 'nowrap' }}>{[r.sourceHrDay && `Hr/Day ${r.sourceHrDay}`, r.sourceQuantity && `Quantity ${r.sourceQuantity}`].filter(Boolean).join(' · ') || '—'}</td>
                <td style={td}>{r.kind || '—'}{r.kindBasis && kindBasis[r.kindBasis] ? tag(kindBasis[r.kindBasis], '#6b7280') : null}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  {r.quantity || '—'}{r.unit ? ` ${r.unit}` : ''}{inf.has('quantity') ? tag('해석') : null}{r.unitBasis === 'default' ? tag('단위 기본값', '#6b7280') : null}
                  {r.days ? <> × {r.days}일{inf.has('days') ? tag('해석') : null}</> : null}
                </td>
                <td style={td}>{r.location || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
