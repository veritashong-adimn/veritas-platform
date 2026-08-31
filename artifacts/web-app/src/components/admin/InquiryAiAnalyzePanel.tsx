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
  channel?: string; serviceType?: string;
  customerCompanyName?: string; department?: string; contactName?: string; contactPosition?: string;
  contactPhone?: string; contactMobile?: string; contactEmail?: string;
  languageFrom?: string; languageTo?: string;
  subject?: string; requirements?: string; quoteDueDate?: string;
  interpretType?: string; scheduleFrom?: string; scheduleTo?: string; interpretDuration?: string; place?: string;
  documentType?: string; documentUsage?: string; volume?: string; desiredCompletionDate?: string;
}
export interface AiInquiryEquipment { kind: string; quantity: string; unit: string; location: string; note: string; }

interface AnalyzeResponse {
  fields: AiInquiryFields;
  equipment: AiInquiryEquipment[];
  confidence: 'high' | 'medium' | 'low' | string;
  warnings: string[];
  meta?: { fileCount: number; perFile?: Array<{ name: string; chars: number; method: string; warning?: string }> };
}

const sectionTitle: React.CSSProperties = { fontSize: 13, fontWeight: 800, color: '#111827', margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: 8 };
const CONF_META: Record<string, { label: string; color: string; bg: string; border: string }> = {
  high:   { label: '높음', color: '#065f46', bg: '#ecfdf5', border: '#a7f3d0' },
  medium: { label: '보통', color: '#92400e', bg: '#fffbeb', border: '#fde68a' },
  low:    { label: '낮음', color: '#991b1b', bg: '#fef2f2', border: '#fecaca' },
};

export function InquiryAiAnalyzePanel({ token, onApply, onToast, onDirtyChange }: {
  token: string;
  onApply: (fields: AiInquiryFields, equipment: AiInquiryEquipment[]) => void;
  onToast: (m: string) => void;
  onDirtyChange?: (dirty: boolean) => void;   // 미분석 입력(텍스트/파일/결과) 존재 여부 보고 — 상위 초기화 확인창용
}) {
  const [open, setOpen] = useState(true);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [drag, setDrag] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
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
      onApply(data.fields ?? {}, data.equipment ?? []);
      onToast(filled === 0 && eqCount === 0
        ? 'AI가 자동입력할 항목을 찾지 못했습니다. 경고를 확인하세요.'
        : `AI 분석 완료 — ${filled}개 항목을 자동입력했습니다. 검토 후 등록하세요.`);
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

          {/* 분석 버튼 */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
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
                <span style={{ marginLeft: 'auto', fontWeight: 400, color: '#9ca3af' }}>자동입력됨 · 아래 폼에서 검토/수정하세요</span>
              </div>
              {result.warnings.length > 0 && (
                <ul data-testid="inq-ai-warnings" style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: '#92400e' }}>
                  {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default InquiryAiAnalyzePanel;
