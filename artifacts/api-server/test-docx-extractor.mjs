/**
 * DOCX 단어수 추출기 검증 스크립트
 *
 * 각 문서 유형별로 DOCX를 생성하고 extractDocx() 결과를 검증한다.
 * "예상값"은 Word 기준 (공백+슬래시 분리, w:del 제외, comments 제외).
 */

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// JSZip (DOCX 생성용)
const JSZip = require("/home/runner/workspace/node_modules/.pnpm/jszip@3.10.1/node_modules/jszip");

// 테스트 대상: 빌드된 번들에서 extractDocx 로직을 직접 실행하기 위해
// textExtractor.ts를 Node.js에서 직접 import (esbuild 번들 후)
// → 번들에는 개별 함수가 export되지 않으므로, 로컬에서 인라인 구현

// ─── DOCX 파트 패턴 및 추출 로직 (textExtractor.ts와 동일) ──────────────────

const unzipper = await import("unzipper");

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function parseWordXml(xml) {
  const out = [];
  let i = 0;
  const n = xml.length;
  const SKIP_TAGS = new Set([
    "w:instrText", "w:del", "w:rPrChange", "w:pPrChange",
    "w:sectPrChange", "w:tblPrChange",
    "mc:Fallback",   // AlternateContent 구버전 VML 대체 — mc:Choice에서 이미 수집됨
  ]);
  const PARA_CLOSE = new Set(["w:p", "w:tr", "a:p"]);

  while (i < n) {
    if (xml[i] !== "<") { i++; continue; }
    let j = i + 1;
    let inQ = false, qc = "";
    while (j < n) {
      const c = xml[j];
      if (inQ) { if (c === qc) inQ = false; }
      else if (c === '"' || c === "'") { inQ = true; qc = c; }
      else if (c === ">") break;
      j++;
    }
    if (j >= n) break;
    const inner  = xml.slice(i + 1, j);
    const isClose = inner.startsWith("/");
    const isSelf  = inner.endsWith("/");
    const tagRaw  = isClose ? inner.slice(1) : inner;
    const tagName = tagRaw.split(/[\s/]/)[0] ?? "";
    i = j + 1;
    if (!isClose && !isSelf && SKIP_TAGS.has(tagName)) {
      const close = `</${tagName}>`;
      const k = xml.indexOf(close, i);
      if (k !== -1) i = k + close.length;
      continue;
    }
    if (tagName === "w:t" && !isClose && !isSelf) {
      const k = xml.indexOf("</w:t>", i);
      if (k !== -1) { out.push(decodeXmlEntities(xml.slice(i, k))); i = k + 6; }
      continue;
    }
    if (!isClose) {
      if (tagName === "w:br" || tagName === "w:cr") { out.push(" "); continue; }
      if (tagName === "w:tab" || tagName === "a:tab") { out.push(" "); continue; }
    } else {
      if (PARA_CLOSE.has(tagName)) out.push(" ");
    }
  }
  return out.join("");
}

function calcWordCount(text) {
  const HAS_ALNUM = /[\p{L}\p{N}]/u;
  return text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[/–—]/g, " ")  // slash, en-dash, em-dash
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 0 && HAS_ALNUM.test(w))
    .length;
}

async function extractDocxBuf(buf) {
  const zip = await unzipper.Open.buffer(buf);
  const COUNT_PATTERNS = [
    { pat: /^word\/document\.xml$/i,             label: "document"  },
    { pat: /^word\/header\d+\.xml$/i,            label: "header"    },
    { pat: /^word\/footer\d+\.xml$/i,            label: "footer"    },
    { pat: /^word\/footnotes\.xml$/i,            label: "footnotes" },
    { pat: /^word\/endnotes\.xml$/i,             label: "endnotes"  },
    { pat: /^word\/drawings\/drawing\d+\.xml$/i, label: "drawing"   },
  ];
  const parts = {};
  let total = 0;
  for (const { pat, label } of COUNT_PATTERNS) {
    const matched = zip.files.filter(f => pat.test(f.path)).sort((a,b)=>a.path.localeCompare(b.path));
    for (const file of matched) {
      const xml  = (await file.buffer()).toString("utf8");
      const text = parseWordXml(xml);
      if (!text.trim()) continue;
      const wc = calcWordCount(text);
      total += wc;
      parts[file.path] = (parts[file.path] ?? 0) + wc;
    }
  }
  const fullText = (await Promise.all(
    zip.files
      .filter(f => COUNT_PATTERNS.some(({pat}) => pat.test(f.path)))
      .sort((a,b)=>a.path.localeCompare(b.path))
      .map(async f => {
        const xml = (await f.buffer()).toString("utf8");
        return parseWordXml(xml);
      })
  )).join(" ");
  const norm = fullText.replace(/[\r\n\t]+/g, " ").trim();
  return {
    wordCount: total,
    charNoSp:  norm.replace(/\s/g, "").length,
    charWithSp: norm.length,
    parts,
  };
}

// ─── DOCX 빌더 ───────────────────────────────────────────────────────────────

const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
  <Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
  <Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function makeDocRels(extras = "") {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
  ${extras}
</Relationships>`;
}

function wt(text) { return `<w:t xml:space="preserve">${text}</w:t>`; }
function wp(text) {
  return `<w:p><w:r>${wt(text)}</w:r></w:p>`;
}
function wPara(runs) {
  return `<w:p>${runs.map(r => `<w:r>${wt(r)}</w:r>`).join("")}</w:p>`;
}

function makeDoc(bodyXml, ns = "") {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:v="urn:schemas-microsoft-com:vml" ${ns}>
<w:body>${bodyXml}<w:sectPr/></w:body>
</w:document>`;
}

function makeFootnotes(footnotesXml) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
  <w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>
  ${footnotesXml}
</w:footnotes>`;
}

function makeEndnotes(endnotesXml) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:endnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote>
  <w:endnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote>
  ${endnotesXml}
</w:endnotes>`;
}

function makeHeaderFooter(xml, tag = "hdr") {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:${tag} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  ${xml}
</w:${tag}>`;
}

function makeComments(commentsXml) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  ${commentsXml}
</w:comments>`;
}

async function buildDocx(parts) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CT);
  zip.file("_rels/.rels", RELS);
  zip.file("word/_rels/document.xml.rels", makeDocRels());

  // 기본 빈 파트 (없으면 파싱 오류 가능)
  const emptyFootnotes = makeFootnotes("");
  const emptyEndnotes  = makeEndnotes("");
  const emptyHeader    = makeHeaderFooter("<w:p/>", "hdr");
  const emptyFooter    = makeHeaderFooter("<w:p/>", "ftr");
  const emptyComments  = makeComments("");

  zip.file("word/footnotes.xml", emptyFootnotes);
  zip.file("word/endnotes.xml",  emptyEndnotes);
  zip.file("word/header1.xml",   emptyHeader);
  zip.file("word/footer1.xml",   emptyFooter);
  zip.file("word/comments.xml",  emptyComments);

  for (const [name, content] of Object.entries(parts)) {
    zip.file(name, content);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

// ─── 테스트 케이스 정의 ───────────────────────────────────────────────────────

const GREEN = "\x1b[32m";
const RED   = "\x1b[31m";
const YEL   = "\x1b[33m";
const RST   = "\x1b[0m";
const BOLD  = "\x1b[1m";

function color(pct) {
  if (Math.abs(pct) <= 0.5) return GREEN;
  if (Math.abs(pct) <= 1.0) return YEL;
  return RED;
}

function check(label, got, expected, threshold = 1.0) {
  const pct = expected > 0 ? ((got - expected) / expected * 100) : 0;
  const mark = Math.abs(pct) <= threshold ? "✓" : "✗";
  const col  = color(pct);
  return `  ${col}${mark}${RST} ${label}: got=${got}, expected=${expected}, err=${col}${pct > 0 ? "+" : ""}${pct.toFixed(2)}%${RST}`;
}

const results = [];

async function runTest(name, buildFn, expected) {
  const buf = await buildFn();
  const res = await extractDocxBuf(buf);
  const wErr = expected.words > 0 ? ((res.wordCount - expected.words) / expected.words * 100) : null;
  const cErr = expected.chars > 0 ? ((res.charNoSp - expected.chars) / expected.chars * 100)  : null;
  const pass  = (wErr === null || Math.abs(wErr) <= 1.0) && (cErr === null || Math.abs(cErr) <= 1.0);

  console.log(`\n${BOLD}[${ pass ? GREEN+"PASS"+RST+BOLD : RED+"FAIL"+RST+BOLD }]${RST} ${name}`);
  if (expected.words > 0) console.log(check("Words", res.wordCount, expected.words));
  if (expected.chars > 0) console.log(check("Chars", res.charNoSp,  expected.chars));
  if (Object.keys(res.parts).length > 0) {
    console.log(`  Parts: ${Object.entries(res.parts).map(([p,w])=>`${p.split("/").pop()}=${w}`).join(", ")}`);
  }
  results.push({ name, pass, wordCount: res.wordCount, expected: expected.words, wErr });
  return res;
}

// ─── TEST 1: 일반 영문 문서 ──────────────────────────────────────────────────
// "The quick brown fox jumps over the lazy dog." → 9 words, 36 chars (no sp, period 포함)
await runTest("일반 영문 문서", async () => {
  const body = wp("The quick brown fox jumps over the lazy dog.");
  return buildDocx({ "word/document.xml": makeDoc(body) });
}, { words: 9, chars: 36 });

// ─── TEST 2: 일반 국문 문서 ──────────────────────────────────────────────────
// "안녕하세요 저는 번역가입니다 오늘은 좋은 날씨입니다" → 6 eojeol (공백 분리), 23 chars
// 안녕하세요(5)+저는(2)+번역가입니다(6)+오늘은(3)+좋은(2)+날씨입니다(5) = 23 chars
await runTest("일반 국문 문서", async () => {
  const body = wp("안녕하세요 저는 번역가입니다 오늘은 좋은 날씨입니다");
  return buildDocx({ "word/document.xml": makeDoc(body) });
}, { words: 6, chars: 23 });

// ─── TEST 3: 한영 혼합 문서 ──────────────────────────────────────────────────
// "The quick test 빠른 테스트입니다 for all types" → 8 words
// The(3)+quick(5)+test(4)+빠른(2)+테스트입니다(6)+for(3)+all(3)+types(5) = 31 chars
await runTest("한영 혼합 문서", async () => {
  const body = wp("The quick test 빠른 테스트입니다 for all types");
  return buildDocx({ "word/document.xml": makeDoc(body) });
}, { words: 8, chars: 31 });

// ─── TEST 4: 표(Table) 포함 문서 ─────────────────────────────────────────────
// 표 셀마다 텍스트: "Alpha Beta" + "Gamma Delta" + "Epsilon Zeta" + "Eta Theta" = 8 words
// Alpha(5)+Beta(4)+Gamma(5)+Delta(5)+Epsilon(7)+Zeta(4)+Eta(3)+Theta(5) = 38 chars
await runTest("표(Table) 포함", async () => {
  const tableXml = `
  <w:tbl>
    <w:tr><w:tc><w:p><w:r>${wt("Alpha Beta")}</w:r></w:p></w:tc>
           <w:tc><w:p><w:r>${wt("Gamma Delta")}</w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r>${wt("Epsilon Zeta")}</w:r></w:p></w:tc>
           <w:tc><w:p><w:r>${wt("Eta Theta")}</w:r></w:p></w:tc></w:tr>
  </w:tbl>`;
  return buildDocx({ "word/document.xml": makeDoc(tableXml) });
}, { words: 8, chars: 38 });

// ─── TEST 5: Header/Footer 포함 ──────────────────────────────────────────────
// Body: "Main content here" (3) Header: "Document Header" (2) Footer: "Page One" (2) = 7
// Main(4)+content(7)+here(4)+Document(8)+Header(6)+Page(4)+One(3) = 36 chars
await runTest("Header/Footer 포함", async () => {
  const body   = wp("Main content here");
  const header = makeHeaderFooter(wp("Document Header"), "hdr");
  const footer = makeHeaderFooter(wp("Page One"),        "ftr");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CT);
  zip.file("_rels/.rels", RELS);
  zip.file("word/_rels/document.xml.rels", makeDocRels());
  zip.file("word/document.xml", makeDoc(body));
  zip.file("word/header1.xml", header);
  zip.file("word/footer1.xml", footer);
  zip.file("word/footnotes.xml", makeFootnotes(""));
  zip.file("word/endnotes.xml",  makeEndnotes(""));
  zip.file("word/comments.xml",  makeComments(""));
  return zip.generateAsync({ type: "nodebuffer" });
}, { words: 7, chars: 36 });

// ─── TEST 6: 텍스트박스(TextBox) 포함 — mc:AlternateContent + mc:Fallback ────
// Body: "Body text words" (3) TextBox(mc:Choice): "TextBox content here" (3) = 6
await runTest("텍스트박스(TextBox) mc:Fallback", async () => {
  const textBoxXml = `
  <w:p>
    <w:r>
      <mc:AlternateContent>
        <mc:Choice Requires="wps">
          <w:drawing>
            <wp:anchor><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
              <wps:wsp><wps:txbx><w:txbxContent>
                <w:p><w:r>${wt("TextBox content here")}</w:r></w:p>
              </w:txbxContent></wps:txbx></wps:wsp>
            </a:graphicData></a:graphic></wp:anchor>
          </w:drawing>
        </mc:Choice>
        <mc:Fallback>
          <w:pict><v:rect><v:textbox><w:txbxContent>
            <w:p><w:r>${wt("TextBox content here")}</w:r></w:p>
          </w:txbxContent></v:textbox></v:rect></w:pict>
        </mc:Fallback>
      </mc:AlternateContent>
    </w:r>
  </w:p>`;
  const body = wp("Body text words") + textBoxXml;
  return buildDocx({ "word/document.xml": makeDoc(body) });
  // mc:Fallback 스킵 → mc:Choice w:txbxContent w:t만 수집 → 이중 카운트 없음
  // Body(4)+text(4)+words(5) + TextBox(7)+content(7)+here(4) = 31 chars
}, { words: 6, chars: 31 });

// ─── TEST 7: Footnote/Endnote 포함 ───────────────────────────────────────────
// Body: "See footnote below" (3) + "See endnote below" (3) = 16+15 = 31 chars
// Footnote: "This is the footnote" (4) = 17 chars
// Endnote: "This is the endnote" (4) = 16 chars
// Total: 14 words, 64 chars
await runTest("Footnote/Endnote 포함", async () => {
  const body = wp("See footnote below") + wp("See endnote below");
  const fnXml = `<w:footnote w:id="1"><w:p><w:r>${wt("This is the footnote")}</w:r></w:p></w:footnote>`;
  const enXml = `<w:endnote w:id="1"><w:p><w:r>${wt("This is the endnote")}</w:r></w:p></w:endnote>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CT);
  zip.file("_rels/.rels", RELS);
  zip.file("word/_rels/document.xml.rels", makeDocRels());
  zip.file("word/document.xml", makeDoc(body));
  zip.file("word/footnotes.xml", makeFootnotes(fnXml));
  zip.file("word/endnotes.xml",  makeEndnotes(enXml));
  zip.file("word/header1.xml",   makeHeaderFooter("<w:p/>", "hdr"));
  zip.file("word/footer1.xml",   makeHeaderFooter("<w:p/>", "ftr"));
  zip.file("word/comments.xml",  makeComments(""));
  return zip.generateAsync({ type: "nodebuffer" });
}, { words: 14, chars: 64 });

// ─── TEST 8: 변경 내용 추적(Track Changes) ────────────────────────────────────
// "Keep this text" (3 words, counted)
// deleted: "remove this text" (w:del → NOT counted)
// inserted: "insert this text" (w:ins → 3 words, counted)
// Total: 6 words, Keep(4)+this(4)+text(4)+insert(6)+this(4)+text(4) = 26 chars
await runTest("Track Changes (w:del 제외, w:ins 포함)", async () => {
  const tcXml = `<w:p>
    <w:r>${wt("Keep this text ")}</w:r>
    <w:del w:id="1"><w:r><w:delText>remove this text </w:delText></w:r></w:del>
    <w:ins w:id="2"><w:r>${wt("insert this text")}</w:r></w:ins>
  </w:p>`;
  return buildDocx({ "word/document.xml": makeDoc(tcXml) });
}, { words: 6, chars: 26 });

// ─── TEST 9: Comments 포함 ───────────────────────────────────────────────────
// Body: "This text has comments" (4 words, counted)
// Comment: "reviewer note here" (NOT counted — word/comments.xml 파트 제외)
// This(4)+text(4)+has(3)+comments(8) = 19 chars
await runTest("Comments 포함 (comment 텍스트 제외)", async () => {
  const body = wp("This text has comments");
  const commentXml = `<w:comment w:id="1" w:author="Reviewer">
    <w:p><w:r>${wt("reviewer note here")}</w:r></w:p>
  </w:comment>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CT);
  zip.file("_rels/.rels", RELS);
  zip.file("word/_rels/document.xml.rels", makeDocRels());
  zip.file("word/document.xml", makeDoc(body));
  zip.file("word/footnotes.xml", makeFootnotes(""));
  zip.file("word/endnotes.xml",  makeEndnotes(""));
  zip.file("word/header1.xml",   makeHeaderFooter("<w:p/>", "hdr"));
  zip.file("word/footer1.xml",   makeHeaderFooter("<w:p/>", "ftr"));
  zip.file("word/comments.xml",  makeComments(commentXml));
  return zip.generateAsync({ type: "nodebuffer" });
}, { words: 4, chars: 19 });

// ─── TEST 10: 슬래시 분리 검증 ───────────────────────────────────────────────
// "The dose/response ratio is 0.5 mg/kg/day for male/female subjects"
// slash-split: dose+response, mg+kg+day, male+female → 13 words
// chars (no sp, slash 포함): The(3)+dose/response(13)+ratio(5)+is(2)+0.5(3)+mg/kg/day(9)+for(3)+male/female(11)+subjects(8) = 57
await runTest("슬래시 단어 구분 검증", async () => {
  const body = wp("The dose/response ratio is 0.5 mg/kg/day for male/female subjects");
  return buildDocx({ "word/document.xml": makeDoc(body) });
}, { words: 13, chars: 57 });

// ─── TEST 11: 하이픈 단어 내부 검증 ─────────────────────────────────────────
// "state-of-the-art pre-clinical non-GLP studies" → 4 words (space-split)
// state-of-the-art(16)+pre-clinical(12)+non-GLP(7)+studies(7) = 42 chars
await runTest("하이픈 단어 내부 검증", async () => {
  const body = wp("state-of-the-art pre-clinical non-GLP studies");
  return buildDocx({ "word/document.xml": makeDoc(body) });
}, { words: 4, chars: 42 });

// ─── TEST 12: 복합 문서 (Body + Header + Footer + Footnote) ──────────────────
// Body: 10 words (47 chars), Header: 3 words (15 chars), Footer: 2 words (10 chars), Footnote: 5 words (29 chars) = 20 words, 101 chars
await runTest("복합 구조 (Body+Header+Footer+Footnote)", async () => {
  const body   = wp("Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa");
  const header = makeHeaderFooter(wp("Header Title Here"), "hdr");
  const footer = makeHeaderFooter(wp("Footer text"), "ftr");
  const fnXml  = `<w:footnote w:id="1"><w:p><w:r>${wt("Footnote content words here today")}</w:r></w:p></w:footnote>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CT);
  zip.file("_rels/.rels", RELS);
  zip.file("word/_rels/document.xml.rels", makeDocRels());
  zip.file("word/document.xml", makeDoc(body));
  zip.file("word/header1.xml", header);
  zip.file("word/footer1.xml", footer);
  zip.file("word/footnotes.xml", makeFootnotes(fnXml));
  zip.file("word/endnotes.xml",  makeEndnotes(""));
  zip.file("word/comments.xml",  makeComments(""));
  return zip.generateAsync({ type: "nodebuffer" });
}, { words: 20, chars: 101 });

// ─── TEST 13: 대용량 문서 시뮬레이션 ─────────────────────────────────────────
// 100단락 × 20단어 = 2,000 words
// 단락당 chars: Alpha(5)+Beta(4)+Gamma(5)+Delta(5)+Epsilon(7)+Zeta(4)+Eta(3)+Theta(5)+Iota(4)+Kappa(5)+Lambda(6)+Mu(2)+Nu(2)+Xi(2)+Omicron(7)+Pi(2)+Rho(3)+Sigma(5)+Tau(3)+Upsilon(7) = 86 chars
// 총 chars: 86 × 100 = 8,600
await runTest("대용량 문서 (2,000 words)", async () => {
  const para = "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho Sigma Tau Upsilon";
  const paragraphs = Array.from({ length: 100 }, () => wp(para)).join("\n");
  return buildDocx({ "word/document.xml": makeDoc(paragraphs) });
}, { words: 2000, chars: 86 * 100 });

// ─── 결과 요약 ───────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(70)}`);
console.log(`${BOLD}DOCX 추출기 검증 결과 요약${RST}`);
console.log("═".repeat(70));

const headers = ["#", "테스트", "예상", "실제", "오차%", "판정"];
const rows = results.map((r, i) => [
  String(i + 1).padStart(2),
  r.name.slice(0, 30).padEnd(30),
  r.expected > 0 ? String(r.expected).padStart(6) : "  N/A ",
  String(r.wordCount).padStart(6),
  r.wErr != null ? (r.wErr > 0 ? "+" : "") + r.wErr.toFixed(2) + "%" : "  N/A",
  r.pass ? `${GREEN}PASS${RST}` : `${RED}FAIL${RST}`,
]);

console.log(rows.map(r => r.join(" │ ")).join("\n"));
console.log("═".repeat(70));
const passed = results.filter(r => r.pass).length;
const total  = results.length;
console.log(`${BOLD}통과: ${passed}/${total}${RST} (${(passed/total*100).toFixed(0)}%)`);
