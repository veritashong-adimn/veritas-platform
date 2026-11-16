// ─── 선입금 계정 원장(팝업) — 거래처 상세 등에서 여는 화면 ─────────────────────────────────────
//  선입금관리와 같은 원장 하나의 표(거래일 | 구분 | 입금액 | 차감액 | 잔액 | 관리)를 그대로 보여 준다.
//  잔액 = 누적 입금 − 누적 차감. 예정/확정 구분·확정 반영 절차 없음. (props 는 기존 호출부와 호환)
import React, { useEffect, useState } from "react";
import { DraggableModal } from "./DraggableModal";
import { PrepaidCompanyLedger } from "./PrepaidCompanyLedger";
import { getJson } from "./prepaidLedgerShared";

interface Props {
  accountId: number;
  authHeaders: Record<string, string>;
  onClose: () => void;
  onUpdate: () => void;
  /** 입금·차감 등록·수정(prepaid.manage) — 미전달 시 기존 동작(표시). */
  canManage?: boolean;
  /** 원장 항목 삭제(관리자 전용, 서버에서도 검사) — 미전달 시 기존 동작(표시). */
  canDelete?: boolean;
  /** 하위호환용(사용하지 않음) */
  isAdmin?: boolean;
}

export function PrepaidLedgerModal({ accountId, authHeaders, onClose, onUpdate, canManage = true, canDelete = true }: Props) {
  const [account, setAccount] = useState<{ companyId: number; companyName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getJson<{ companyId: number; companyName: string }>(`/api/admin/prepaid-accounts/${accountId}`, authHeaders)
      .then(a => setAccount({ companyId: a.companyId, companyName: a.companyName }))
      .catch(e => setError(e?.message ?? "조회 실패"));
  }, [accountId, authHeaders]);

  return (
    <DraggableModal title="선입금 원장" subtitle={account?.companyName} onClose={onClose} width={800} zIndex={1200} resizable>
      {error && <div role="alert" style={{ color: "#b91c1c", fontSize: 13 }}>{error}</div>}
      {!account && !error && <div style={{ padding: 24, textAlign: "center", color: "#94a3b8" }}>불러오는 중…</div>}
      {account && <PrepaidCompanyLedger companyId={account.companyId} authHeaders={authHeaders} canManage={canManage} canDelete={canDelete} onChanged={onUpdate} />}
    </DraggableModal>
  );
}
