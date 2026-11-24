// ─── 지급금액 구분 — 지급준비점검(화면·엑셀)·지급명세서 공통 기준 ─────────────────────────────
//   개인 통번역사: 세전 / 원천세 / 세후
//   외주업체   : 공급가 / 부가세 / 지급합계
//   · 금액은 저장값만 분해한다(계산·추정으로 원천세·부가세를 만들지 않는다).
//     - 플랫폼 수행정보: 공식 지급회차와 같은 계산(원천세 = 세율 설정, 부가세 = 세금계산서 증빙일 때만 10%)이 이미 반영된 세전·세후를 분해.
//     - 과거 CRM: CRM 원본 세전·세후 그대로. 원천세·부가세 분리 정보가 없으므로 차액만 쓴다.
//   · CRM 원본 세금과 현재 수행정보 세금 설정이 다르면 taxConflict 로 '확인 필요' 사유만 준다(금액·지급상태 변경 없음).

export type PayeeType = "individual" | "vendor";

export interface PayAmount {
  payeeType: PayeeType;
  // 개인
  pretax: number; withholding: number; posttax: number;
  // 외주(개인이면 null)
  supply: number | null; vat: number | null; payTotal: number;
  taxConflict: string | null;
}

/** 현재 수행정보의 세금 설정(전환 건 비교용). 없으면 비교하지 않는다. */
export interface TaxSetting {
  category: string | null;          // 'individual' | 'vendor'
  treatment?: string | null;        // withholding_treatment
  rate?: number | string | null;    // withholding_rate(%) — nonresident/treaty
  evidence?: string | null;         // purchase_evidence_type
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const won = (n: number) => Math.round(n).toLocaleString("ko-KR");

/** 개인 원천세율(%) — 공식 지급회차(calcPayoutWithholding SQL 미러 CUR_DEDUCTION)와 같은 규칙. 미확정이면 null(비교 안 함). */
export function individualRate(treatment?: string | null, rate?: number | string | null): number | null {
  switch (treatment) {
    case "domestic_3_3": return 3.3;
    case "domestic_2_2": return 2.2;
    case "exempt": return 0;   // 원천징수 제외(확정 0%) — CRM 원천세 공제 기록과 다르면 확인 필요로 표시(공식 지급회차 calcPayoutWithholding 과 같은 0%)
    case "nonresident_custom":
    case "treaty_reduction_or_exemption": { const n = Number(rate); return Number.isFinite(n) ? n : null; }
    default: return null;   // tax_review_required·미설정 — 확정 세율 없음
  }
}

/**
 * @param source  'current' 플랫폼 수행정보 / 'legacy' 과거 CRM 원본(전환 포함)
 * @param withholding 저장 원천세(플랫폼). 없으면 세전−세후.
 * @param current 전환 CRM 건이면 현재(전환) 수행정보 세금 설정 — 충돌 판정만
 */
export function splitPayAmount(p: {
  payeeType: PayeeType; source: "current" | "legacy"; pretax: number; posttax: number; withholding?: number | null; current?: TaxSetting | null;
}): PayAmount {
  const pretax = r2(Number(p.pretax) || 0), posttax = r2(Number(p.posttax) || 0);
  const diff = r2(pretax - posttax);   // >0 공제(원천세), <0 가산(부가세)
  let conflict: string | null = null;

  if (p.payeeType === "individual") {
    const withholding = p.withholding != null && p.source === "current" ? r2(Number(p.withholding)) : Math.max(0, diff);
    if (p.source === "legacy" && p.current?.category === "individual") {
      const rate = individualRate(p.current.treatment, p.current.rate);
      if (rate != null && pretax > 0 && Math.abs(r2(pretax * rate / 100) - withholding) > 1)
        conflict = `CRM 원천세 ${won(withholding)}원 ↔ 현재 세금 설정(원천징수 ${rate}%) ${won(pretax * rate / 100)}원 불일치 — 금액·지급상태는 변경하지 않음`;
    }
    if (p.source === "legacy" && diff < 0) conflict = conflict ?? `CRM 세후(${won(posttax)})가 세전(${won(pretax)})보다 큼 — 세금 확인 필요`;
    return { payeeType: "individual", pretax, withholding, posttax, supply: null, vat: null, payTotal: posttax, taxConflict: conflict };
  }

  // 외주업체 — 원천징수 없음. 부가세 = 세후−세전(저장값 차액, 0 이상일 때만)
  let vat: number | null = diff <= 0 ? r2(-diff) : null;
  let withholding = 0;
  if (diff > 0) {
    // 외주업체인데 금액에서 공제가 있음(과거 CRM 원천세 기록) — 부가세 미확정, 공제액은 CRM 기록 그대로 표시
    withholding = diff;
    conflict = `외주업체인데 CRM 기록에 원천세 ${won(diff)}원 공제(세전 ${won(pretax)} → 세후 ${won(posttax)}) — 외주업체 세금(부가세) 확인 필요, 금액·지급상태는 변경하지 않음`;
  } else if (p.source === "legacy" && p.current?.category === "vendor") {
    const invoice = p.current.evidence === "tax_invoice";
    if (invoice && vat === 0 && pretax > 0) { vat = null; conflict = "현재 세금 설정은 세금계산서(부가세 10%)이나 CRM 금액에 부가세 없음 — 부가세 확인 필요(임의 생성 안 함)"; }
    else if (!invoice && (vat ?? 0) > 0) conflict = `CRM 금액에 부가세 ${won(vat ?? 0)}원 포함 ↔ 현재 증빙 설정은 세금계산서 아님 — 확인 필요`;
  }
  return { payeeType: "vendor", pretax, withholding, posttax, supply: pretax, vat, payTotal: posttax, taxConflict: conflict };
}
