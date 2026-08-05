/**
 * PageHeader — VERITAS 관리자 상세 페이지 공통 헤더
 *
 * 기능(Action)과 페이지 제목(Title)의 역할을 명확히 분리한다.
 *   좌측:  ← 뒤로가기 (Outline 기능 버튼, 보조 비중)
 *   제목:  현재 화면 Title (Bold, 버튼보다 큰 글자, 좌측 정렬, 버튼처럼 보이지 않는 일반 텍스트)
 *   우측:  현재 화면 기능 버튼 (저장 / 견적서 / AI 견적 생성 등)
 *
 * 뒤로가기와 제목은 구분선(|)이 아니라 레이아웃·간격으로 구분한다.
 * 향후 거래처/고객/판매/통번역사/결제/정산 등 모든 상세 페이지에 공통 적용한다.
 */
import React from 'react';
import { C, TYPO, SP } from '../../lib/ds';
import { BackToListButton } from './BackToListButton';

export function PageHeader({
  onBack, title, subtitle, right,
  backLabel = '목록으로', testId = 'btn-page-back', style,
}: {
  onBack:    () => void;
  title:     string;
  subtitle?: React.ReactNode;   // 제목 옆 보조 라벨 (예: 'Version Engine')
  right?:    React.ReactNode;   // 우측 기능 버튼 그룹
  backLabel?: string;
  testId?:    string;
  style?:     React.CSSProperties;  // 컨테이너 오버라이드 (배경·sticky·shadow·padding 등)
}) {
  return (
    <div style={{ height: 52, display: 'flex', alignItems: 'center', flexShrink: 0, ...style }}>
      {/* 목록으로 — 상세화면 공통 네비게이션 버튼(보조 비중, Hover 시 브랜드 강조) */}
      <BackToListButton onClick={onBack} label={backLabel} testId={testId} />

      {/* 페이지 제목 — Bold, 버튼보다 큰 글자(존재감 강조). 뒤로가기와 충분한 간격(구분선 없음) */}
      <h1 style={{ margin: 0, marginLeft: 28, fontSize: 20, fontWeight: 800, color: C.textPrimary, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>
        {title}
        {subtitle && <span style={{ ...TYPO.helper, marginLeft: SP[3], fontWeight: 400 }}>{subtitle}</span>}
      </h1>

      {/* 우측 기능 버튼 그룹 */}
      {right && <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>{right}</div>}
    </div>
  );
}
