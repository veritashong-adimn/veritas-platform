/**
 * 의뢰건 삭제(논리 삭제) 공통 흐름 — 목록 행·상세 화면이 함께 쓴다.
 *  ① 서버에서 삭제 가능 여부 확인(제한이면 사유 안내) ② 확인창(사유 선택 입력) ③ 삭제 요청
 *  실제 삭제가 성공한 경우에만 true(성공 메시지는 호출측이 서버 응답 그대로 표시).
 */
import { api } from '../../lib/constants';
import { promptDialog, alertDialog } from '../ui';

export async function confirmAndDeleteInquiry(token: string, inquiryId: number): Promise<{ deleted: boolean; message?: string }> {
  const authH = { Authorization: `Bearer ${token}` };
  const chk = await fetch(api(`/api/admin/inquiries/${inquiryId}/delete-check`), { headers: authH });
  const c = await chk.json().catch(() => ({}));
  if (!chk.ok) {
    await alertDialog({ title: '의뢰건을 삭제할 수 없습니다', message: c.error ?? '삭제 가능 여부를 확인하지 못했습니다.', variant: 'warning' });
    return { deleted: false };
  }
  if (!c.ok) {
    await alertDialog({ title: '의뢰건을 삭제할 수 없습니다', message: (c.reasons ?? []).map((r: string) => `· ${r}`).join('\n'), variant: 'warning' });
    return { deleted: false };
  }
  const reason = await promptDialog({
    title: '의뢰건 삭제 확인',
    message: '이 의뢰건을 삭제하시겠습니까?\n\n삭제하면 일반 의뢰건 목록에서 제외됩니다.\n\n고객정보와 거래처 기록은 유지되며,\n삭제 이력은 보존됩니다.',
    label: '삭제 사유 (선택)', placeholder: '예: 테스트용으로 등록한 의뢰건', multiline: true,
    confirmLabel: '의뢰건 삭제', cancelLabel: '취소', variant: 'danger',
  });
  if (reason === null) return { deleted: false };
  const res = await fetch(api(`/api/admin/inquiries/${inquiryId}`), {
    method: 'DELETE', headers: { ...authH, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason.trim() }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    const lines = [d.error, ...((d.reasons ?? []) as string[]).slice(1)].filter(Boolean) as string[];
    await alertDialog({ title: '의뢰건을 삭제할 수 없습니다', message: lines.map(r => `· ${r}`).join('\n') || '삭제에 실패했습니다.', variant: 'warning' });
    return { deleted: false };
  }
  return { deleted: true, message: d.message ?? '의뢰건이 삭제 처리되었습니다.' };
}

/**
 * 선택 삭제 — 단건 삭제와 동일한 서버 흐름(delete-check → DELETE)을 선택 건마다 적용.
 * 삭제 불가 건은 제외 사유를 안내하고, 선택 건수 확인(사유 선택 입력) 후 가능 건만 삭제한다.
 */
export async function confirmAndDeleteInquiries(token: string, items: { id: number; label: string }[]): Promise<{ deletedCount: number; failed: string[] }> {
  const authH = { Authorization: `Bearer ${token}` };
  const blocked: string[] = [];
  const ok: { id: number; label: string }[] = [];
  for (const it of items) {
    const chk = await fetch(api(`/api/admin/inquiries/${it.id}/delete-check`), { headers: authH });
    const c = await chk.json().catch(() => ({}));
    if (chk.ok && c.ok) ok.push(it);
    else blocked.push(`· ${it.label}: ${(c.reasons ?? []).join(', ') || c.error || '삭제 불가'}`);
  }
  if (ok.length === 0) {
    await alertDialog({ title: '삭제할 수 있는 의뢰건이 없습니다', message: blocked.join('\n'), variant: 'warning' });
    return { deletedCount: 0, failed: [] };
  }
  const reason = await promptDialog({
    title: '의뢰건 선택 삭제 확인',
    message: `선택한 ${items.length}건 중 ${ok.length}건을 삭제하시겠습니까?`
      + (blocked.length ? `\n\n삭제 불가 ${blocked.length}건(제외):\n${blocked.join('\n')}` : '')
      + '\n\n삭제하면 일반 의뢰건 목록에서 제외됩니다.\n고객정보와 거래처 기록은 유지되며, 삭제 이력은 보존됩니다.',
    label: '삭제 사유 (선택)', placeholder: '예: 테스트용으로 등록한 의뢰건', multiline: true,
    confirmLabel: `${ok.length}건 삭제`, cancelLabel: '취소', variant: 'danger',
  });
  if (reason === null) return { deletedCount: 0, failed: [] };
  let deletedCount = 0;
  const failed: string[] = [];
  for (const it of ok) {
    const res = await fetch(api(`/api/admin/inquiries/${it.id}`), {
      method: 'DELETE', headers: { ...authH, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason.trim() }),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok) deletedCount++; else failed.push(`· ${it.label}: ${d.error ?? '삭제 실패'}`);
  }
  if (failed.length) await alertDialog({ title: `${failed.length}건 삭제 실패`, message: failed.join('\n'), variant: 'warning' });
  return { deletedCount, failed };
}
