import React, { useState, useCallback, useEffect } from 'react';
import { api } from '../../lib/constants';
import { Card, PrimaryBtn, GhostBtn, ClickSelect } from '../ui';

type ServiceType = "translation" | "interpretation" | "equipment";

type LsdItem = {
  id: number;
  serviceType: ServiceType;
  languagePair: string | null;
  domain: string | null;
  industry: string | null;
  useCase: string | null;
  unitPrice: number | null;
  totalPrice: number | null;
  turnaroundTime: string | null;
  isPublic: boolean;
  interpretationType: string | null;
  durationHours: string | null;
  numInterpreters: number | null;
  locationType: string | null;
  equipmentType: string | null;
  quantity: number | null;
  rentalDuration: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

type Insight = {
  id: number;
  serviceType: ServiceType;
  languageServiceDataId: number | null;
  question: string;
  answer: string;
  domain: string | null;
  languagePair: string | null;
  isPublic: boolean;
  createdAt: string;
};

const SERVICE_TYPE_LABELS: Record<ServiceType, string> = {
  translation: "번역",
  interpretation: "통역",
  equipment: "장비",
};
const SERVICE_TYPE_COLORS: Record<ServiceType, { bg: string; color: string }> = {
  translation: { bg: "#dbeafe", color: "#1e40af" },
  interpretation: { bg: "#dcfce7", color: "#166534" },
  equipment: { bg: "#fef3c7", color: "#92400e" },
};

const EMPTY_FORM = {
  serviceType: "translation" as ServiceType,
  languagePair: "", domain: "", industry: "", useCase: "",
  unitPrice: "", totalPrice: "", turnaroundTime: "", isPublic: true,
  interpretationType: "", durationHours: "", numInterpreters: "", locationType: "",
  equipmentType: "", quantity: "", rentalDuration: "", notes: "",
};

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div style={{ maxWidth: 1300, margin: "0 auto", padding: "24px 0" }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#111827" }}>{title}</h2>
        {sub && <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6b7280" }}>{sub}</p>}
      </div>
      {children}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: "#6b7280" }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, width: "100%", boxSizing: "border-box",
};

export function LanguageServiceDataTab({ token, setToast }: { token: string; setToast: (msg: string) => void }) {
  const authHeaders = { Authorization: `Bearer ${token}` };
  const jsonHeaders = { ...authHeaders, "Content-Type": "application/json" };

  const [items, setItems] = useState<LsdItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const limit = 30;
  const [loading, setLoading] = useState(false);

  const [filterType, setFilterType] = useState<ServiceType | "">("");
  const [filterDomain, setFilterDomain] = useState("");
  const [filterLang, setFilterLang] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);

  const [selectedItem, setSelectedItem] = useState<LsdItem | null>(null);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [showInsightForm, setShowInsightForm] = useState(false);
  const [insightForm, setInsightForm] = useState({ question: "", answer: "", isPublic: true });
  const [insightSaving, setInsightSaving] = useState(false);

  const fetchItems = useCallback(async (p = 1) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterType) params.set("serviceType", filterType);
      if (filterDomain) params.set("domain", filterDomain);
      if (filterLang) params.set("languagePair", filterLang);
      params.set("page", String(p));
      params.set("limit", String(limit));
      const res = await fetch(api(`/api/admin/language-service-data?${params.toString()}`), { headers: authHeaders });
      if (res.ok) {
        const d = await res.json();
        setItems(d.data ?? []);
        setTotal(d.total ?? 0);
        setPage(p);
      }
    } catch { setToast("오류: 목록 조회 실패"); }
    finally { setLoading(false); }
  }, [token, filterType, filterDomain, filterLang]);

  const fetchInsights = useCallback(async (id: number) => {
    setInsightsLoading(true);
    try {
      const res = await fetch(api(`/api/admin/language-service-data/${id}/insights`), { headers: authHeaders });
      if (res.ok) setInsights(await res.json());
    } catch {}
    finally { setInsightsLoading(false); }
  }, [token]);

  useEffect(() => { fetchItems(1); }, []);

  const handleSave = async () => {
    if (!form.serviceType) { setToast("서비스 유형을 선택하세요."); return; }
    setSaving(true);
    try {
      const body = {
        serviceType: form.serviceType,
        languagePair: form.languagePair || null,
        domain: form.domain || null,
        industry: form.industry || null,
        useCase: form.useCase || null,
        unitPrice: form.unitPrice ? Number(form.unitPrice) : null,
        totalPrice: form.totalPrice ? Number(form.totalPrice) : null,
        turnaroundTime: form.turnaroundTime || null,
        isPublic: form.isPublic,
        interpretationType: form.serviceType === "interpretation" ? (form.interpretationType || null) : null,
        durationHours: form.serviceType === "interpretation" && form.durationHours ? form.durationHours : null,
        numInterpreters: form.serviceType === "interpretation" && form.numInterpreters ? Number(form.numInterpreters) : null,
        locationType: form.serviceType === "interpretation" ? (form.locationType || null) : null,
        equipmentType: form.serviceType === "equipment" ? (form.equipmentType || null) : null,
        quantity: form.serviceType === "equipment" && form.quantity ? Number(form.quantity) : null,
        rentalDuration: form.serviceType === "equipment" ? (form.rentalDuration || null) : null,
        notes: form.notes || null,
      };
      const url = editingId ? `/api/admin/language-service-data/${editingId}` : "/api/admin/language-service-data";
      const method = editingId ? "PATCH" : "POST";
      const res = await fetch(api(url), { method, headers: jsonHeaders, body: JSON.stringify(body) });
      const d = await res.json();
      if (res.ok) {
        setToast(editingId ? "수정 완료" : "등록 완료");
        setShowForm(false);
        setEditingId(null);
        setForm({ ...EMPTY_FORM });
        fetchItems(editingId ? page : 1);
        if (selectedItem?.id === editingId) setSelectedItem(d);
      } else { setToast("오류: " + (d.error ?? "저장 실패")); }
    } catch { setToast("오류: 저장 실패"); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("이 항목을 삭제하시겠습니까?")) return;
    try {
      const res = await fetch(api(`/api/admin/language-service-data/${id}`), { method: "DELETE", headers: authHeaders });
      if (res.ok) {
        setToast("삭제 완료");
        if (selectedItem?.id === id) { setSelectedItem(null); setInsights([]); }
        fetchItems(page);
      } else { setToast("오류: 삭제 실패"); }
    } catch { setToast("오류: 삭제 실패"); }
  };

  const handleAddInsight = async () => {
    if (!selectedItem) return;
    if (!insightForm.question || !insightForm.answer) { setToast("질문과 답변은 필수입니다."); return; }
    setInsightSaving(true);
    try {
      const res = await fetch(api(`/api/admin/language-service-data/${selectedItem.id}/insights`), {
        method: "POST", headers: jsonHeaders,
        body: JSON.stringify(insightForm),
      });
      const d = await res.json();
      if (res.ok) {
        setToast("인사이트 추가 완료");
        setShowInsightForm(false);
        setInsightForm({ question: "", answer: "", isPublic: true });
        fetchInsights(selectedItem.id);
      } else { setToast("오류: " + (d.error ?? "실패")); }
    } catch { setToast("오류: 인사이트 추가 실패"); }
    finally { setInsightSaving(false); }
  };

  const handleDeleteInsight = async (id: number) => {
    if (!confirm("인사이트를 삭제하시겠습니까?")) return;
    try {
      const res = await fetch(api(`/api/admin/content-insights/${id}`), { method: "DELETE", headers: authHeaders });
      if (res.ok) { setToast("삭제 완료"); if (selectedItem) fetchInsights(selectedItem.id); }
      else setToast("오류: 삭제 실패");
    } catch { setToast("오류: 삭제 실패"); }
  };

  const openEdit = (item: LsdItem) => {
    setEditingId(item.id);
    setForm({
      serviceType: item.serviceType,
      languagePair: item.languagePair ?? "",
      domain: item.domain ?? "",
      industry: item.industry ?? "",
      useCase: item.useCase ?? "",
      unitPrice: item.unitPrice !== null ? String(item.unitPrice) : "",
      totalPrice: item.totalPrice !== null ? String(item.totalPrice) : "",
      turnaroundTime: item.turnaroundTime ?? "",
      isPublic: item.isPublic,
      interpretationType: item.interpretationType ?? "",
      durationHours: item.durationHours ?? "",
      numInterpreters: item.numInterpreters !== null ? String(item.numInterpreters) : "",
      locationType: item.locationType ?? "",
      equipmentType: item.equipmentType ?? "",
      quantity: item.quantity !== null ? String(item.quantity) : "",
      rentalDuration: item.rentalDuration ?? "",
      notes: item.notes ?? "",
    });
    setShowForm(true);
  };

  const selectItem = (item: LsdItem) => {
    setSelectedItem(item);
    fetchInsights(item.id);
    setShowInsightForm(false);
  };

  const f = form;
  const st = f.serviceType;

  return (
    <Section title="언어 서비스 데이터" sub="번역·통역·장비 서비스 레퍼런스 데이터를 관리합니다. AEO/GEO 콘텐츠 인사이트 생성 기반.">

      {/* 필터 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <ClickSelect value={filterType}
          onChange={v => setFilterType(v as ServiceType | "")}
          options={[
            { value: "", label: "전체 유형" },
            { value: "translation", label: "번역" },
            { value: "interpretation", label: "통역" },
            { value: "equipment", label: "장비" },
          ]}
          triggerStyle={{ fontSize: 12, padding: "6px 10px" }} />
        <input placeholder="언어쌍 (예: ko-en)" value={filterLang}
          onChange={e => setFilterLang(e.target.value)}
          style={{ padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, width: 140 }} />
        <input placeholder="도메인" value={filterDomain}
          onChange={e => setFilterDomain(e.target.value)}
          style={{ padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, width: 110 }} />
        <GhostBtn onClick={() => fetchItems(1)} disabled={loading}>검색</GhostBtn>
        <GhostBtn onClick={() => { setFilterType(""); setFilterDomain(""); setFilterLang(""); setTimeout(() => fetchItems(1), 0); }}>초기화</GhostBtn>
        <div style={{ flex: 1 }} />
        <PrimaryBtn onClick={() => { setEditingId(null); setForm({ ...EMPTY_FORM }); setShowForm(true); }}>+ 새 항목 추가</PrimaryBtn>
      </div>

      {/* 입력 폼 */}
      {showForm && (
        <Card style={{ padding: 20, marginBottom: 16, background: "#f8faff", border: "1px solid #bfdbfe" }}>
          <p style={{ margin: "0 0 16px", fontWeight: 700, color: "#1e40af", fontSize: 15 }}>
            {editingId ? "항목 수정" : "새 항목 등록"}
          </p>

          {/* 공통 필드 */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12, marginBottom: 14 }}>
            <FieldRow label="서비스 유형 *">
              <select value={st} onChange={e => setForm(p => ({ ...p, serviceType: e.target.value as ServiceType }))}
                style={{ ...inputStyle }}>
                <option value="translation">번역</option>
                <option value="interpretation">통역</option>
                <option value="equipment">장비</option>
              </select>
            </FieldRow>
            <FieldRow label="언어쌍 (예: ko-en)">
              <input value={f.languagePair} onChange={e => setForm(p => ({ ...p, languagePair: e.target.value }))} style={inputStyle} placeholder="ko-en" />
            </FieldRow>
            <FieldRow label="도메인">
              <select value={f.domain} onChange={e => setForm(p => ({ ...p, domain: e.target.value }))} style={inputStyle}>
                <option value="">-</option>
                {["general","legal","finance","medical","it","marketing","technical","other"].map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </FieldRow>
            <FieldRow label="산업/업종">
              <input value={f.industry} onChange={e => setForm(p => ({ ...p, industry: e.target.value }))} style={inputStyle} placeholder="금융, 의료, IT..." />
            </FieldRow>
            <FieldRow label="사용 목적">
              <input value={f.useCase} onChange={e => setForm(p => ({ ...p, useCase: e.target.value }))} style={inputStyle} placeholder="계약서, 컨퍼런스..." />
            </FieldRow>
            <FieldRow label="단가 (원)">
              <input type="number" value={f.unitPrice} onChange={e => setForm(p => ({ ...p, unitPrice: e.target.value }))} style={inputStyle} placeholder="0" />
            </FieldRow>
            <FieldRow label="총 금액 (원)">
              <input type="number" value={f.totalPrice} onChange={e => setForm(p => ({ ...p, totalPrice: e.target.value }))} style={inputStyle} placeholder="0" />
            </FieldRow>
            <FieldRow label="납기">
              <input value={f.turnaroundTime} onChange={e => setForm(p => ({ ...p, turnaroundTime: e.target.value }))} style={inputStyle} placeholder="2 business days" />
            </FieldRow>
            <FieldRow label="공개 여부">
              <select value={f.isPublic ? "true" : "false"} onChange={e => setForm(p => ({ ...p, isPublic: e.target.value === "true" }))} style={inputStyle}>
                <option value="true">공개</option>
                <option value="false">비공개</option>
              </select>
            </FieldRow>
          </div>

          {/* 통역 전용 필드 */}
          {st === "interpretation" && (
            <div style={{ marginBottom: 14 }}>
              <p style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 700, color: "#059669" }}>통역 세부 정보</p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
                <FieldRow label="통역 유형">
                  <select value={f.interpretationType} onChange={e => setForm(p => ({ ...p, interpretationType: e.target.value }))} style={inputStyle}>
                    <option value="">-</option>
                    <option value="simultaneous">동시통역</option>
                    <option value="consecutive">순차통역</option>
                    <option value="whisper">위스퍼</option>
                    <option value="sight">시역</option>
                  </select>
                </FieldRow>
                <FieldRow label="시간 (시)">
                  <input type="number" step="0.5" value={f.durationHours} onChange={e => setForm(p => ({ ...p, durationHours: e.target.value }))} style={inputStyle} placeholder="8.0" />
                </FieldRow>
                <FieldRow label="통역사 수">
                  <input type="number" value={f.numInterpreters} onChange={e => setForm(p => ({ ...p, numInterpreters: e.target.value }))} style={inputStyle} placeholder="1" />
                </FieldRow>
                <FieldRow label="장소 유형">
                  <select value={f.locationType} onChange={e => setForm(p => ({ ...p, locationType: e.target.value }))} style={inputStyle}>
                    <option value="">-</option>
                    <option value="onsite">현장</option>
                    <option value="remote">원격</option>
                    <option value="hybrid">하이브리드</option>
                  </select>
                </FieldRow>
              </div>
            </div>
          )}

          {/* 장비 전용 필드 */}
          {st === "equipment" && (
            <div style={{ marginBottom: 14 }}>
              <p style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 700, color: "#d97706" }}>장비 세부 정보</p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
                <FieldRow label="장비 유형">
                  <input value={f.equipmentType} onChange={e => setForm(p => ({ ...p, equipmentType: e.target.value }))} style={inputStyle} placeholder="동시통역 부스, 수신기..." />
                </FieldRow>
                <FieldRow label="수량">
                  <input type="number" value={f.quantity} onChange={e => setForm(p => ({ ...p, quantity: e.target.value }))} style={inputStyle} placeholder="1" />
                </FieldRow>
                <FieldRow label="렌탈 기간">
                  <input value={f.rentalDuration} onChange={e => setForm(p => ({ ...p, rentalDuration: e.target.value }))} style={inputStyle} placeholder="1일, 3일..." />
                </FieldRow>
              </div>
            </div>
          )}

          <FieldRow label="메모">
            <textarea value={f.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
              rows={2} style={{ ...inputStyle, resize: "vertical" }} placeholder="추가 메모" />
          </FieldRow>

          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <PrimaryBtn onClick={handleSave} disabled={saving}>{saving ? "저장 중..." : (editingId ? "수정 저장" : "등록")}</PrimaryBtn>
            <GhostBtn onClick={() => { setShowForm(false); setEditingId(null); setForm({ ...EMPTY_FORM }); }}>취소</GhostBtn>
          </div>
        </Card>
      )}

      {/* 목록 + 상세 패널 */}
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        {/* 테이블 */}
        <Card style={{ flex: 1, overflowX: "auto", padding: 0 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "#f3f4f6" }}>
                {["ID","유형","언어쌍","도메인","사용목적","단가","납기","공개","생성일","액션"].map(h => (
                  <th key={h} style={{ padding: "8px 10px", fontWeight: 600, fontSize: 11, color: "#374151", textAlign: "left", whiteSpace: "nowrap", borderBottom: "1px solid #e5e7eb" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={10} style={{ padding: 24, textAlign: "center", color: "#9ca3af" }}>로딩 중...</td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={10} style={{ padding: 32, textAlign: "center", color: "#9ca3af" }}>
                  <div style={{ fontSize: 28 }}>📊</div>
                  <div style={{ marginTop: 8 }}>데이터가 없습니다.<br /><span style={{ fontSize: 12 }}>+ 새 항목 추가 버튼으로 서비스 데이터를 등록하세요.</span></div>
                </td></tr>
              ) : items.map(item => {
                const isSelected = selectedItem?.id === item.id;
                const typeColor = SERVICE_TYPE_COLORS[item.serviceType];
                return (
                  <tr key={item.id}
                    onClick={() => selectItem(item)}
                    style={{ cursor: "pointer", background: isSelected ? "#eff6ff" : "transparent", borderBottom: "1px solid #f3f4f6" }}
                    onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLTableRowElement).style.background = "#f9fafb"; }}
                    onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLTableRowElement).style.background = "transparent"; }}
                  >
                    <td style={{ padding: "7px 10px", color: "#9ca3af" }}>{item.id}</td>
                    <td style={{ padding: "7px 10px" }}>
                      <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 700, ...typeColor }}>
                        {SERVICE_TYPE_LABELS[item.serviceType]}
                      </span>
                    </td>
                    <td style={{ padding: "7px 10px", color: "#374151" }}>{item.languagePair ?? "-"}</td>
                    <td style={{ padding: "7px 10px", color: "#6b7280" }}>{item.domain ?? "-"}</td>
                    <td style={{ padding: "7px 10px", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#374151" }} title={item.useCase ?? ""}>{item.useCase ?? "-"}</td>
                    <td style={{ padding: "7px 10px", color: "#374151" }}>{item.unitPrice !== null ? item.unitPrice.toLocaleString() + "원" : "-"}</td>
                    <td style={{ padding: "7px 10px", color: "#6b7280" }}>{item.turnaroundTime ?? "-"}</td>
                    <td style={{ padding: "7px 10px" }}>
                      <span style={{ fontSize: 11, color: item.isPublic ? "#059669" : "#9ca3af" }}>{item.isPublic ? "공개" : "비공개"}</span>
                    </td>
                    <td style={{ padding: "7px 10px", color: "#9ca3af", whiteSpace: "nowrap" }}>
                      {new Date(item.createdAt).toLocaleDateString("ko-KR")}
                    </td>
                    <td style={{ padding: "7px 10px" }}>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button onClick={e => { e.stopPropagation(); openEdit(item); }}
                          style={{ padding: "3px 8px", background: "#e0f2fe", color: "#0284c7", border: "none", borderRadius: 4, fontSize: 11, cursor: "pointer" }}>수정</button>
                        <button onClick={e => { e.stopPropagation(); handleDelete(item.id); }}
                          style={{ padding: "3px 8px", background: "#fee2e2", color: "#dc2626", border: "none", borderRadius: 4, fontSize: 11, cursor: "pointer" }}>삭제</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {total > limit && (
            <div style={{ display: "flex", gap: 6, justifyContent: "center", padding: "12px 0", borderTop: "1px solid #f3f4f6" }}>
              <GhostBtn disabled={page <= 1} onClick={() => fetchItems(page - 1)}>이전</GhostBtn>
              <span style={{ fontSize: 12, color: "#6b7280", padding: "6px 12px" }}>
                {page} / {Math.ceil(total / limit)} (총 {total}건)
              </span>
              <GhostBtn disabled={page >= Math.ceil(total / limit)} onClick={() => fetchItems(page + 1)}>다음</GhostBtn>
            </div>
          )}
        </Card>

        {/* 상세/인사이트 패널 */}
        {selectedItem && (
          <Card style={{ width: 380, flexShrink: 0, padding: 16, fontSize: 13 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <p style={{ margin: 0, fontWeight: 700, color: "#111827" }}>
                #{selectedItem.id} — {SERVICE_TYPE_LABELS[selectedItem.serviceType]}
              </p>
              <button onClick={() => { setSelectedItem(null); setInsights([]); setShowInsightForm(false); }}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 18 }}>×</button>
            </div>

            {/* 상세 정보 그리드 */}
            <div style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: "5px 8px", marginBottom: 14, fontSize: 12 }}>
              <span style={{ color: "#6b7280" }}>언어쌍</span><span>{selectedItem.languagePair ?? "-"}</span>
              <span style={{ color: "#6b7280" }}>도메인</span><span>{selectedItem.domain ?? "-"}</span>
              <span style={{ color: "#6b7280" }}>산업</span><span>{selectedItem.industry ?? "-"}</span>
              <span style={{ color: "#6b7280" }}>사용목적</span><span>{selectedItem.useCase ?? "-"}</span>
              <span style={{ color: "#6b7280" }}>단가</span><span>{selectedItem.unitPrice !== null ? selectedItem.unitPrice.toLocaleString() + "원" : "-"}</span>
              <span style={{ color: "#6b7280" }}>총금액</span><span>{selectedItem.totalPrice !== null ? selectedItem.totalPrice.toLocaleString() + "원" : "-"}</span>
              <span style={{ color: "#6b7280" }}>납기</span><span>{selectedItem.turnaroundTime ?? "-"}</span>
              {selectedItem.serviceType === "interpretation" && <>
                <span style={{ color: "#6b7280" }}>통역유형</span><span>{selectedItem.interpretationType ?? "-"}</span>
                <span style={{ color: "#6b7280" }}>시간</span><span>{selectedItem.durationHours ? selectedItem.durationHours + "h" : "-"}</span>
                <span style={{ color: "#6b7280" }}>통역사수</span><span>{selectedItem.numInterpreters ?? "-"}</span>
                <span style={{ color: "#6b7280" }}>장소유형</span><span>{selectedItem.locationType ?? "-"}</span>
              </>}
              {selectedItem.serviceType === "equipment" && <>
                <span style={{ color: "#6b7280" }}>장비유형</span><span>{selectedItem.equipmentType ?? "-"}</span>
                <span style={{ color: "#6b7280" }}>수량</span><span>{selectedItem.quantity ?? "-"}</span>
                <span style={{ color: "#6b7280" }}>렌탈기간</span><span>{selectedItem.rentalDuration ?? "-"}</span>
              </>}
              {selectedItem.notes && <>
                <span style={{ color: "#6b7280" }}>메모</span><span style={{ wordBreak: "break-word" }}>{selectedItem.notes}</span>
              </>}
            </div>

            {/* 인사이트 섹션 */}
            <div style={{ borderTop: "1px solid #f3f4f6", paddingTop: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "#4b5563" }}>
                  AEO/GEO 인사이트 {insights.length > 0 ? `(${insights.length})` : ""}
                </p>
                <button onClick={() => setShowInsightForm(v => !v)}
                  style={{ padding: "3px 8px", background: "#f0fdf4", color: "#16a34a", border: "1px solid #bbf7d0", borderRadius: 4, fontSize: 11, cursor: "pointer" }}>
                  + 추가
                </button>
              </div>

              {showInsightForm && (
                <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6, padding: 12, marginBottom: 10 }}>
                  <textarea placeholder="질문 (Q)" value={insightForm.question}
                    onChange={e => setInsightForm(p => ({ ...p, question: e.target.value }))}
                    rows={2} style={{ ...inputStyle, marginBottom: 6 }} />
                  <textarea placeholder="답변 (A)" value={insightForm.answer}
                    onChange={e => setInsightForm(p => ({ ...p, answer: e.target.value }))}
                    rows={3} style={{ ...inputStyle, marginBottom: 8 }} />
                  <div style={{ display: "flex", gap: 6 }}>
                    <button disabled={insightSaving} onClick={handleAddInsight}
                      style={{ padding: "5px 12px", background: "#16a34a", color: "#fff", border: "none", borderRadius: 6, fontSize: 12, cursor: "pointer", opacity: insightSaving ? 0.6 : 1 }}>
                      {insightSaving ? "저장 중..." : "저장"}
                    </button>
                    <GhostBtn onClick={() => { setShowInsightForm(false); setInsightForm({ question: "", answer: "", isPublic: true }); }}>취소</GhostBtn>
                  </div>
                </div>
              )}

              {insightsLoading ? (
                <div style={{ fontSize: 12, color: "#9ca3af", padding: "8px 0" }}>로딩 중...</div>
              ) : insights.length === 0 ? (
                <div style={{ fontSize: 12, color: "#d1d5db", padding: "8px 0", textAlign: "center" }}>인사이트 없음</div>
              ) : (
                <div style={{ maxHeight: 300, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
                  {insights.map(ins => (
                    <div key={ins.id} style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6, padding: "8px 10px", fontSize: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: "#2563eb" }}>Q</span>
                        <button onClick={() => handleDeleteInsight(ins.id)}
                          style={{ background: "none", border: "none", color: "#dc2626", cursor: "pointer", fontSize: 12, padding: 0 }}>✕</button>
                      </div>
                      <p style={{ margin: "0 0 6px", lineHeight: 1.5, color: "#374151" }}>{ins.question}</p>
                      <span style={{ fontSize: 11, fontWeight: 600, color: "#059669" }}>A</span>
                      <p style={{ margin: "2px 0 0", lineHeight: 1.5, color: "#6b7280" }}>{ins.answer}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        )}
      </div>
    </Section>
  );
}
