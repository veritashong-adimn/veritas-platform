// ─────────────────────────────────────────────────────────────────────────────
// 통번역사 상세 미리보기 팝오버 — 검색결과 클릭 시 즉시 선택하지 않고 식별정보를 먼저 확인.
//  · 표시 데이터는 검색결과(/admin/translators)에 이미 포함된 필드만 사용(추가 조회 없음).
//  · 최근 수행이력만 지연조회(GET /admin/performances/recent-by-translator) — 최대 3건.
//  · 개인정보 보호: 전화번호는 끝 4자리만, 주민번호·계좌·상세주소는 표시하지 않는다(§5).
//  · 하단 [이 통번역사 선택] → 기존 선택 흐름(onSelect) 그대로 호출.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { C, TYPO } from '../../lib/ds';
import { toDisplayRegion } from '../../lib/regionDisplay';
import { formatPhoneDisplay } from '../../lib/utils';

// 연락처 표시용 하이픈(공통 formatPhoneDisplay 재사용) — 원본 값은 변경하지 않는다.
//   국내 번호 체계로 확정되는 자릿수(0으로 시작 9~11자리 · 1588 등 8자리)만 포맷하고,
//   국제번호(+…)·자릿수가 맞지 않는 값은 숫자를 자르거나 바꾸지 않도록 원문 그대로 표시.
export function phoneForDisplay(raw: string): string {
  const d = raw.replace(/\D/g, '');
  const domestic = (d.startsWith('0') && d.length >= 9 && d.length <= 11) || (d.length === 8 && d.startsWith('1'));
  return domestic && !raw.trim().startsWith('+') ? formatPhoneDisplay(raw) : raw.trim();
}

export interface RecentPerformance { title: string; month: string | null; status?: string | null }

interface Props {
  t: any;                                   // 검색결과 통번역사 객체(이미 로드된 필드 사용)
  // left/top/width: 검색 입력칸 기준(드롭다운용). inputTop/inputBottom: 입력칸 위·아래 경계(미리보기 위치 계산용)
  anchor: { left: number; top: number; width: number; inputTop?: number; inputBottom?: number };
  fetchRecent: (translatorId: number) => Promise<RecentPerformance[]>;
  // 전체 연락처·이메일(배정 권한자 전용 API). 없으면 기존처럼 끝 4자리만 표시.
  fetchContact?: (translatorId: number) => Promise<TranslatorContactResult>;
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

export type TranslatorContactResult =
  | { status: 'ok'; phone: string | null; email: string | null }
  | { status: 'forbidden' }
  | { status: 'error' };

export default function TranslatorPreviewPopover({ t, anchor, fetchRecent, fetchContact, onSelect, onClose }: Props) {
  // 연락처·이메일 — 미리보기를 열 때마다 조회(캐시 없음, 다른 통번역사 값으로 대체되지 않도록 대상 id 기준으로만 반영)
  const [contact, setContact] = useState<{ id: number; r: TranslatorContactResult } | null>(null);
  useEffect(() => {
    if (!fetchContact) return;
    let alive = true;
    setContact(null);
    fetchContact(t.id).then(r => { if (alive) setContact({ id: t.id, r }); }).catch(() => { if (alive) setContact({ id: t.id, r: { status: 'error' } }); });
    return () => { alive = false; };
  }, [t.id, fetchContact]);
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

  // 위치 — 검색 입력칸 바로 아래(왼쪽 정렬, 간격 6px). 오른쪽 넘치면 왼쪽으로 당기고,
  //   아래 공간이 부족하고 위쪽이 더 넓으면 입력칸 위에 표시. 높이는 남은 공간으로 제한(본문 스크롤) → 화면 밖 잘림 없음.
  const W = 340, GAP = 6, M = 8, MAX_H = 440;
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxH, setBoxH] = useState(420);   // 실제 렌더 높이(측정 전 기본값)
  useLayoutEffect(() => {
    const h = boxRef.current?.offsetHeight ?? 0;
    if (h > 0 && h !== boxH) setBoxH(h);
  });
  const vw = window.innerWidth, vh = window.innerHeight;
  const inTop = anchor.inputTop ?? anchor.top, inBottom = anchor.inputBottom ?? anchor.top;
  let left = anchor.left;
  if (left + W > vw - M) left = Math.max(M, vw - W - M);
  const spaceBelow = vh - inBottom - GAP - M, spaceAbove = inTop - GAP - M;
  const wantH = Math.min(boxH, MAX_H);
  let top: number, maxH: number;
  if (wantH <= spaceBelow || spaceBelow >= spaceAbove) {
    maxH = Math.max(160, Math.min(MAX_H, spaceBelow));
    top = inBottom + GAP;
  } else {
    maxH = Math.min(MAX_H, spaceAbove);
    top = Math.max(M, inTop - GAP - Math.min(wantH, maxH));
  }

  const last4 = phoneLast4(t.phone);
  const c = contact && contact.id === t.id ? contact.r : null;
  // 표시값: 권한자 → 전체 번호/이메일(없으면 '미등록'), 권한 없음·조회 실패 → 기존 끝 4자리 마스킹 유지
  const phoneText = !fetchContact ? (last4 ? `···· ${last4}` : undefined)
    : !c ? '불러오는 중…'
    : c.status === 'ok' ? (c.phone ? phoneForDisplay(c.phone) : '미등록')
    : (last4 ? `···· ${last4}` : '미등록');
  const emailText = !fetchContact ? undefined
    : !c ? '불러오는 중…'
    : c.status === 'ok' ? (c.email || '미등록')
    : c.status === 'forbidden' ? '권한 없음' : '조회 실패';
  const grade = gradeLabel(t.grade);
  const work = workTypeLabel(t.profileWorkTypes);
  const school = [t.education, t.major].filter(Boolean).join(' · ');
  const gubun = [grade, work].filter(Boolean).join(' / ');

  const Line = ({ label, value }: { label: string; value?: React.ReactNode }) => {
    if (value == null || value === '') return null;
    return (
      <div style={{ display: 'flex', gap: 8, padding: '3px 0', alignItems: 'baseline' }}>
        <span style={{ ...TYPO.helper, color: C.textMuted, flexShrink: 0, width: 66 }}>{label}</span>
        <span style={{ fontSize: 12, color: C.textPrimary, minWidth: 0, wordBreak: 'break-word', overflowWrap: 'anywhere' }}>{value}</span>
      </div>
    );
  };

  return createPortal(
    <>
      {/* 배경 클릭 시 닫기(선택 아님) */}
      <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9650, background: 'transparent' }} />
      <div ref={boxRef} role="dialog" aria-label="통번역사 상세 미리보기" data-testid="translator-preview"
        onMouseDown={e => e.stopPropagation()}
        style={{ position: 'fixed', left, top, width: W, zIndex: 9660, background: C.bgCard, border: `1px solid ${C.g200}`, borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,0.18)', maxHeight: maxH, display: 'flex', flexDirection: 'column' }}>
        {/* 헤더 */}
        <div style={{ padding: '12px 14px 10px', borderBottom: `1px solid ${C.g100}`, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: C.textPrimary }}>{t.name || t.email}</span>
          {/* 비활성(과거 CRM 이관 등) — 수행정보 저장(배정 확정) 시 자동 활성화된다 */}
          {t.isActive === false && <span data-testid="translator-preview-inactive" title="수행정보에 배정해 저장하면 자동으로 활성화됩니다" style={{ ...TYPO.badge, background: C.g100, color: C.textSecondary, border: `1px solid ${C.g300}`, borderRadius: 999, padding: '1px 8px', fontSize: 11, fontWeight: 700 }}>비활성</span>}
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
          {/* region = 통번역사 거주지(거주국가/도시) — 활동 가능 지역 아님. 상세주소 제거 후 표시 */}
          <Line label="거주지역" value={toDisplayRegion(t.region) ?? undefined} />
          <Line label="연락처" value={phoneText} />
          <Line label="이메일" value={emailText} />
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
