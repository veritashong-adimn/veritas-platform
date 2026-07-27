// ─────────────────────────────────────────────────────────────────────────────
// quoteItemsShared — 상품/판매정보 Grid 공용 표시 상수 (단일 진실원천)
//
// 견적관리 편집기(QuoteEditorWorkspace)와 판매관리 읽기전용 뷰(QuoteItemsView)가
// 동일한 레이아웃·유형 배지·컬럼 힌트를 공유하기 위한 중립 모듈.
// 값은 QuoteEditorWorkspace에서 그대로 이관되었으며, 여기 한 곳만 수정하면 두 화면이
// 동시에 반영된다 (동일 UI를 두 번 개발하지 않는다).
//
// 런타임 의존: lib/ds 만 참조(leaf). ServiceType은 타입 전용 import(컴파일 시 제거).
// ─────────────────────────────────────────────────────────────────────────────
import React from 'react';
import { dsColH, dsRow, C } from '../../lib/ds';
import type { ServiceType } from './QuoteEditorWorkspace';

// ─── 서비스 유형 설정 (배지 라벨·색상) ────────────────────────────────────────
export const SVC_CFG: Record<ServiceType, { label: string; color: string; bg: string; border: string; dot: string }> = {
  translation:    { label: '번역',   color: C.primary, bg: C.primaryBg, border: '#93c5fd', dot: '#3b82f6' },
  interpretation: { label: '통역',   color: C.successText, bg: C.successBg, border: '#86efac', dot: '#10b981' },
  equipment:      { label: '장비',   color: C.warning, bg: C.warningBg, border: '#fcd34d', dot: '#f59e0b' },
  expense:        { label: '기타',   color: C.textMuted, bg: C.g50, border: C.g300, dot: C.g400 },
  // 할인 — 연한 빨강/분홍 계열
  discount:       { label: '할인',   color: C.danger, bg: C.dangerBg, border: '#fca5a5', dot: '#ef4444' },
};

// ─── 상품정보 Table Grid 정의 — DS TBL 토큰 기반 ─────────────────────────────
// Header와 모든 Body Row가 동일한 grid-template-columns를 공유 → 컬럼 폭 변경 시 1곳만 수정.
// 폭 배분 원칙(입력 우선순위): 서비스명·장소가 잘리지 않도록 우선 확보한다.
//   서비스명 200·AI배지 24·수량 64 — 단위 64 / 단가 112 / 공급가액 112 / 비고 minmax(130,220) 고정.
// ④ 동적필드 셀은 minmax(572px, 1fr): 통역 내부(기간174+운영132+시간86+인원56+장소100+gap16=564)가
//   절대 겹치지 않는 최소폭을 보장하고, 폭이 남으면 1fr로 확장(장소가 흡수).
// 행제어 유형 서비스명  동적          AI  수량 단위 단가  공급가액  비고
export const TABLE_COLS = '82px 60px 200px minmax(572px, 1fr) 24px 64px 64px 112px 112px minmax(130px, 220px)';
// 모든 컬럼 최소폭 합(+colGap 9×5 +padding 16). 브라우저 폭이 이 값 미만이면
// 상품정보 카드 내부에만 가로 스크롤이 생기고, 행은 항상 한 줄을 유지한다.
export const TABLE_MIN_W = 1484;
export const tblRow: React.CSSProperties = dsRow(TABLE_COLS, { minWidth: TABLE_MIN_W });

// ─── 컬럼 헤더 레이블 스타일 — DS dsColH 기반 ────────────────────────────────
export const COL_H: React.CSSProperties = dsColH('center');

// ─── ④ 동적필드 컬럼 헤더 힌트 (유형별) ──────────────────────────────────────
export const SVC_FIELD_HINTS: Record<ServiceType, string> = {
  translation:    '파일명 / 파일형식 / 단어수 / 글자수',
  interpretation: '시작일 ~ 종료일 / 시작시간 ~ 종료시간 / 장소 / 인원',
  equipment:      '시작일 ~ 종료일 / 사용 장소 / 사용일수',
  expense:        '서비스유형 (공증·속기·녹취·더빙·편집·감수·DTP 등)',
  discount:       '할인방식 / 할인값 / 할인사유',
};
