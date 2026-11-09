/**
 * CustomerGradeSection — 고객 상세(고객관리에서 연 거래처 상세) 안의 '고객 등급 · 실적' 접기 영역.
 *  · 자동 등급 / 관리자 지정 등급, 누적·최근 실적, 연도별 매출·건수, 등급 산정 근거.
 *  · 관리자: 등급 지정(사유 필수) / 지정 해제(자동 등급 복귀). 계산은 서버에서만.
 *  · 매출 = 부가세 제외 공급가액(신규 판매전환 건 + 과거 CRM 판매). 수금·미수금과 무관.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/constants';
import { formatWon } from '../../lib/utils';
import { confirmDialog } from '../ui';
import { GradeBadge, CUSTOMER_GRADES, type CustomerGrade } from './customerGrade';

interface PerfResponse {
  grade: CustomerGrade; autoGrade: CustomerGrade; autoReason: string;
  override: { grade: CustomerGrade; reason: string; setAt: string } | null;
  perf: { totalSupply: number; totalCount: number; supply12m: number; count24m: number; lastDate: string | null; newCount: number; legacyCount: number; estimatedCount: number; undatedCount: number };
  asOf: string;
  years: { year: string; sales: number; count: number; newCount: number; legacyCount: number; estimatedCount: number }[];
}

const box: React.CSSProperties = { border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 16, background: '#fff' };
const stat = (label: string, value: React.ReactNode, sub?: string) => (
  <div style={{ padding: '8px 12px', background: '#f9fafb', borderRadius: 8, minWidth: 0 }}>
    <div style={{ fontSize: 11, color: '#6b7280' }}>{label}</div>
    <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginTop: 2, whiteSpace: 'nowrap' }}>{value}</div>
    {sub && <div style={{ fontSize: 10.5, color: '#9ca3af', marginTop: 1 }}>{sub}</div>}
  </div>
);

export function CustomerGradeSection({ companyId, token, isAdmin, onToast, onChanged }: {
  companyId: number; token: string; isAdmin: boolean; onToast: (m: string) => void; onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<PerfResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<{ grade: CustomerGrade; reason: string }>({ grade: 'VIP', reason: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(api(`/api/admin/customer-management/${companyId}/performance`), { headers: { Authorization: `Bearer ${token}` } });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error ?? '조회 실패');
      setData(j); setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : '조회 실패'); }
  }, [companyId, token]);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!form.reason.trim()) { onToast('지정 사유를 입력해 주세요.'); return; }
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/customer-management/${companyId}/grade`), {
        method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? '등급 지정 실패');
      onToast(`등급을 '${form.grade}'(으)로 지정했습니다.`); setEditing(false); await load(); onChanged?.();
    } catch (e) { onToast(`오류: ${e instanceof Error ? e.message : '등급 지정 실패'}`); } finally { setBusy(false); }
  };
  const release = async () => {
    if (!(await confirmDialog({ title: '등급 지정 해제', message: `관리자 지정 등급을 해제하고 자동 등급(${data?.autoGrade})으로 되돌리시겠습니까?`, confirmLabel: '해제' }))) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/customer-management/${companyId}/grade`), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? '해제 실패');
      onToast('등급 지정을 해제했습니다. 자동 등급이 적용됩니다.'); await load(); onChanged?.();
    } catch (e) { onToast(`오류: ${e instanceof Error ? e.message : '해제 실패'}`); } finally { setBusy(false); }
  };

  const p = data?.perf;
  return (
    <div style={box} data-testid="customer-grade-section">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label="고객 등급·실적 펼치기/접기" data-testid="customer-grade-toggle"
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>고객 등급 · 실적</span>
        {data && <GradeBadge grade={data.grade} overridden={!!data.override} title={data.override ? `관리자 지정 · 자동 ${data.autoGrade}` : data.autoReason} />}
        {p && <span style={{ fontSize: 12, color: '#6b7280' }}>누적 {formatWon(p.totalSupply)} · {p.totalCount.toLocaleString()}건 · 최근 거래 {p.lastDate ?? '-'}</span>}
        {err && <span style={{ fontSize: 12, color: '#dc2626' }}>{err}</span>}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>{open ? '접기 ▲' : '펼치기 ▼'}</span>
      </button>

      {open && data && p && (
        <div style={{ padding: '0 14px 14px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#374151', marginBottom: 10 }}>
            <span>자동 등급 <GradeBadge grade={data.autoGrade} /></span>
            <span style={{ color: '#6b7280' }}>— {data.autoReason}</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#374151', marginBottom: 12 }}>
            <span>관리자 지정</span>
            {data.override
              ? <><GradeBadge grade={data.override.grade} overridden /><span style={{ color: '#6b7280' }}>사유: {data.override.reason} · {String(data.override.setAt).slice(0, 10)}</span></>
              : <span style={{ color: '#9ca3af' }}>없음(자동 등급 적용)</span>}
            {isAdmin && !editing && (
              <span style={{ display: 'inline-flex', gap: 6, marginLeft: 4 }}>
                <button type="button" onClick={() => { setForm({ grade: data.override?.grade ?? data.autoGrade, reason: '' }); setEditing(true); }}
                  data-testid="customer-grade-edit" aria-label="등급 지정" style={{ fontSize: 11.5, padding: '3px 10px', borderRadius: 6, border: '1px solid #bfdbfe', background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer', fontWeight: 600 }}>
                  {data.override ? '지정 변경' : '등급 지정'}
                </button>
                {data.override && (
                  <button type="button" onClick={release} disabled={busy} data-testid="customer-grade-release" aria-label="등급 지정 해제"
                    style={{ fontSize: 11.5, padding: '3px 10px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: '#374151', cursor: 'pointer', fontWeight: 600 }}>지정 해제</button>
                )}
              </span>
            )}
          </div>
          {editing && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: 10, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, marginBottom: 12 }}>
              <select value={form.grade} onChange={(e) => setForm((f) => ({ ...f, grade: e.target.value as CustomerGrade }))} aria-label="지정 등급" data-testid="customer-grade-select"
                style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12.5 }}>
                {CUSTOMER_GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
              <input value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} placeholder="지정 사유(필수) 예: 공공기관 장기 계약 전략 고객" maxLength={500}
                aria-label="지정 사유" data-testid="customer-grade-reason" style={{ flex: '1 1 260px', padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12.5 }} />
              <button type="button" onClick={save} disabled={busy} data-testid="customer-grade-save" aria-label="등급 지정 저장"
                style={{ fontSize: 12, padding: '6px 14px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', fontWeight: 700 }}>저장</button>
              <button type="button" onClick={() => setEditing(false)} data-testid="customer-grade-cancel" aria-label="등급 지정 취소"
                style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: '#374151', cursor: 'pointer' }}>취소</button>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, marginBottom: 12 }}>
            {stat('누적 매출(공급가액)', formatWon(p.totalSupply), `신규 ${p.newCount}건 · 과거 CRM ${p.legacyCount}건`)}
            {stat('누적 거래 건수', `${p.totalCount.toLocaleString()}건`, p.undatedCount ? `기준일 없음 ${p.undatedCount}건` : undefined)}
            {stat('최근 12개월 매출', formatWon(p.supply12m), `${data.asOf} 기준`)}
            {stat('최근 24개월 거래', `${p.count24m.toLocaleString()}건`, `최근 거래 ${p.lastDate ?? '-'}`)}
          </div>

          {data.years.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }} data-testid="customer-grade-years">
                <thead>
                  <tr style={{ background: '#f9fafb', color: '#6b7280' }}>
                    {['연도', '매출(공급가액)', '거래 건수', '신규 / 과거 CRM'].map((h, i) => (
                      <th key={h} style={{ padding: '6px 10px', textAlign: i === 0 ? 'left' : 'right', fontWeight: 600, borderBottom: '1px solid #e5e7eb' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.years.map((y) => (
                    <tr key={y.year}>
                      <td style={{ padding: '5px 10px', borderBottom: '1px solid #f1f5f9' }}>{y.year}</td>
                      <td style={{ padding: '5px 10px', textAlign: 'right', borderBottom: '1px solid #f1f5f9', fontWeight: 600 }}>{formatWon(y.sales)}</td>
                      <td style={{ padding: '5px 10px', textAlign: 'right', borderBottom: '1px solid #f1f5f9' }}>{y.count}건</td>
                      <td style={{ padding: '5px 10px', textAlign: 'right', borderBottom: '1px solid #f1f5f9', color: '#6b7280' }}>{y.newCount} / {y.legacyCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p style={{ margin: '10px 0 0', fontSize: 11, color: '#9ca3af', lineHeight: 1.6 }}>
            등급 기준: VIP 누적 1억 이상 또는 최근 12개월 3천만 이상 · 우수 누적 1천만 이상 또는 최근 24개월 20건 이상 · 휴면 최근 24개월 거래 없음 · 신규 거래 이력 없음.
            매출은 부가세 제외 공급가액(신규 판매전환 건 + 과거 CRM 판매, 같은 판매는 1회만)이며 수금·미수금과 별개입니다.
            {p.estimatedCount > 0 && ` 과거 CRM ${p.estimatedCount}건은 원본에 공급가액이 없어 총액 기준으로 추정했습니다.`}
          </p>
        </div>
      )}
    </div>
  );
}
