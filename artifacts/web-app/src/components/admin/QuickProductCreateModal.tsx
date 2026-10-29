/**
 * 견적서 작성 중 상품 간편등록 — 기존 상품관리의 빠른 생성(LazyProductPanel)을 모달로 띄운다.
 *  · 같은 등록 API·코드 생성·중복 판정·권한(관리자)·감사로그를 그대로 사용(별도 상품/언어 마스터 없음).
 *  · 등록 또는 기존 상품 선택 시 onDone(product) — 견적 행 연결은 호출측이 한다. 닫기·취소 시 견적 작성 내용은 그대로.
 */
import React from 'react';
import { ModalOverlay } from '../ui';
import { LazyProductPanel, type QuickCreateInitial, type CreatedQuickProduct } from './LazyProductPanel';

export function QuickProductCreateModal({ token, initial, unitOptions, onToast, onClose, onDone }: {
  token: string;
  initial: QuickCreateInitial;
  unitOptions: string[];
  onToast: (msg: string) => void;
  onClose: () => void;
  onDone: (product: CreatedQuickProduct, how: 'created' | 'existing') => void;
}) {
  const authHeaders = { Authorization: `Bearer ${token}` };
  return (
    <ModalOverlay onClose={onClose} maxWidth={760}>
      <div data-testid="quick-product-modal" role="dialog" aria-label="신규 상품 등록">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ fontSize: 16, fontWeight: 800, color: '#111827' }}>신규 상품 등록</span>
          <button type="button" onClick={onClose} aria-label="닫기" data-testid="quick-product-close"
            style={{ background: 'none', border: 'none', fontSize: 20, color: '#9ca3af', cursor: 'pointer' }}>×</button>
        </div>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: '#6b7280' }}>
          상품관리와 같은 기준으로 등록됩니다(코드 자동 생성·중복 확인). 등록하면 현재 견적 행에 바로 선택되고, 작성 중인 견적 내용은 그대로 유지됩니다.
        </p>
        <LazyProductPanel token={token} authHeaders={authHeaders} setToast={onToast}
          quick={{ initial, unitOptions, onUseExisting: p => onDone(p, 'existing') }}
          onProductCreated={p => { if (p) onDone(p, 'created'); }} />
      </div>
    </ModalOverlay>
  );
}
