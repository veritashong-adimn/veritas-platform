import React, { useState, useEffect, useRef } from 'react';
import { api } from '../../lib/constants';
import { Card, ClickSelect } from '../ui';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>{title}</h2>
      </div>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};

const STABS = [
  { id: "company",    label: "🏢 공급자 정보" },
  { id: "bank",       label: "🏦 입금 계좌" },
  { id: "document",   label: "📄 문서 설정" },
  { id: "payment",    label: "💳 결제 설정" },
  { id: "settlement", label: "🧾 정산 설정" },
  { id: "insight",    label: "🤖 자동 게시" },
  { id: "docx-diag",  label: "🔍 DOCX 진단" },
] as const;

type SettingsTabId = typeof STABS[number]["id"];

interface Props {
  token: string;
  onToast: (msg: string) => void;
}

export function SettingsTab({ token, onToast }: Props) {
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>("company");
  const [settingsForm, setSettingsForm] = useState({
    companyName: "", businessNumber: "", ceoName: "", address: "", email: "", phone: "",
    bankName: "", accountNumber: "", accountHolder: "",
    quoteValidityDays: "14", taxRate: "10", quoteNotes: "", signatureImageUrl: "",
    defaultBillingType: "postpaid_per_project", paymentDueDays: "7", allowPartialPayment: false,
    settlementRatio: "70", settlementCycle: "monthly", applyWithholdingTax: true,
    autoPublishEnabled: false, autoPublishThreshold: "80", autoPublishDryRun: false,
  });

  const fetchSettings = async () => {
    const res = await fetch(api("/api/admin/settings"), { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const d = await res.json();
      setSettingsForm({
        companyName:     d.companyName     ?? "",
        businessNumber:  d.businessNumber  ?? "",
        ceoName:         d.ceoName         ?? "",
        address:         d.address         ?? "",
        email:           d.email           ?? "",
        phone:           d.phone           ?? "",
        bankName:        d.bankName        ?? "",
        accountNumber:   d.accountNumber   ?? "",
        accountHolder:   d.accountHolder   ?? "",
        quoteValidityDays: String(d.quoteValidityDays ?? "14"),
        taxRate:           String(d.taxRate            ?? "10"),
        quoteNotes:        d.quoteNotes         ?? "",
        signatureImageUrl: d.signatureImageUrl  ?? "",
        defaultBillingType:  d.defaultBillingType  ?? "postpaid_per_project",
        paymentDueDays:      String(d.paymentDueDays ?? "7"),
        allowPartialPayment: Boolean(d.allowPartialPayment ?? false),
        settlementRatio:     String(d.settlementRatio  ?? "70"),
        settlementCycle:     d.settlementCycle     ?? "monthly",
        applyWithholdingTax: Boolean(d.applyWithholdingTax ?? true),
        autoPublishEnabled:   Boolean(d.autoPublishEnabled   ?? false),
        autoPublishThreshold: String(d.autoPublishThreshold  ?? "80"),
        autoPublishDryRun:    Boolean(d.autoPublishDryRun    ?? false),
      });
    }
  };

  useEffect(() => { fetchSettings(); }, []);

  const sf = settingsForm;
  const set = (k: string) => (v: string | boolean) => setSettingsForm(f => ({ ...f, [k]: v }));
  const field = (label: string, key: string, placeholder = "", type = "text") => (
    <div key={key}>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 3 }}>{label}</div>
      <input type={type} value={(sf as any)[key]} onChange={e => set(key)(e.target.value)}
        placeholder={placeholder} style={{ ...inputStyle, fontSize: 13 }} />
    </div>
  );

  const saveBtn = (
    <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
      <button onClick={async () => {
        setSettingsSaving(true);
        try {
          const res = await fetch(api("/api/admin/settings"), {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(settingsForm),
          });
          if (res.ok) { onToast("설정이 저장되었습니다."); }
          else { const d = await res.json(); onToast(d.error ?? "저장 실패"); }
        } finally { setSettingsSaving(false); }
      }} disabled={settingsSaving}
        style={{ padding: "9px 24px", borderRadius: 8, border: "none", background: "#2563eb", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", opacity: settingsSaving ? 0.7 : 1 }}>
        {settingsSaving ? "저장 중…" : "💾 저장"}
      </button>
    </div>
  );

  return (
    <Section title="환경설정">
      {/* 설정 탭 바 */}
      <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "2px solid #e5e7eb", paddingBottom: 0 }}>
        {STABS.map(t => (
          <button key={t.id} onClick={() => setSettingsTab(t.id)}
            style={{ padding: "8px 16px", border: "none", background: "none", cursor: "pointer", fontSize: 13,
              fontWeight: settingsTab === t.id ? 700 : 500,
              color: settingsTab === t.id ? "#2563eb" : "#6b7280",
              borderBottom: settingsTab === t.id ? "2px solid #2563eb" : "2px solid transparent",
              marginBottom: -2, borderRadius: 0, whiteSpace: "nowrap" }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* 공급자 정보 */}
      {settingsTab === "company" && (
        <Card style={{ padding: "22px 24px", maxWidth: 560 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 16, paddingBottom: 10, borderBottom: "1px solid #f0f0f0" }}>🏢 공급자 정보</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {field("상호명", "companyName", "예) ㈜베리타스")}
            {field("사업자등록번호", "businessNumber", "예) 123-45-67890")}
            {field("대표자명", "ceoName", "예) 최향미")}
            {field("이메일", "email", "예) service@veritasco.co.kr")}
            {field("연락처", "phone", "예) 1600-1736")}
            <div>
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 3 }}>주소</div>
              <textarea value={sf.address} onChange={e => set("address")(e.target.value)}
                placeholder="예) 인천광역시 연수구 인천타워대로 323, B동 2406호"
                rows={2} style={{ ...inputStyle, fontSize: 13, resize: "vertical" }} />
            </div>
          </div>
          {saveBtn}
        </Card>
      )}

      {/* 입금 계좌 */}
      {settingsTab === "bank" && (
        <Card style={{ padding: "22px 24px", maxWidth: 480 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 16, paddingBottom: 10, borderBottom: "1px solid #f0f0f0" }}>🏦 입금 계좌</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {field("은행명", "bankName", "예) 국민은행")}
            {field("계좌번호", "accountNumber", "예) 420401-04-111464")}
            {field("예금주", "accountHolder", "예) ㈜베리타스")}
          </div>
          <div style={{ marginTop: 16, padding: "12px 14px", background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0" }}>
            <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.6 }}>
              💡 입금 계좌 정보는 견적서·거래명세서 PDF에 자동으로 표시됩니다.<br />
              비워두면 계좌 정보 섹션이 PDF에서 생략됩니다.
            </div>
          </div>
          {saveBtn}
        </Card>
      )}

      {/* 문서 설정 */}
      {settingsTab === "document" && (
        <Card style={{ padding: "22px 24px", maxWidth: 560 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 16, paddingBottom: 10, borderBottom: "1px solid #f0f0f0" }}>📄 문서 설정</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {field("견적 유효기간 기본값 (일)", "quoteValidityDays", "예) 14", "number")}
            {field("기본 세율 (%)", "taxRate", "예) 10", "number")}
            <div>
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 3 }}>견적서 안내문</div>
              <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 4 }}>모든 견적서 하단에 자동 출력됩니다.</div>
              <textarea value={sf.quoteNotes} onChange={e => set("quoteNotes")(e.target.value)}
                placeholder={"예) 본 견적서는 발행일로부터 14일간 유효합니다.\n문의: service@veritasco.co.kr"}
                rows={4} style={{ ...inputStyle, fontSize: 13, resize: "vertical" }} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 3 }}>서명 이미지 URL</div>
              <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 4 }}>Object Storage에 업로드된 서명 이미지 주소를 입력하세요.</div>
              <input value={sf.signatureImageUrl} onChange={e => set("signatureImageUrl")(e.target.value)}
                placeholder="예) https://storage.example.com/signature.png"
                style={{ ...inputStyle, fontSize: 13 }} />
              {sf.signatureImageUrl && (
                <div style={{ marginTop: 8, padding: 8, background: "#f8fafc", borderRadius: 6, border: "1px solid #e2e8f0", textAlign: "center" }}>
                  <img src={sf.signatureImageUrl} alt="서명 미리보기" style={{ maxHeight: 60, maxWidth: "100%", objectFit: "contain" }}
                    onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                </div>
              )}
            </div>
          </div>
          {saveBtn}
        </Card>
      )}

      {/* 결제 설정 */}
      {settingsTab === "payment" && (
        <Card style={{ padding: "22px 24px", maxWidth: 480 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 16, paddingBottom: 10, borderBottom: "1px solid #f0f0f0" }}>💳 결제 설정</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 3 }}>기본 결제 방식</div>
              <ClickSelect
                value={sf.defaultBillingType}
                onChange={v => set("defaultBillingType")(v)}
                triggerStyle={{ fontSize: 13, borderRadius: 8 }}
                options={[
                  { value: "postpaid_per_project", label: "건별 후불" },
                  { value: "prepaid_wallet", label: "선입금" },
                  { value: "monthly_billing", label: "누적 청구 (월정산)" },
                ]}
              />
            </div>
            {field("결제 기한 (일)", "paymentDueDays", "예) 7", "number")}
            <div>
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>부분입금 허용</div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
                <input type="checkbox" checked={sf.allowPartialPayment}
                  onChange={e => set("allowPartialPayment")(e.target.checked)}
                  style={{ width: 16, height: 16, cursor: "pointer" }} />
                <span>부분입금을 허용합니다 (미수금 처리 가능)</span>
              </label>
              <div style={{ marginTop: 6, fontSize: 11, color: "#9ca3af" }}>
                활성화 시 총액보다 적은 금액으로도 결제 처리가 가능합니다.
              </div>
            </div>
          </div>
          {saveBtn}
        </Card>
      )}

      {/* 정산 설정 */}
      {settingsTab === "settlement" && (
        <Card style={{ padding: "22px 24px", maxWidth: 480 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 16, paddingBottom: 10, borderBottom: "1px solid #f0f0f0" }}>🧾 정산 설정</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {field("정산 비율 (%)", "settlementRatio", "예) 70", "number")}
            <div>
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 3 }}>정산 주기</div>
              <ClickSelect
                value={sf.settlementCycle}
                onChange={v => set("settlementCycle")(v)}
                triggerStyle={{ fontSize: 13, borderRadius: 8 }}
                options={[
                  { value: "weekly", label: "주간 (매주)" },
                  { value: "biweekly", label: "격주" },
                  { value: "monthly", label: "월간 (매월)" },
                ]}
              />
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>3.3% 원천세 적용</div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
                <input type="checkbox" checked={sf.applyWithholdingTax}
                  onChange={e => set("applyWithholdingTax")(e.target.checked)}
                  style={{ width: 16, height: 16, cursor: "pointer" }} />
                <span>3.3% 원천세를 정산 금액에서 공제합니다</span>
              </label>
              <div style={{ marginTop: 6, padding: "10px 12px", background: "#fefce8", borderRadius: 6, border: "1px solid #fde68a" }}>
                <div style={{ fontSize: 11, color: "#92400e", lineHeight: 1.6 }}>
                  ⚠️ 원천세 적용 시 정산 금액 = 지급액 × 정산비율 × (1 − 3.3%)<br />
                  프리랜서(개인 사업자가 아닌 통번역사)에게 지급 시 원천징수 의무가 발생합니다.
                </div>
              </div>
            </div>
          </div>
          {saveBtn}
        </Card>
      )}

      {/* 자동 게시 설정 */}
      {settingsTab === "insight" && (
        <Card style={{ padding: "22px 24px", maxWidth: 560 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 4, paddingBottom: 10, borderBottom: "1px solid #f0f0f0" }}>
            🤖 인사이트 자동 게시 설정
          </div>
          <p style={{ margin: "0 0 20px", fontSize: 12, color: "#6b7280", lineHeight: 1.7 }}>
            조건을 충족한 인사이트를 운영자 개입 없이 자동으로 게시합니다.<br />
            처음에는 <strong>드라이런</strong> 모드로 테스트한 뒤, 실제 게시로 전환하세요.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ padding: "14px 16px", background: sf.autoPublishEnabled ? "#f0fdf4" : "#f9fafb", borderRadius: 10, border: `1.5px solid ${sf.autoPublishEnabled ? "#bbf7d0" : "#e5e7eb"}` }}>
              <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                <input type="checkbox" checked={sf.autoPublishEnabled}
                  onChange={e => set("autoPublishEnabled")(e.target.checked)}
                  style={{ width: 18, height: 18, cursor: "pointer", accentColor: "#059669" }} />
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: sf.autoPublishEnabled ? "#059669" : "#374151" }}>자동 게시 활성화</div>
                  <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>조건 충족 인사이트를 자동으로 published 상태로 전환</div>
                </div>
              </label>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6, fontWeight: 600 }}>AEO 점수 기준 (autoPublishThreshold)</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input type="number" min="0" max="100" value={sf.autoPublishThreshold}
                  onChange={e => set("autoPublishThreshold")(e.target.value)}
                  style={{ ...inputStyle, fontSize: 13, width: 90 }} />
                <span style={{ fontSize: 12, color: "#6b7280" }}>점 이상일 때 자동 게시 (기본값: 80)</span>
              </div>
              <div style={{ marginTop: 8, fontSize: 11, color: "#9ca3af", lineHeight: 1.6 }}>
                추가 필수 조건: FAQ ≥ 3개, 관련 인사이트 ≥ 2개, shortAnswer 존재, classification ≠ drop
              </div>
            </div>
            <div style={{ padding: "14px 16px", background: sf.autoPublishDryRun ? "#fffbeb" : "#f9fafb", borderRadius: 10, border: `1.5px solid ${sf.autoPublishDryRun ? "#fde68a" : "#e5e7eb"}` }}>
              <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                <input type="checkbox" checked={sf.autoPublishDryRun}
                  onChange={e => set("autoPublishDryRun")(e.target.checked)}
                  style={{ width: 18, height: 18, cursor: "pointer", accentColor: "#d97706" }} />
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: sf.autoPublishDryRun ? "#d97706" : "#374151" }}>드라이런 모드 (Dry Run)</div>
                  <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>실제 게시하지 않고 로그만 기록 — 테스트 시 사용</div>
                </div>
              </label>
            </div>
            <div style={{ padding: "12px 14px", background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12, color: "#374151", lineHeight: 1.8 }}>
              <strong>현재 설정 요약:</strong><br />
              자동 게시: <strong style={{ color: sf.autoPublishEnabled ? "#059669" : "#dc2626" }}>{sf.autoPublishEnabled ? "활성화" : "비활성화"}</strong>
              {" · "}기준 점수: <strong>{sf.autoPublishThreshold}점</strong>
              {" · "}드라이런: <strong style={{ color: sf.autoPublishDryRun ? "#d97706" : "#6b7280" }}>{sf.autoPublishDryRun ? "ON (로그만)" : "OFF (실제 게시)"}</strong>
            </div>
          </div>
          {saveBtn}
        </Card>
      )}

      {/* ── DOCX 진단 탭 ── */}
      {settingsTab === "docx-diag" && (
        <DocxDiagPanel token={token} />
      )}
    </Section>
  );
}

// ─── DOCX 진단 패널 ───────────────────────────────────────────────────────────

interface DiagResult {
  filename:           string;
  sha256:             string;
  fileSize:           number;
  method:             string;
  wordCount:          number;
  charCountNoSpace:   number;
  charCountWithSpace: number;
  detectedLanguage:   string;
  appXml: {
    words: number | null;
    chars: number | null;
    note:  string;
  };
  partBreakdown: Record<string, number>;
  warning: string | null;
}

function DocxDiagPanel({ token }: { token: string }) {
  const [file, setFile]         = useState<File | null>(null);
  const [result, setResult]     = useState<DiagResult | null>(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [wordWord, setWordWord]  = useState('');
  const inputRef                 = useRef<HTMLInputElement>(null);

  const handleFile = (f: File) => {
    if (!f.name.endsWith('.docx')) { setError('DOCX 파일만 지원합니다.'); return; }
    setFile(f); setResult(null); setError('');
  };

  const handleRun = async () => {
    if (!file) return;
    setLoading(true); setError(''); setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const resp = await fetch('/api/diag/docx', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${resp.status}`);
      }
      setResult(await resp.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : '분석 실패');
    } finally {
      setLoading(false);
    }
  };

  const wordDiff = result && wordWord
    ? result.wordCount - parseInt(wordWord.replace(/,/g, ''), 10)
    : null;
  const wordDiffPct = result && wordWord && parseInt(wordWord.replace(/,/g, ''), 10) > 0
    ? ((result.wordCount - parseInt(wordWord.replace(/,/g, ''), 10)) / parseInt(wordWord.replace(/,/g, ''), 10) * 100)
    : null;

  const row = (label: string, value: React.ReactNode) => (
    <tr key={label}>
      <td style={{ padding: '7px 12px', fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap', width: 180, borderBottom: '1px solid #f3f4f6', fontWeight: 600 }}>{label}</td>
      <td style={{ padding: '7px 12px', fontSize: 13, color: '#111827', borderBottom: '1px solid #f3f4f6', fontFamily: 'monospace', wordBreak: 'break-all' }}>{value}</td>
    </tr>
  );

  return (
    <Card>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 4 }}>DOCX 추출 진단</div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          DOCX 파일을 업로드하면 SHA-256, 단어수, 글자수, app.xml 캐시값, 파트별 분포를 확인합니다.
          Word의 &quot;검토 → 단어 개수&quot; 값과 비교하여 정확도를 검증하세요.
        </div>
      </div>

      {/* 파일 선택 */}
      <div
        onClick={() => inputRef.current?.click()}
        onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
        onDragOver={e => e.preventDefault()}
        style={{
          border: '2px dashed #d1d5db', borderRadius: 10, padding: '20px 16px',
          textAlign: 'center', cursor: 'pointer', marginBottom: 12,
          background: file ? '#f0fdf4' : '#fafafa',
        }}
        data-testid="docx-diag-drop"
      >
        <input ref={inputRef} type="file" accept=".docx" style={{ display: 'none' }}
          onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} />
        {file
          ? <div style={{ fontSize: 13, color: '#059669', fontWeight: 600 }}>✓ {file.name} ({(file.size / 1024).toFixed(1)} KB)</div>
          : <div style={{ fontSize: 13, color: '#9ca3af' }}>DOCX 파일을 드래그하거나 클릭하여 선택</div>
        }
      </div>

      {/* Word 단어수 입력 */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>
          Word 단어 개수 (선택) — 검토 → 단어 개수 결과를 입력하면 오차를 계산합니다
        </label>
        <input
          type="text"
          value={wordWord}
          onChange={e => setWordWord(e.target.value)}
          placeholder="예: 9332"
          style={{ ...inputStyle, width: 200 }}
          data-testid="docx-diag-word-count"
        />
      </div>

      <button
        onClick={handleRun}
        disabled={!file || loading}
        style={{
          padding: '9px 22px', borderRadius: 8, border: 'none', cursor: file && !loading ? 'pointer' : 'not-allowed',
          background: file && !loading ? '#2563eb' : '#e5e7eb',
          color: file && !loading ? '#fff' : '#9ca3af',
          fontSize: 13, fontWeight: 700, marginBottom: 16,
        }}
        data-testid="docx-diag-run"
      >
        {loading ? '⏳ 분석 중…' : '🔍 분석 실행'}
      </button>

      {error && (
        <div style={{ padding: '10px 14px', borderRadius: 8, background: '#fee2e2', color: '#dc2626', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {result && (
        <div>
          <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
            <tbody>
              {row('파일명', result.filename)}
              {row('SHA-256', <span style={{ fontSize: 11 }}>{result.sha256}</span>)}
              {row('파일 크기', `${(result.fileSize / 1024).toFixed(1)} KB`)}
              {row('추출 방식', result.method)}
              {row('언어 감지', result.detectedLanguage)}
              <tr><td colSpan={2} style={{ padding: '6px 12px', background: '#f8fafc', fontSize: 11, fontWeight: 700, color: '#374151', borderBottom: '1px solid #f3f4f6' }}>AI 추출 결과</td></tr>
              {row('단어수 (AI)', <strong style={{ fontSize: 15, color: '#1d4ed8' }}>{result.wordCount.toLocaleString()}</strong>)}
              {row('글자수 공백제외 (AI)', result.charCountNoSpace.toLocaleString())}
              {row('글자수 공백포함 (AI)', result.charCountWithSpace.toLocaleString())}
              {wordWord && wordDiff !== null && (
                <>
                  <tr><td colSpan={2} style={{ padding: '6px 12px', background: '#f8fafc', fontSize: 11, fontWeight: 700, color: '#374151', borderBottom: '1px solid #f3f4f6' }}>Word 비교</td></tr>
                  {row('Word 단어 개수', <strong>{parseInt(wordWord.replace(/,/g, ''), 10).toLocaleString()}</strong>)}
                  {row('차이 (AI − Word)', (
                    <span style={{ color: Math.abs(wordDiff) <= Math.abs(parseInt(wordWord.replace(/,/g, ''), 10) * 0.01) ? '#059669' : '#dc2626', fontWeight: 700 }}>
                      {wordDiff > 0 ? '+' : ''}{wordDiff.toLocaleString()}
                      {wordDiffPct !== null && ` (${wordDiffPct > 0 ? '+' : ''}${wordDiffPct.toFixed(2)}%)`}
                    </span>
                  ))}
                </>
              )}
              <tr><td colSpan={2} style={{ padding: '6px 12px', background: '#f8fafc', fontSize: 11, fontWeight: 700, color: '#374151', borderBottom: '1px solid #f3f4f6' }}>app.xml 캐시 (Word 저장 당시)</td></tr>
              {row('Words (app.xml)', result.appXml.words != null ? result.appXml.words.toLocaleString() : '없음')}
              {row('Characters (app.xml)', result.appXml.chars != null ? result.appXml.chars.toLocaleString() : '없음')}
              {row('주의', <span style={{ fontSize: 11, color: '#6b7280' }}>{result.appXml.note}</span>)}
              {Object.keys(result.partBreakdown).length > 0 && (
                <>
                  <tr><td colSpan={2} style={{ padding: '6px 12px', background: '#f8fafc', fontSize: 11, fontWeight: 700, color: '#374151', borderBottom: '1px solid #f3f4f6' }}>파트별 단어 분포</td></tr>
                  {Object.entries(result.partBreakdown).map(([part, wc]) =>
                    row(part, `${wc.toLocaleString()} words`)
                  )}
                </>
              )}
              {result.warning && row('경고', <span style={{ color: '#d97706' }}>{result.warning}</span>)}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
