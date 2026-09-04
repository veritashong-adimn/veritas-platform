// ─────────────────────────────────────────────────────────────────────────────
// 통번역사 상세 미리보기 팝오버 — 검색결과 클릭 시 즉시 선택하지 않고 식별정보를 먼저 확인.
//  · 표시 데이터는 검색결과(/admin/translators)에 이미 포함된 필드만 사용(추가 조회 없음).
//  · 최근 수행이력만 지연조회(GET /admin/performances/recent-by-translator) — 최대 3건.
//  · 개인정보 보호: 전화번호는 끝 4자리만, 주민번호·계좌·상세주소는 표시하지 않는다(§5).
//  · 하단 [이 통번역사 선택] → 기존 선택 흐름(onSelect) 그대로 호출.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { C, TYPO } from '../../lib/ds';

export interface RecentPerformance { title: string; month: string | null; status?: string | null }

interface Props {
  t: any;                                   // 검색결과 통번역사 객체(이미 로드된 필드 사용)
  anchor: { left: number; top: number; width: number };
  fetchRecent: (translatorId: number) => Promise<RecentPerformance[]>;
  onSelect: () => void;
  onClose: () => void;
}

// 연락처 끝 4자리만(개인정보 보호 §5) — 숫자만 추출 후 마지막 4자리. 없으면 null.
export function phoneLast4(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}
// 등급 라벨 — S/A/B/C → "S등급". 그 외 값은 그대로.
export const gradeLabel = (g?: string | null) => (g ? (/^[SABC]$/i.test(g) ? `${g.toUpperCase()}등급` : g) : null);
// 구분(업무유형) — 프로필 업무유형(통역/번역 등) 콤마구분 → 그대로 표시.
export const workTypeLabel = (v?: string | null) => (v ? String(v).split(',').map(s => s.trim()).filter(Boolean).join('·') : null);

const RECENT_CACHE = new Map<number, RecentPerformance[]>();

export default function TranslatorPreviewPopover({ t, anchor, fetchRecent, onSelect, onClose }: Props) {
  const [recent, setRecent] = useState<RecentPerformance[] | null>(RECENT_CACHE.get(t.id) ?? null);
  const [loadingRecent, setLoadingRecent] = useState(false);

  useEffect(() => {
    let alive = true;
    if (RECENT_CACHE.has(t.id)) { setRecent(RECENT_CACHE.get(t.id)!); return; }
    setLoadingRecent(true);
    fetchRecent(t.id)
      .then(rows => { if (alive) { RECENT_CACHE.set(t.id, rows); setRecent(rows); } })
      .catch(() => { if (alive) setRecent([]); })
      .finally(() => { if (alive) setLoadingRecent(false); });
    return () => { alive = false; };
  }, [t.id, fetchRecent]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 위치 — 검색 드롭다운 오른쪽에 배치, 화면 넘치면 왼쪽/상단으로 클램프.
  const W = 340;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = anchor.left + anchor.width + 8;
  if (left + W > vw - 8) left = Math.max(8, anchor.left - W - 8);
  const top = Math.min(anchor.top, Math.max(8, vh - 420));

  const last4 = phoneLast4(t.phone);
  const grade = gradeLabel(t.grade);
  const work = workTypeLabel(t.profileWorkTypes);
  const school = [t.education, t.major].filter(Boolean).join(' · ');
  const gubun = [grade, work].filter(Boolean).join(' / ');

  const Line = ({ label, value }: { label: string; value?: React.ReactNode }) => {
    if (value == null || value === '') return null;
    return (
      <div style={{ display: 'flex', gap: 8, padding: '3px 0', alignItems: 'baseline' }}>
        <span style={{ ...TYPO.helper, color: C.textMuted, flexShrink: 0, width: 66 }}>{label}</span>
        <span style={{ fontSize: 12, color: C.textPrimary, minWidth: 0, wordBreak: 'break-word' }}>{value}</span>
      </div>
    );
  };

  return createPortal(
    <>
      {/* 배경 클릭 시 닫기(선택 아님) */}
      <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9650, background: 'transparent' }} />
      <div role="dialog" aria-label="통번역사 상세 미리보기" data-testid="translator-preview"
        onMouseDown={e => e.stopPropagation()}
        style={{ position: 'fixed', left, top, width: W, zIndex: 9660, background: C.bgCard, border: `1px solid ${C.g200}`, borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,0.18)', maxHeight: 440, display: 'flex', flexDirection: 'column' }}>
        {/* 헤더 */}
        <div style={{ padding: '12px 14px 10px', borderBottom: `1px solid ${C.g100}`, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: C.textPrimary }}>{t.name || t.email}</span>
          {grade && <span style={{ ...TYPO.badge, background: C.primaryBg, color: C.primaryText, borderRadius: 999, padding: '1px 8px', fontSize: 11, fontWeight: 700 }}>{grade}</span>}
          {t.languagePairs && <span style={{ fontSize: 12, color: C.textSecondary }}>{t.languagePairs}</span>}
        </div>
        {/* 본문 — 스크롤 */}
        <div style={{ padding: '8px 14px', overflowY: 'auto', flex: 1 }}>
          <Line label="언어" value={t.languagePairs} />
          <Line label="등급/구분" value={gubun || undefined} />
          <Line label="출신학교" value={school || undefined} />
          <Line label="전문분야" value={t.specializations} />
          <Line label="주요경력" value={t.bio} />
          <Line label="활동지역" value={t.region} />
          <Line label="세금처리" value={t.settlementType} />
          <Line label="연락처" value={last4 ? `···· ${last4}` : undefined} />
          {t.affiliatedCompanyName && <Line label="소속업체" value={t.affiliatedCompanyName} />}

          {/* 최근 수행이력 2~3건 */}
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px dashed ${C.g200}` }}>
            <div style={{ ...TYPO.helper, color: C.textMuted, marginBottom: 4 }}>최근 수행이력</div>
            {loadingRecent && recent == null
              ? <div style={{ fontSize: 12, color: C.textMuted }}>불러오는 중…</div>
              : (recent && recent.length > 0
                  ? <ul style={{ margin: 0, paddingLeft: 16 }}>
                      {recent.map((h, idx) => (
                        <li key={idx} style={{ fontSize: 12, color: C.textPrimary, padding: '2px 0' }}>
                          {h.title}{h.month ? <span style={{ color: C.textMuted }}> / {h.month}</span> : null}
                        </li>
                      ))}
                    </ul>
                  : <div style={{ fontSize: 12, color: C.textMuted }}>수행이력 없음</div>)}
          </div>
        </div>
        {/* 하단 액션 */}
        <div style={{ padding: '10px 14px', borderTop: `1px solid ${C.g100}`, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} data-testid="translator-preview-close"
            style={{ fontSize: 12, padding: '7px 12px', border: `1px solid ${C.g300}`, borderRadius: 6, background: C.bgCard, color: C.textSecondary, cursor: 'pointer' }}>닫기</button>
          <button type="button" onClick={onSelect} data-testid="translator-preview-select"
            style={{ fontSize: 12, fontWeight: 700, padding: '7px 14px', border: 'none', borderRadius: 6, background: C.primary, color: '#fff', cursor: 'pointer' }}>이 통번역사 선택</button>
        </div>
      </div>
    </>,
    document.body,
  );
}
