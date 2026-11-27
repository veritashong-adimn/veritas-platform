// Excel·CSV 출력·다운로드 권한(화면 공통 기준) — 관리자(최고관리자·일반 관리자)만 허용.
//   PM·일반 직원·재무 담당자·게스트·열람 계정: 버튼 미표시 + 브라우저 Excel 생성 차단(이 모듈의 writeWorkbookFile).
//   서버도 출력 API 마다 같은 기준으로 403 을 반환한다(api-server middlewares/auth requireAdminExport · lib/adminTier).
//   값 출처: 로그인·권한 조회 응답의 canExport(서버 판정). 응답 전에는 users.role === 'admin' 으로 표시.
//   신규 출력 기능: 버튼은 useCanExport() 로 감추고, 파일 저장은 writeWorkbookFile() 을 사용한다.
import { useSyncExternalStore } from "react";
import { alertDialog } from "../components/ui/confirmDialog";

let allowed = false;
const listeners = new Set<() => void>();

export function setExportAllowed(v: boolean): void {
  if (allowed === v) return;
  allowed = v;
  listeners.forEach(l => l());
}
export function canExport(): boolean { return allowed; }
export function useCanExport(): boolean {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => allowed, () => false);
}

export const EXPORT_FORBIDDEN_MESSAGE = "Excel·CSV 출력·다운로드는 관리자만 사용할 수 있습니다.";
export class ExportForbiddenError extends Error {
  constructor() { super(EXPORT_FORBIDDEN_MESSAGE); this.name = "ExportForbiddenError"; }
}
/** 출력 직전 확인 — 관리자가 아니면 안내 후 예외(호출한 출력 흐름 중단). */
export function assertCanExport(): void {
  if (allowed) return;
  void alertDialog({ title: "다운로드 제한", message: EXPORT_FORBIDDEN_MESSAGE });
  throw new ExportForbiddenError();
}

/** 브라우저에서 만든 Excel 파일 저장(공통) — xlsx / xlsx-js-style 의 writeFile 을 이 함수로만 호출한다. */
export function writeWorkbookFile(xlsx: { writeFile: (wb: any, filename: string, opts?: any) => any }, wb: unknown, filename: string, opts?: unknown): void {
  assertCanExport();
  xlsx.writeFile(wb, filename, opts as any);
}
