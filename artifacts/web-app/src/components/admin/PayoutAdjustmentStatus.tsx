// 판매 상세 > 수행정보 — 이 판매건의 수정·정정 요청·승인·차액 정산 현황(2026-11). 요청이 없으면 표시하지 않는다.
import React from 'react';
import { PayoutAdjustmentList } from './PayoutAdjustmentsPanel';

export default function PayoutAdjustmentStatus(props: { projectId: number; token: string; refreshKey?: string | number; onToast: (m: string) => void; onChanged?: () => void }) {
  return <PayoutAdjustmentList mode="project" {...props} />;
}
