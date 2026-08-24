/**
 * unsavedGuard — 미저장 편집 상태 전역 레지스트리
 *
 * 좌측 상단 로고 클릭 새로고침 시에만 "저장하지 않은 변경사항" 확인창을 띄우기 위한 용도.
 * native beforeunload 를 쓰지 않으므로 F5·탭 닫기·라우팅 등 기존 동작에는 영향을 주지 않는다.
 * 편집 컴포넌트가 dirty 여부를 반환하는 checker 를 등록하고, 언마운트 시 해제한다.
 */
type UnsavedChecker = () => boolean;

const checkers = new Set<UnsavedChecker>();

/** dirty 여부 checker 등록. 반환된 해제 함수를 useEffect cleanup 으로 그대로 반환하면 된다. */
export function registerUnsavedChecker(fn: UnsavedChecker): () => void {
  checkers.add(fn);
  return () => { checkers.delete(fn); };
}

/** 등록된 checker 중 하나라도 저장하지 않은 변경사항이 있으면 true. */
export function hasUnsavedChanges(): boolean {
  for (const fn of checkers) {
    try { if (fn()) return true; } catch { /* checker 오류는 안전하게 무시 */ }
  }
  return false;
}
