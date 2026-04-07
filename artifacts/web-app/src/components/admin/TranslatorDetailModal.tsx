import React, { useState, useEffect } from "react";
import { api, TranslatorProfile, TranslatorRate, TranslatorProduct, NoteEntry, Product } from "../../lib/constants";
import { PrimaryBtn, GhostBtn } from "../ui";
import { ReviewMemoPanel } from "./ReviewMemoPanel";
import { DraggableModal } from "./DraggableModal";
import { SensitiveInfoModal } from "./SensitiveInfoModal";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};

const GRADE_OPTIONS = ["S", "A", "B", "C"];
const LANG_LEVEL_OPTIONS = ["일반", "비즈니스", "전문"];

export function TranslatorDetailModal({ userId, userEmail, token, permissions = [], onClose, onToast }: {
  userId: number; userEmail: string; token: string;
  permissions?: string[];
  onClose: () => void; onToast: (msg: string) => void;
}) {
  const hasPerm = (key: string) => permissions.includes(key);
  const [profile, setProfile] = useState<TranslatorProfile | null>(null);
  const [rates, setRates] = useState<TranslatorRate[]>([]);
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [translatorProducts, setTranslatorProducts] = useState<TranslatorProduct[]>([]);
  const [availableProducts, setAvailableProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [rateForm, setRateForm] = useState({ serviceType: "", languagePair: "", unit: "word", rate: "" });
  const [addingRate, setAddingRate] = useState(false);
  const [tpForm, setTpForm] = useState({ productId: "", unitPrice: "", note: "" });
  const [addingTp, setAddingTp] = useState(false);
  const [editingTpId, setEditingTpId] = useState<number | null>(null);
  const [editTpPrice, setEditTpPrice] = useState("");
  const [showSensitive, setShowSensitive] = useState(false);

  const [form, setForm] = useState({
    languagePairs: "", languageLevel: "", specializations: "", education: "", major: "",
    graduationYear: "", region: "", grade: "", rating: "", availabilityStatus: "available",
    bio: "", ratePerWord: "", ratePerPage: "", resumeUrl: "", portfolioUrl: "",
  });

  const authH = { Authorization: `Bearer ${token}` };

  const load = async () => {
    setLoading(true);
    try {
      const [dRes, nRes, pRes] = await Promise.all([
        fetch(api(`/api/admin/translators/${userId}`), { headers: authH }),
        fetch(api(`/api/admin/notes?entityType=translator&entityId=${userId}`), { headers: authH }),
        fetch(api("/api/admin/products"), { headers: authH }),
      ]);
      const [dData, nData, pData] = await Promise.all([dRes.json(), nRes.json(), pRes.json()]);
      if (dRes.ok) {
        const p: TranslatorProfile | null = dData.profile;
        setProfile(p);
        setRates(Array.isArray(dData.rates) ? dData.rates : []);
        setTranslatorProducts(Array.isArray(dData.translatorProducts) ? dData.translatorProducts : []);
        if (p) {
          setForm({
            languagePairs: p.languagePairs ?? "", languageLevel: p.languageLevel ?? "",
            specializations: p.specializations ?? "", education: p.education ?? "", major: p.major ?? "",
            graduationYear: p.graduationYear ? String(p.graduationYear) : "",
            region: p.region ?? "", grade: p.grade ?? "",
            rating: p.rating ? String(p.rating) : "",
            availabilityStatus: p.availabilityStatus ?? "available",
            bio: p.bio ?? "", ratePerWord: p.ratePerWord ? String(p.ratePerWord) : "",
            ratePerPage: p.ratePerPage ? String(p.ratePerPage) : "",
            resumeUrl: p.resumeUrl ?? "", portfolioUrl: p.portfolioUrl ?? "",
          });
        }
      }
      if (nRes.ok) setNotes(Array.isArray(nData) ? nData : []);
      if (pRes.ok) setAvailableProducts(Array.isArray(pData) ? pData.filter((p: Product) => p.active) : []);
    } catch { onToast("오류: 통번역사 정보 불러오기 실패"); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [userId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(api(`/api/admin/translators/${userId}`), {
        method: "PATCH", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          graduationYear: form.graduationYear ? Number(form.graduationYear) : null,
          rating: form.rating ? Number(form.rating) : null,
          ratePerWord: form.ratePerWord ? Number(form.ratePerWord) : null,
          ratePerPage: form.ratePerPage ? Number(form.ratePerPage) : null,
          grade: form.grade || null,
          languageLevel: form.languageLevel || null,
          resumeUrl: form.resumeUrl || null,
          portfolioUrl: form.portfolioUrl || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setProfile(data);
      onToast("통번역사 프로필이 저장되었습니다.");
    } catch { onToast("오류: 저장 실패"); }
    finally { setSaving(false); }
  };

  const handleAddRate = async () => {
    if (!rateForm.serviceType.trim() || !rateForm.languagePair.trim() || !rateForm.rate) return;
    setAddingRate(true);
    try {
      const res = await fetch(api(`/api/admin/translators/${userId}/rates`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ ...rateForm, rate: Number(rateForm.rate) }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setRates(prev => [data, ...prev]);
      setRateForm({ serviceType: "", languagePair: "", unit: "word", rate: "" });
      onToast("단가가 추가되었습니다.");
    } catch { onToast("오류: 단가 추가 실패"); }
    finally { setAddingRate(false); }
  };

  const handleDeleteRate = async (rateId: number) => {
    try {
      await fetch(api(`/api/admin/translators/${userId}/rates/${rateId}`), { method: "DELETE", headers: authH });
      setRates(prev => prev.filter(r => r.id !== rateId));
      onToast("단가가 삭제되었습니다.");
    } catch { onToast("오류: 단가 삭제 실패"); }
  };

  const handleAddProduct = async () => {
    if (!tpForm.productId) { onToast("상품을 선택하세요."); return; }
    setAddingTp(true);
    try {
      const res = await fetch(api(`/api/admin/translators/${userId}/products`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: Number(tpForm.productId),
          unitPrice: tpForm.unitPrice ? Number(tpForm.unitPrice) : null,
          note: tpForm.note || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setTranslatorProducts(prev => [...prev, data]);
      setTpForm({ productId: "", unitPrice: "", note: "" });
      onToast("수행 상품이 추가되었습니다.");
    } catch { onToast("오류: 수행 상품 추가 실패"); }
    finally { setAddingTp(false); }
  };

  const handleDeleteProduct = async (tpId: number) => {
    try {
      await fetch(api(`/api/admin/translators/${userId}/products/${tpId}`), { method: "DELETE", headers: authH });
      setTranslatorProducts(prev => prev.filter(p => p.id !== tpId));
      onToast("수행 상품이 삭제되었습니다.");
    } catch { onToast("오류: 수행 상품 삭제 실패"); }
  };

  const handleUpdateProductPrice = async (tpId: number) => {
    try {
      const res = await fetch(api(`/api/admin/translators/${userId}/products/${tpId}`), {
        method: "PATCH", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ unitPrice: editTpPrice ? Number(editTpPrice) : null }),
      });
      if (!res.ok) { onToast("오류: 단가 수정 실패"); return; }
      setTranslatorProducts(prev => prev.map(p => p.id === tpId ? { ...p, unitPrice: editTpPrice ? Number(editTpPrice) : null } : p));
      setEditingTpId(null);
      onToast("단가가 수정되었습니다.");
    } catch { onToast("오류: 단가 수정 실패"); }
  };

  const handleAddNote = async () => {
    if (!noteText.trim()) return;
    setAddingNote(true);
    try {
      const res = await fetch(api("/api/admin/notes"), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ entityType: "translator", entityId: userId, content: noteText.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setNotes(prev => [data, ...prev]);
      setNoteText("");
      onToast("메모가 추가되었습니다.");
    } catch { onToast("오류: 메모 추가 실패"); }
    finally { setAddingNote(false); }
  };

  const sH: React.CSSProperties = {
    fontSize: 12, fontWeight: 700, color: "#6b7280",
    textTransform: "uppercase", letterSpacing: "0.06em",
    margin: "20px 0 10px", paddingBottom: 6, borderBottom: "1px solid #f3f4f6",
  };
  const labelSt: React.CSSProperties = { fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 };
  const F = ({ label, field, type = "text", placeholder = "" }: { label: string; field: keyof typeof form; type?: string; placeholder?: string }) => (
    <div>
      <label style={labelSt}>{label}</label>
      <input type={type} value={form[field]} onChange={e => setForm(p => ({ ...p, [field]: e.target.value }))}
        placeholder={placeholder} style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
    </div>
  );

  const assignedProductIds = new Set(translatorProducts.map(p => p.productId));

  return (
    <>
    <DraggableModal title="통번역사 상세" subtitle={userEmail} onClose={onClose} width={860} zIndex={300} bodyPadding="20px 28px">
      {loading ? <p style={{ color: "#9ca3af", textAlign: "center", padding: "32px 0" }}>불러오는 중...</p> : (
        <>
          <ReviewMemoPanel storageKey={`translator_${userId}`} label="이 통번역사 검수 메모" />

          {/* ── 프로필 편집 ── */}
          <p style={sH}>프로필 편집</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px", marginBottom: 12 }}>
            <F label="언어쌍" field="languagePairs" placeholder="예: 한→영, 영→한" />
            <div>
              <label style={labelSt}>언어 레벨</label>
              <select value={form.languageLevel} onChange={e => setForm(p => ({ ...p, languageLevel: e.target.value }))}
                style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }}>
                <option value="">선택 안 함</option>
                {LANG_LEVEL_OPTIONS.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <F label="전문분야" field="specializations" placeholder="예: 법률, IT, 의학" />
            <div>
              <label style={labelSt}>등급</label>
              <select value={form.grade} onChange={e => setForm(p => ({ ...p, grade: e.target.value }))}
                style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }}>
                <option value="">등급 없음</option>
                {GRADE_OPTIONS.map(g => <option key={g} value={g}>{g}등급</option>)}
              </select>
            </div>
            <F label="학력" field="education" />
            <F label="전공" field="major" />
            <F label="졸업연도" field="graduationYear" type="number" />
            <F label="지역" field="region" />
            <F label="평점 (1-5)" field="rating" type="number" placeholder="예: 4.5" />
            <div>
              <label style={labelSt}>가용 상태</label>
              <select value={form.availabilityStatus} onChange={e => setForm(p => ({ ...p, availabilityStatus: e.target.value }))}
                style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }}>
                <option value="available">가능</option>
                <option value="busy">바쁨</option>
                <option value="unavailable">불가</option>
              </select>
            </div>
            <F label="기본 단가 (어절)" field="ratePerWord" type="number" />
            <F label="기본 단가 (페이지)" field="ratePerPage" type="number" />
            <F label="이력서 URL" field="resumeUrl" placeholder="https://..." />
            <F label="포트폴리오 URL" field="portfolioUrl" placeholder="https://..." />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={labelSt}>상세정보</label>
            <textarea value={form.bio} onChange={e => setForm(p => ({ ...p, bio: e.target.value }))}
              rows={3} style={{ ...inputStyle, fontSize: 13, padding: "8px 10px", resize: "vertical" }} />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
            <PrimaryBtn onClick={handleSave} disabled={saving} style={{ fontSize: 13, padding: "8px 20px" }}>
              {saving ? "저장 중..." : "프로필 저장"}
            </PrimaryBtn>
            {form.grade && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#fef3c7", color: "#92400e", borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 700 }}>
                ★ {form.grade}등급
              </span>
            )}
            {form.languageLevel && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#ede9fe", color: "#5b21b6", borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 600 }}>
                {form.languageLevel}
              </span>
            )}
          </div>

          {/* ── 수행 상품 ── */}
          <p style={sH}>수행 가능 상품 ({translatorProducts.length})</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 110px 1fr auto", gap: "6px 8px", alignItems: "end", marginBottom: 10 }}>
            <div>
              <label style={labelSt}>상품 선택</label>
              <select value={tpForm.productId} onChange={e => setTpForm(p => ({ ...p, productId: e.target.value }))}
                style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }}>
                <option value="">상품 선택...</option>
                {availableProducts.filter(p => !assignedProductIds.has(p.id)).map(p => (
                  <option key={p.id} value={p.id}>
                    {p.mainCategory ? `[${p.mainCategory}] ` : ""}{p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelSt}>단가 (원)</label>
              <input type="number" value={tpForm.unitPrice} onChange={e => setTpForm(p => ({ ...p, unitPrice: e.target.value }))}
                placeholder="단가" style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
            </div>
            <div>
              <label style={labelSt}>메모</label>
              <input value={tpForm.note} onChange={e => setTpForm(p => ({ ...p, note: e.target.value }))}
                placeholder="언어쌍 등 메모" style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
            </div>
            <PrimaryBtn onClick={handleAddProduct} disabled={addingTp || !tpForm.productId} style={{ fontSize: 12, padding: "6px 14px", whiteSpace: "nowrap", alignSelf: "flex-end" }}>
              {addingTp ? "추가 중..." : "+ 추가"}
            </PrimaryBtn>
          </div>
          {translatorProducts.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 4 }}>
              {translatorProducts.map(tp => (
                <div key={tp.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 12px", background: "#f0fdf4", borderRadius: 8, border: "1px solid #bbf7d0", fontSize: 13 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 700, color: "#065f46" }}>{tp.productName ?? "-"}</span>
                    {tp.mainCategory && <span style={{ marginLeft: 6, fontSize: 11, color: "#6b7280" }}>[{tp.mainCategory}{tp.subCategory ? ` / ${tp.subCategory}` : ""}]</span>}
                    {tp.note && <span style={{ marginLeft: 8, fontSize: 11, color: "#9ca3af" }}>{tp.note}</span>}
                  </div>
                  {editingTpId === tp.id ? (
                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      <input type="number" value={editTpPrice} onChange={e => setEditTpPrice(e.target.value)}
                        placeholder="단가" style={{ width: 90, padding: "4px 6px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12 }}
                        autoFocus onKeyDown={e => e.key === "Enter" && handleUpdateProductPrice(tp.id)} />
                      <button onClick={() => handleUpdateProductPrice(tp.id)}
                        style={{ background: "#2563eb", color: "#fff", border: "none", borderRadius: 5, padding: "4px 8px", fontSize: 11, cursor: "pointer" }}>저장</button>
                      <button onClick={() => setEditingTpId(null)}
                        style={{ background: "none", border: "1px solid #d1d5db", borderRadius: 5, padding: "4px 8px", fontSize: 11, cursor: "pointer", color: "#6b7280" }}>취소</button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span style={{ fontWeight: 700, color: tp.unitPrice ? "#059669" : "#9ca3af", minWidth: 80, textAlign: "right" }}>
                        {tp.unitPrice ? `${tp.unitPrice.toLocaleString()}원/${tp.productUnit ?? "-"}` : "단가 미설정"}
                      </span>
                      <button onClick={() => { setEditingTpId(tp.id); setEditTpPrice(tp.unitPrice ? String(tp.unitPrice) : ""); }}
                        style={{ background: "none", border: "none", color: "#2563eb", fontSize: 11, cursor: "pointer" }}>수정</button>
                    </div>
                  )}
                  <button onClick={() => handleDeleteProduct(tp.id)}
                    style={{ background: "none", border: "none", color: "#dc2626", fontSize: 13, cursor: "pointer", padding: "0 2px" }}>×</button>
                </div>
              ))}
            </div>
          ) : <p style={{ color: "#9ca3af", fontSize: 13, padding: "4px 0 8px" }}>수행 가능한 상품이 없습니다.</p>}

          {/* ── 단가 관리 ── */}
          <p style={sH}>단가 관리 ({rates.length})</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 80px 100px auto", gap: "6px 8px", alignItems: "end", marginBottom: 10 }}>
            <input value={rateForm.serviceType} onChange={e => setRateForm(p => ({ ...p, serviceType: e.target.value }))}
              placeholder="서비스 유형" style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
            <input value={rateForm.languagePair} onChange={e => setRateForm(p => ({ ...p, languagePair: e.target.value }))}
              placeholder="언어조합" style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
            <select value={rateForm.unit} onChange={e => setRateForm(p => ({ ...p, unit: e.target.value }))}
              style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }}>
              <option value="word">어절</option>
              <option value="page">페이지</option>
              <option value="hour">시간</option>
            </select>
            <input type="number" value={rateForm.rate} onChange={e => setRateForm(p => ({ ...p, rate: e.target.value }))}
              placeholder="단가(원)" style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
            <PrimaryBtn onClick={handleAddRate} disabled={addingRate} style={{ fontSize: 12, padding: "6px 12px", whiteSpace: "nowrap" }}>
              {addingRate ? "추가 중..." : "+ 추가"}
            </PrimaryBtn>
          </div>
          {rates.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 4 }}>
              {rates.map(r => (
                <div key={r.id} style={{ display: "flex", gap: 12, alignItems: "center", padding: "8px 12px", background: "#f9fafb", borderRadius: 8, border: "1px solid #f3f4f6", fontSize: 13 }}>
                  <span style={{ fontWeight: 600, color: "#374151", minWidth: 80 }}>{r.serviceType}</span>
                  <span style={{ color: "#2563eb", minWidth: 80 }}>{r.languagePair}</span>
                  <span style={{ color: "#6b7280", minWidth: 50 }}>{r.unit === "word" ? "어절" : r.unit === "page" ? "페이지" : "시간"}</span>
                  <span style={{ fontWeight: 700, color: "#059669", flex: 1 }}>{r.rate.toLocaleString()}원</span>
                  <button onClick={() => handleDeleteRate(r.id)} style={{ background: "none", border: "none", color: "#dc2626", fontSize: 12, cursor: "pointer" }}>삭제</button>
                </div>
              ))}
            </div>
          ) : <p style={{ color: "#9ca3af", fontSize: 13, padding: "6px 0" }}>등록된 단가가 없습니다.</p>}

          {/* ── 메모 ── */}
          <p style={sH}>메모 ({notes.length})</p>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="메모 입력..."
              style={{ ...inputStyle, flex: 1, fontSize: 13, padding: "7px 10px" }}
              onKeyDown={e => e.key === "Enter" && handleAddNote()} />
            <PrimaryBtn onClick={handleAddNote} disabled={addingNote || !noteText.trim()} style={{ fontSize: 13, padding: "7px 14px" }}>
              {addingNote ? "추가 중..." : "추가"}
            </PrimaryBtn>
          </div>
          {notes.length === 0 ? <p style={{ color: "#9ca3af", fontSize: 13, padding: "6px 0" }}>메모가 없습니다.</p> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {notes.map(n => (
                <div key={n.id} style={{ padding: "10px 12px", background: "#fffbeb", borderRadius: 8, border: "1px solid #fde68a" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: "#92400e", fontWeight: 600 }}>{n.adminEmail ?? "관리자"}</span>
                    <span style={{ fontSize: 11, color: "#9ca3af" }}>{new Date(n.createdAt).toLocaleString("ko-KR")}</span>
                  </div>
                  <p style={{ margin: 0, fontSize: 13, color: "#374151" }}>{n.content}</p>
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            {hasPerm("translator.sensitive") ? (
              <button
                onClick={() => setShowSensitive(true)}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 8,
                  padding: "8px 14px", fontSize: 13, fontWeight: 600, color: "#92400e",
                  cursor: "pointer",
                }}
              >
                🔒 정산 정보 관리
              </button>
            ) : <span />}
            <GhostBtn onClick={onClose} style={{ fontSize: 14, padding: "9px 20px" }}>닫기</GhostBtn>
          </div>
        </>
      )}
    </DraggableModal>

    {showSensitive && hasPerm("translator.sensitive") && (
      <SensitiveInfoModal
        userId={userId}
        userName={profile?.bio ? `${userEmail} (${profile.bio})` : userEmail}
        token={token}
        onClose={() => setShowSensitive(false)}
        onToast={onToast}
      />
    )}
    </>
  );
}
