// ─────────────────────────────────────────────────────────────────────────────
// IBK 기업은행 대량이체 Excel 생성 — 국내 지급 자동화 Phase 3.
//  · IBK 기업인터넷뱅킹 「대량이체(계좌)」 업로드 양식에 맞춘 .xlsx 를 서버 메모리에서 생성한다.
//  · 컬럼 순서(1행=헤더, 2행부터=데이터):
//      A 입금은행 | B 입금계좌번호 | C 이체금액 | D 내통장인쇄내용 | E 받는분통장인쇄내용 | F CMS코드
//  · 계좌번호는 반드시 "문자(text)" 셀로 기록 — 지수표기/앞자리 0 손실 방지.
//  · 이체금액은 "숫자(number)" 셀 — "원"·쉼표 등 문자 금지.
//  · 받는분통장인쇄내용은 항상 "(주)베리타스" 고정. CMS코드는 공란.
//  · [보안] 원본 계좌번호는 이 파일 생성 순간에만 서버 메모리에서 다뤄지며,
//    응답 JSON·프론트·로그·디스크 어디에도 남기지 않는다(호출측 §11 보장).
//  · [주의] IBK 공식 샘플(sample_LargeQuantityTransferToAccount.xlsx)이 현재 저장소에 없어
//    아래 헤더/순서는 확인된 6개 컬럼 스펙 기준으로 구현. 샘플 확보 시 sheet명/셀형식을 재대조할 것.
// ─────────────────────────────────────────────────────────────────────────────
import * as XLSX from "xlsx";
import { truncateForBankPrint } from "./ibkPrintName";

// IBK 대량이체 헤더(고정 순서·명칭). 샘플 확보 시 이 상수만 조정하면 됨.
export const IBK_HEADERS = [
  "입금은행",
  "입금계좌번호",
  "이체금액",
  "내통장인쇄내용",
  "받는분통장인쇄내용",
  "CMS코드",
] as const;

// 받는분통장인쇄내용 고정 문자열(§2).
export const IBK_RECEIVER_PRINT = "(주)베리타스";

// IBK 업로드 시 첫 워크시트를 읽으므로 단일 시트로 생성. (샘플 확인 시 시트명 재대조)
const SHEET_NAME = "대량이체";

const COL_WIDTHS = [12, 22, 14, 18, 20, 12];

export type IbkTransferRow = {
  bankName: string;        // 입금은행 — payout_transfers.bankNameSnapshot
  accountNumber: string;   // 입금계좌번호 — 복호화된 원본(문자 셀로 기록)
  amount: number;          // 이체금액 — payout_transfers.amount snapshot(재계산 금지)
  payeePrintName: string;  // 내통장인쇄내용 — 지급대상자명
};

/**
 * 입금계좌번호 정규화 — IBK 업로드용으로 하이픈·공백 등 구분자를 제거해 숫자 문자열만 남긴다.
 *  · DB 원본은 하이픈 포함/미포함이 혼재하므로 파일 생성 시점에만 통일한다(원본 불변).
 *  · Text 셀로 기록하므로 앞자리 0 도 보존된다(지수표기·자동 숫자변환 방지).
 */
export function normalizeIbkAccountNumber(raw: string | null | undefined): string {
  return String(raw ?? "").replace(/\D/g, ""); // 숫자 외(하이픈·공백·기타) 전부 제거
}

/**
 * IBK 대량이체 워크북(.xlsx) 버퍼를 생성한다.
 *  · 계좌번호는 문자 셀('s'), 이체금액은 숫자 셀('n')로 강제한다.
 *  · 계좌번호는 하이픈·공백을 제거한 숫자 문자열로 통일한다(normalizeIbkAccountNumber).
 *  · 내통장인쇄내용은 통장 표시용으로 최대 10자 제한(truncateForBankPrint) — DB 원본은 불변.
 *  · CMS코드는 공란(빈 문자열).
 */
export function buildIbkTransferWorkbook(rows: IbkTransferRow[]): Buffer {
  const aoa: (string | number)[][] = [
    [...IBK_HEADERS],
    ...rows.map((r) => [
      r.bankName ?? "",
      normalizeIbkAccountNumber(r.accountNumber), // "-"/공백 제거 후 문자열 → text 셀(앞자리 0·지수표기 방지)
      Math.round(Number(r.amount) || 0), // 정수 KRW 숫자 셀 — "원"/쉼표 없음
      truncateForBankPrint(r.payeePrintName), // 내통장인쇄내용 — 최대 10자(한글 문자단위·괄호 영문 제거)
      IBK_RECEIVER_PRINT,
      "",                               // CMS코드 공란
    ]),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = COL_WIDTHS.map((wch) => ({ wch }));

  // 입금계좌번호(B열) 데이터 셀을 명시적으로 text 형식으로 고정 — 은행 업로드 호환성 최우선.
  for (let i = 0; i < rows.length; i++) {
    const addr = XLSX.utils.encode_cell({ c: 1, r: i + 1 }); // B{2..}
    const cell = ws[addr];
    if (cell) { cell.t = "s"; cell.z = "@"; }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// 사용자 노출 파일명(§6): IBK_대량이체_YYYY-MM-DD_지급회차.xlsx
export function ibkFileName(paymentDate: string | null | undefined): string {
  const d = paymentDate ? String(paymentDate).slice(0, 10) : "미지정";
  return `IBK_대량이체_${d}_지급회차.xlsx`;
}
