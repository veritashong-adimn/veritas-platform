// ─── 목록 화면 검색 영역·표 공통 규격(견적목록·판매목록) ─────────────────────────────
//  · 검색 입력칸·선택칸·날짜칸·버튼 높이 34px · 입력/목록 글자 13px · 영역 소제목 14px 굵게
//  · 같은 기능 그룹 안 간격 6px · 기능 그룹 사이 22px(세로 중앙 정렬) · 좁은 화면은 그룹 단위 줄바꿈
//  · 검색 버튼 = 디자인 시스템 기본 파란색(C.primary) · 초기화 버튼 = 회색
//  · 표시 규격만 정의한다(조회·필터 동작 없음).
import type { CSSProperties } from 'react';
import { C } from './ds';

export const LIST_CTRL_H = 34;
export const LIST_FS = 13;

/** 검색 영역 한 줄 — 기능 그룹을 가로로 배치하고, 너비가 부족하면 그룹 단위로 줄바꿈 */
export const listSearchBar: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 22, rowGap: 8 };
/** 기능 그룹(그룹 안 요소는 줄바꿈하지 않음) */
export const listGroup: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'nowrap' };

/** 영역 소제목(검색 및 필터 · 발행일 · 견적 현황 · 견적 목록 등) */
export const listSubtitle: CSSProperties = { fontSize: 14, fontWeight: 700, color: '#374151' };
/** 그룹 앞 라벨(발행일 · 판매날짜 등 텍스트 라벨) */
export const listLabel: CSSProperties = { fontSize: LIST_FS, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' };

/** 텍스트 입력칸 */
export const listInput: CSSProperties = {
  height: LIST_CTRL_H, boxSizing: 'border-box', padding: '0 11px', fontSize: LIST_FS,
  border: '1px solid #d1d5db', borderRadius: 8, outline: 'none', background: '#fff', color: '#111827',
};
/** ClickSelect triggerStyle */
export const listSelectTrigger: CSSProperties = { height: LIST_CTRL_H, boxSizing: 'border-box', padding: '0 10px', fontSize: LIST_FS, borderRadius: 8, width: '100%' };
/** DateField style(래퍼 높이 34 · 글자 13) */
export const listDateField: CSSProperties = { ...listInput, width: 128, padding: '0 9px' };

const btnBase = (disabled?: boolean): CSSProperties => ({
  height: LIST_CTRL_H, boxSizing: 'border-box', padding: '0 14px', borderRadius: 8, fontSize: LIST_FS, fontWeight: 700,
  border: 'none', whiteSpace: 'nowrap', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
});
/** 검색 버튼(파란색) */
export const listBtnPrimary = (disabled?: boolean): CSSProperties => ({ ...btnBase(disabled), background: C.primary, color: '#fff' });
/** 초기화 버튼(회색) */
export const listBtnGray = (disabled?: boolean): CSSProperties => ({ ...btnBase(disabled), background: '#e5e7eb', color: '#374151' });
/** 보조 버튼(Excel 다운로드 등 — 흰 바탕 테두리) */
export const listBtnGhost = (disabled?: boolean): CSSProperties => ({ ...btnBase(disabled), background: '#fff', color: '#374151', border: '1px solid #d1d5db', fontWeight: 600 });

/** 목록 표 본문 셀(헤더는 readTableView.css 공통 규격 12px/600) */
export const LIST_TD_PAD = '9px 12px';
