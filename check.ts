// Citation checker: does the source an AI answer cites actually support the claim?
//
//   npx tsx check.ts run       check every saved answer (safe to re-run; progress is cached)
//   npx tsx check.ts summary   print result tables
//   npx tsx check.ts sample 60 draw a blind random sample to label by hand -> gold.csv
//   npx tsx check.ts score     compare your labels in gold.csv with the checker
//
// Options: --judge gemini|baseline   --limit N   --only <model>   --retry-failed
// No dependencies beyond Node 18+.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------- config ----------

loadEnv();
const args = process.argv.slice(2);
const cmd = args[0] ?? "help";
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const JUDGE = flag("judge") ?? process.env.JUDGE ?? "gemini"; // "gemini" or "baseline"
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? "";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "";
const GEMINI_BASE = process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_RPM = Number(process.env.GEMINI_RPM ?? 8); // stay under the free-tier per-minute limit
const MAX_CLAIMS = 15; // per answer, in order of appearance
const EXCERPT_BUDGET = 6000; // minimum characters of page text sent per source (grows with the number of claims)
const MAX_PAGE_CHARS = 3000000; // very long reports are cut here
const CALL_BUDGET = 60000; // characters of page text per judge call
const SEED = Number(process.env.SEED ?? 42);
const RETRY_FAILED = args.includes("--retry-failed"); // fetch again pages that failed or were refused last time
const RETRYABLE = /^(fetch_error|timeout|http_(401|403|406|429|5\d\d)|judge_gave)/;
const USER_AGENT =
  process.env.USER_AGENT ??
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

type Verdict = "supported" | "partial" | "unsupported" | "unchecked" | "uncited";
type Question = { id: string; area: string; scope: string; question: string };
type Answer = { model: string; qid: string; text: string };
type Claim = { claim: string; urls: string[] };
type Source = { url: string; status: string; fetched_at: string; sha256: string; text: string };
type Row = {
  row_id: string; judge: string; model: string; question_id: string; area: string; scope: string;
  claim: string; source_url: string; verdict: Verdict; evidence: string; evidence_verified: boolean;
  note: string; fetch_status: string; source_sha256: string; fetched_at: string;
};

// ---------- small helpers ----------

function loadEnv() {
  if (!fs.existsSync(".env")) return;
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ensureDir = (d: string) => fs.mkdirSync(d, { recursive: true });
const readJson = (f: string) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : undefined);
const writeJson = (f: string, v: unknown) => { ensureDir(path.dirname(f)); fs.writeFileSync(f, JSON.stringify(v, null, 1)); };
const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ""])));
}
const csvCell = (s: string) => `"${String(s).replace(/"/g, '""')}"`;

function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n), h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}
const pct = (x: number) => `${(100 * x).toFixed(0)}%`;

function rng(seed: number) { // mulberry32: small seeded generator so samples are reproducible
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- inputs ----------

function loadQuestions(): Map<string, Question> {
  const rows = parseCsv(fs.readFileSync("questions.csv", "utf8"));
  return new Map(rows.map((r) => [r.id, { id: r.id, area: r.area, scope: r.scope, question: r.question }]));
}

// Accepts answers/<model>/<ID>.md (or .txt), or one file answers/<model>.md with "## <ID>" lines.
function loadAnswers(questions: Map<string, Question>): Answer[] {
  const out: Answer[] = [];
  if (!fs.existsSync("answers")) return out;
  const add = (model: string, qid: string, text: string) => {
    if (!questions.has(qid)) return console.warn(`  skipped ${model}/${qid}: not in questions.csv`);
    // copied answers escape characters such as "&" as "\&", which breaks links
    text = text.replace(/\\([&_~#%=+\-.!()[\]*])/g, "$1").trim();
    // drop embedded pictures: they are illustrations, not cited sources
    text = text.replace(/^\s*!?\[[^\]]*\]\(https?:\/\/images\.openai\.com\/[^)]*\)\s*$/gm, "").trim();
    if (text) out.push({ model, qid, text });
  };
  for (const entry of fs.readdirSync("answers").sort()) {
    const p = path.join("answers", entry);
    if (fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p).sort())
        if (/\.(md|txt)$/i.test(f)) add(entry, f.replace(/\.(md|txt)$/i, "").toUpperCase(), fs.readFileSync(path.join(p, f), "utf8"));
    } else if (/\.(md|txt)$/i.test(entry)) {
      const model = entry.replace(/\.(md|txt)$/i, "");
      const parts = fs.readFileSync(p, "utf8").split(/^\s*\**\s*#{1,6}\s*\**\s*([A-Za-z]\d+-(?:NG|GL))\b.*$/m);
      for (let i = 1; i < parts.length; i += 2) add(model, parts[i].toUpperCase(), parts[i + 1] ?? "");
    }
  }
  return out;
}

const cleanUrl = (u: string) => u.replace(/[.,;:!?)\]}>'"*]+$/, "");
const isPicture = (u: string) => /images\.openai\.com|\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(u); // illustrations, not sources
const extractUrls = (text: string) => [...new Set((text.match(/https?:\/\/[^\s<>"'`\])]+/g) ?? []).map(cleanUrl))].filter((u) => !isPicture(u));
// The address actually fetched: no #fragment and no utm_ tracking parameters.
const fetchUrl = (u: string) => cleanUrl(u).replace(/#.*$/, "").replace(/([?&])utm_[^&]*&?/gi, "$1").replace(/[?&]$/, "");
const urlKey = (u: string) => fetchUrl(u).replace(/\/$/, "").toLowerCase();

// ---------- Gemini ----------

let lastCall = 0;
async function gemini(prompt: string): Promise<any> {
  if (!GEMINI_KEY || !GEMINI_MODEL) throw new Error("Set GEMINI_API_KEY and GEMINI_MODEL in .env (see .env.example).");
  let lastError = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    const wait = lastCall + 60000 / GEMINI_RPM - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    let res: Response;
    try {
      res = await fetch(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        }),
      });
    } catch (e: any) { lastError = `network (${e?.cause?.code ?? e?.name})`; await sleep(5000 * (attempt + 1)); continue; }
    if (res.status === 429 || res.status >= 500) {
      const body = await res.text();
      lastError = `${res.status}: ${(body.match(/"message":\s*"([^"]{0,220})/)?.[1] ?? body.slice(0, 220)).replace(/\\n/g, " ")}`;
      // Gemini says how long to wait; use that, otherwise back off
      const asked = Number(body.match(/retry in ([\d.]+)\s*s/i)?.[1] ?? body.match(/"retryDelay":\s*"([\d.]+)s"/)?.[1] ?? 0);
      if (asked > 300) // a wait this long means the daily allowance is used up
        throw new Error(`Gemini's daily allowance for ${GEMINI_MODEL} is used up (resets in about ${(asked / 3600).toFixed(1)} hours). Progress is saved.\nSwitch GEMINI_MODEL in .env to another model, or run the same command again after the reset.\n${lastError}`);
      const delay = Math.min(120000, asked ? asked * 1000 + 2000 : 20000 * (attempt + 1));
      console.warn(`  Gemini ${res.status}, waiting ${Math.round(delay / 1000)}s`);
      await sleep(delay);
      continue;
    }
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data: any = await res.json();
    const text: string = (data.candidates?.[0]?.content?.parts ?? []).filter((p: any) => !p.thought).map((p: any) => p.text ?? "").join("");
    try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")); }
    catch { console.warn("  Gemini returned invalid JSON, retrying"); }
  }
  throw new Error(`Gemini kept refusing requests. Progress is saved; run the same command again.\nLast error: ${lastError || "network"}`);
}

// ---------- step 1: claims ----------

async function getClaims(a: Answer, q: Question): Promise<Claim[]> {
  const file = `cache/claims/${a.model}__${a.qid}.json`;
  const cached = readJson(file);
  if (cached && cached.answer_sha256 === sha(a.text)) return cached.claims;
  const known = new Map(extractUrls(a.text).map((u) => [urlKey(u), u]));
  let claims: Claim[];
  if (JUDGE === "baseline") claims = heuristicClaims(a.text);
  else {
    const out = await gemini(
      `You split an AI assistant's answer into factual claims and attach the sources cited for each claim.

Rules:
- A claim is one checkable factual statement, rewritten so it stands alone: name the subject and place, keep every number, date and name.
- Skip greetings, advice, opinions and closing summaries that repeat earlier claims.
- "urls" lists the URLs the answer cites for that claim, copied exactly. A citation covers the sentence or bullet it is attached to. A "Source:" line placed after a paragraph, table or section covers the claims in that block. If the answer uses markers like [1] with a numbered source list, map them. If nothing is cited for a claim, use [].
- Never invent or change a URL.
- Go in order of appearance and stop after ${MAX_CLAIMS} claims.

Return JSON: {"claims":[{"claim":"...","urls":["..."]}]}

QUESTION: ${q.question}

ANSWER:
${a.text}`);
    claims = Array.isArray(out?.claims) ? out.claims : [];
  }
  claims = claims
    .filter((c) => c && typeof c.claim === "string" && c.claim.trim())
    .slice(0, MAX_CLAIMS)
    .map((c) => ({
      claim: c.claim.trim(),
      // keep only URLs that really appear in the answer
      urls: [...new Set((c.urls ?? []).map((u) => known.get(urlKey(String(u)))).filter(Boolean) as string[])],
    }));
  if (JUDGE !== "baseline" && claims.length) writeJson(file, { answer_sha256: sha(a.text), claims }); // an empty result is not saved, so it is tried again next run
  return claims;
}

// Fallback used only when no model is available: one claim per sentence or bullet.
function heuristicClaims(text: string): Claim[] {
  return text.split(/\n+|(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => ({ urls: extractUrls(s), claim: s.replace(/\[([^\]]*)\]\(https?:[^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, "").replace(/[#*_>`()[\]]/g, "").replace(/\s+/g, " ").trim() }))
    .filter((c) => c.claim.length > 30);
}

// ---------- step 2: sources ----------

function htmlToText(html: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: "..." };
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|section|article|header|footer|blockquote|pre)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => entities[n.toLowerCase()] ?? m)
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n\s*/g, "\n")
    .trim();
}

// PDFs are read with the pdftotext command (poppler-utils). Returns null if it is not installed.
function pdfToText(buf: Buffer): string | null {
  const tmp = path.join(os.tmpdir(), `citation-checker-${process.pid}-${Date.now()}.pdf`);
  fs.writeFileSync(tmp, buf);
  try {
    return execFileSync("pdftotext", ["-enc", "UTF-8", tmp, "-"], { maxBuffer: 256 * 1024 * 1024, timeout: 90000, stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8").replace(/[ \t\f]+/g, " ").replace(/ *\n\s*/g, "\n").trim();
  } catch (e: any) {
    return e?.code === "ENOENT" ? null : "";
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

type Fetched = { status: number; type: string; buf: Buffer } | { error: string };
const BROWSER_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5",
  "Accept-Language": "en-US,en;q=0.9",
};

async function fetchWithNode(url: string): Promise<Fetched> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow", signal: AbortSignal.timeout(45000) });
      const tooBig = Number(res.headers.get("content-length") ?? 0) > 40 * 1024 * 1024;
      return { status: tooBig ? 413 : res.status, type: res.headers.get("content-type") ?? "", buf: res.ok && !tooBig ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0) };
    } catch (e: any) {
      if (attempt === 1) return { error: e?.name === "TimeoutError" ? "timeout" : `fetch_error (${e?.cause?.code ?? e?.name ?? "unknown"})` };
      await sleep(3000); // one retry for a flaky connection
    }
  }
  return { error: "fetch_error (unknown)" };
}

// Second attempt with the curl command. Some sites refuse Node but accept curl.
function fetchWithCurl(url: string): Fetched | null {
  const tmp = path.join(os.tmpdir(), `citation-checker-${process.pid}-${Date.now()}.bin`);
  try {
    const meta = execFileSync("curl", ["-sL", "--compressed", "--max-time", "45", "--max-filesize", "41943040", "-A", USER_AGENT,
      "-H", `Accept: ${BROWSER_HEADERS.Accept}`, "-H", "Accept-Language: en-US,en;q=0.9", "-o", tmp, "-w", "%{http_code}\t%{content_type}", url],
      { timeout: 60000, stdio: ["ignore", "pipe", "ignore"] }).toString();
    const [code, type] = meta.split("\t");
    return { status: Number(code), type: type ?? "", buf: fs.existsSync(tmp) ? fs.readFileSync(tmp) : Buffer.alloc(0) };
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function getSource(url: string): Promise<Source> {
  const file = `cache/sources/${sha(urlKey(url)).slice(0, 24)}.json`;
  const cached = readJson(file);
  // pages saved by an older version were cut at 400,000 characters; fetch those again
  if (cached && cached.text?.length !== 400000 && !(RETRY_FAILED && RETRYABLE.test(cached.status))) return cached;
  const src: Source = { url, status: "ok", fetched_at: new Date().toISOString(), sha256: "", text: "" };
  let got = await fetchWithNode(fetchUrl(url));
  if ("error" in got || [401, 403, 406, 429, 503].includes(got.status)) {
    const second = fetchWithCurl(fetchUrl(url));
    if (second && "status" in second && second.status >= 200 && second.status < 300) got = second;
  }
  if ("error" in got) src.status = got.error;
  else if (got.status === 413) src.status = "too_large";
  else if (got.status < 200 || got.status >= 300) src.status = `http_${got.status}`;
  else if (got.buf.subarray(0, 5).toString("latin1") === "%PDF-") {
    const text = pdfToText(got.buf);
    if (text === null) src.status = "pdf_needs_pdftotext";
    else src.text = text;
  } else if (/html|text\/plain|xml/i.test(got.type) || !got.type) {
    const raw = got.buf.toString("utf8");
    src.text = /text\/plain/i.test(got.type) ? raw : htmlToText(raw);
  } else src.status = `not_text (${got.type.split(";")[0]})`;
  src.text = src.text.slice(0, MAX_PAGE_CHARS);
  if (src.status === "ok" && src.text.length < 300) src.status = "too_little_text";
  if (src.status !== "ok") src.text = "";
  src.sha256 = src.text ? sha(src.text) : "";
  writeJson(file, src);
  return src;
}

// ---------- step 3: pick the parts of the page that matter ----------

const STOP = new Set("the and for are was were that this with from have has had not but its their they them than then also such can may will would should could been being into over under about between more most other some any each which what when where who how why per via out all one two use used using".split(" "));
const tokens = (s: string) => [...new Set(norm(s).match(/[a-z]{3,}|\d[\d.,]*\d|\d/g) ?? [])].filter((t) => !STOP.has(t));

function chunkText(text: string, size = 700): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const para of text.split("\n")) {
    for (const piece of para.length > size ? para.match(new RegExp(`[\\s\\S]{1,${size}}(?:\\s|$)`, "g")) ?? [para] : [para]) {
      if (cur && cur.length + piece.length > size) { chunks.push(cur.trim()); cur = ""; }
      cur += piece + "\n";
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

// Score every chunk against a claim: rarer words count more, numbers count double.
function rankChunks(chunks: string[], chunkTokens: Set<string>[], claim: string): { i: number; score: number }[] {
  const n = chunks.length;
  const weights = tokens(claim).map((t) => {
    const df = chunkTokens.filter((s) => s.has(t)).length;
    return { t, w: Math.log(1 + n / (1 + df)) * (/\d/.test(t) ? 2 : 1) };
  });
  const total = weights.reduce((a, b) => a + b.w, 0) || 1;
  return chunkTokens
    .map((s, i) => ({ i, score: weights.reduce((a, b) => a + (s.has(b.t) ? b.w : 0), 0) / total }))
    .sort((a, b) => b.score - a.score);
}

function excerptsFor(text: string, claims: string[]): string {
  const budget = Math.min(24000, Math.max(EXCERPT_BUDGET, claims.length * 1600)); // room for about two passages per claim
  if (text.length <= budget) return text;
  const chunks = chunkText(text);
  const chunkTokens = chunks.map((c) => new Set(tokens(c)));
  const perClaim = claims.map((c) => rankChunks(chunks, chunkTokens, c).slice(0, 4));
  const picked = new Set<number>();
  let used = 0;
  for (let rank = 0; rank < 4; rank++) // best chunk for every claim first, then second best, ...
    for (const list of perClaim) {
      const hit = list[rank];
      if (!hit || picked.has(hit.i) || used + chunks[hit.i].length > budget) continue;
      picked.add(hit.i); used += chunks[hit.i].length;
    }
  return [...picked].sort((a, b) => a - b).map((i) => chunks[i]).join("\n[...]\n");
}

// ---------- step 4: judge ----------

type Pair = { id: string; claim: string; url: string; src: Source };
type Judged = { verdict: Verdict; evidence: string; note: string };

async function judgeWithGemini(pairs: Pair[], question: string): Promise<Map<string, Judged>> {
  const out = new Map<string, Judged>();
  const bySource = new Map<string, Pair[]>();
  for (const p of pairs) bySource.set(p.url, [...(bySource.get(p.url) ?? []), p]);
  // group sources into calls that stay under the size budget
  const calls: { url: string; excerpt: string; pairs: Pair[] }[][] = [[]];
  let size = 0;
  for (const [url, ps] of bySource) {
    const excerpt = excerptsFor(ps[0].src.text, ps.map((p) => p.claim));
    if (size + excerpt.length > CALL_BUDGET && calls[calls.length - 1].length) { calls.push([]); size = 0; }
    calls[calls.length - 1].push({ url, excerpt, pairs: ps });
    size += excerpt.length;
  }
  for (const call of calls) {
    if (!call.length) continue;
    const sources = call.map((s, i) => `=== SOURCE s${i + 1}: ${s.url} ===\n${s.excerpt}`).join("\n\n");
    const claims = call.flatMap((s, i) => s.pairs.map((p) => `${p.id} (source s${i + 1}): ${p.claim}`)).join("\n");
    const res = await gemini(
      `You check whether web pages support claims made by an AI assistant.

For each claim, use ONLY the excerpts of its own cited source below. Do not use outside knowledge or the other sources.

Verdicts:
- "supported": the excerpts state the claim, including its specific details (numbers, dates, names).
- "partial": the excerpts back the main point, but a specific detail is missing, different, or weaker than the claim. Also use "partial" when the excerpts state the substance for a broader or different scope than the claim (for example Africa or "farmers" in general, where the claim says Nigeria).
- "unsupported": the excerpts do not state the substance of the claim, or contradict it. A page on the right topic that never says it is unsupported. A claim that is true but absent from the excerpts is unsupported.

The claims were rewritten to stand alone, so a country, organisation or programme name may have been added from the question. Do not mark a claim unsupported only because the excerpts do not repeat that name, when the source is plainly about it (for example an official page of that country or organisation).
Wording does not need to match: a clear paraphrase counts as stated.

"evidence": for "supported" and "partial", an exact quote copied character for character from the excerpts, at most 300 characters. For "unsupported", "".
"why": for "unsupported" only, one of:
  "not_stated" (the page has real content but does not say this),
  "contradicted" (the page says something different),
  "landing_page" (the page is only an index, abstract, summary or download link, and the content itself is not on it).
  For other verdicts, "".
"note": one short sentence. For "partial", say which detail is missing or different.

Return JSON: {"verdicts":[{"id":"c1","verdict":"supported","evidence":"...","why":"","note":"..."}]} with exactly one entry per claim id.

QUESTION THE ASSISTANT WAS ANSWERING: ${question}

${sources}

=== CLAIMS ===
${claims}`);
    for (const v of Array.isArray(res?.verdicts) ? res.verdicts : [])
      if (["supported", "partial", "unsupported"].includes(v?.verdict))
        out.set(String(v.id), { verdict: v.verdict, evidence: String(v.evidence ?? ""), note: (v.verdict === "unsupported" && /^(not_stated|contradicted|landing_page)$/.test(v.why ?? "") ? `[${v.why}] ` : "") + String(v.note ?? "") });
  }
  return out;
}

// Keyword baseline: no model. Used to show what the model judge adds.
function judgeWithBaseline(pairs: Pair[]): Map<string, Judged> {
  const out = new Map<string, Judged>();
  for (const p of pairs) {
    const chunks = chunkText(p.src.text);
    const best = rankChunks(chunks, chunks.map((c) => new Set(tokens(c))), p.claim)[0];
    const chunk = best ? chunks[best.i] : "";
    const numbers = tokens(p.claim).filter((t) => /\d/.test(t));
    const numbersFound = numbers.every((n) => norm(chunk).includes(n));
    const score = best?.score ?? 0;
    const verdict: Verdict = score >= 0.75 && numbersFound ? "supported" : score >= 0.5 ? "partial" : "unsupported";
    out.set(p.id, { verdict, evidence: verdict === "unsupported" ? "" : chunk.slice(0, 300), note: `keyword overlap ${score.toFixed(2)}` });
  }
  return out;
}

// ---------- run ----------

async function checkAnswer(a: Answer, q: Question): Promise<Row[]> {
  const file = `cache/verdicts/${JUDGE}/${a.model}__${a.qid}.json`;
  const cached = readJson(file);
  if (cached && cached.answer_sha256 === sha(a.text) && !(RETRY_FAILED && cached.rows.some((r: Row) => RETRYABLE.test(r.fetch_status)))) return cached.rows;

  if (!extractUrls(a.text).length) console.warn(`  ${a.model}/${a.qid}: no links found in the saved answer. Check how it was copied.`);
  const claims = await getClaims(a, q);
  const urls = [...new Set(claims.flatMap((c) => c.urls))];
  const sources = new Map<string, Source>();
  for (let i = 0; i < urls.length; i += 5) // fetch five pages at a time
    await Promise.all(urls.slice(i, i + 5).map(async (u) => sources.set(u, await getSource(u))));

  const base = { judge: JUDGE, model: a.model, question_id: a.qid, area: q.area, scope: q.scope };
  const rowId = (claim: string, url: string) => sha([a.model, a.qid, claim, url].join("|")).slice(0, 10);
  const rows: Row[] = [];
  const pairs: Pair[] = [];
  for (const c of claims) {
    if (!c.urls.length) {
      rows.push({ ...base, row_id: rowId(c.claim, ""), claim: c.claim, source_url: "", verdict: "uncited", evidence: "", evidence_verified: false, note: "", fetch_status: "", source_sha256: "", fetched_at: "" });
      continue;
    }
    for (const url of c.urls) {
      const src = sources.get(url)!;
      const row: Row = { ...base, row_id: rowId(c.claim, url), claim: c.claim, source_url: url, verdict: "unchecked", evidence: "", evidence_verified: false, note: "", fetch_status: src.status, source_sha256: src.sha256, fetched_at: src.fetched_at };
      rows.push(row);
      if (src.status === "ok") pairs.push({ id: `c${pairs.length + 1}`, claim: c.claim, url, src });
    }
  }
  const judged = JUDGE === "baseline" ? judgeWithBaseline(pairs) : await judgeWithGemini(pairs, q.question);
  for (const p of pairs) {
    const row = rows.find((r) => r.claim === p.claim && r.source_url === p.url)!;
    const j = judged.get(p.id);
    if (!j) { row.fetch_status = "judge_gave_no_answer"; continue; }
    row.verdict = j.verdict; row.evidence = j.evidence; row.note = j.note;
    // the quote must really be on the page, otherwise it is flagged
    row.evidence_verified = !!j.evidence && norm(p.src.text).includes(norm(j.evidence));
  }
  if (rows.length) writeJson(file, { answer_sha256: sha(a.text), rows });
  else console.warn(`  ${a.model}/${a.qid}: no claims were extracted; it will be tried again next run.`);
  return rows;
}

async function run() {
  const questions = loadQuestions();
  let answers = loadAnswers(questions);
  if (flag("only")) answers = answers.filter((a) => a.model === flag("only"));
  if (flag("limit")) answers = answers.slice(0, Number(flag("limit")));
  if (!answers.length) return console.log("No answers found. Save them as answers/<model>/<ID>.md (for example answers/chatgpt/F1-NG.md).");
  console.log(`Checking ${answers.length} answers with judge "${JUDGE}"${JUDGE === "gemini" ? ` (${GEMINI_MODEL})` : ""}`);
  const all: Row[] = [];
  for (const [i, a] of answers.entries()) {
    const rows = await checkAnswer(a, questions.get(a.qid)!);
    all.push(...rows);
    const count = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
    console.log(`[${i + 1}/${answers.length}] ${a.model}/${a.qid}: ${count("supported")} supported, ${count("partial")} partial, ${count("unsupported")} unsupported, ${count("unchecked")} unchecked, ${count("uncited")} uncited`);
    saveResults(all);
  }
  console.log(`\nSaved results/results.${JUDGE}.jsonl and .csv. Next: npx tsx check.ts summary`);
}

const COLS: (keyof Row)[] = ["row_id", "judge", "model", "question_id", "area", "scope", "claim", "source_url", "verdict", "evidence", "evidence_verified", "note", "fetch_status", "source_sha256", "fetched_at"];
function saveResults(rows: Row[]) {
  ensureDir("results");
  fs.writeFileSync(`results/results.${JUDGE}.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(`results/results.${JUDGE}.csv`, [COLS.join(","), ...rows.map((r) => COLS.map((c) => csvCell(String(r[c]))).join(","))].join("\n") + "\n");
}
function loadResults(judge = JUDGE): Row[] {
  const f = `results/results.${judge}.jsonl`;
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l: string) => JSON.parse(l) as Row);
}

// ---------- summary ----------

function table(title: string, rows: Row[], key: (r: Row) => string): string {
  const groups = new Map<string, Row[]>();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  const lines = [`### ${title}`, "", "| Group | Claims | Uncited | Citations | Unchecked | Checked | Supported | Partial | Unsupported | Unsupported 95% range |", "|---|---|---|---|---|---|---|---|---|---|"];
  for (const [g, rs] of [...groups].sort()) {
    const n = (v: Verdict) => rs.filter((r) => r.verdict === v).length;
    const cited = rs.filter((r) => r.verdict !== "uncited");
    const checked = n("supported") + n("partial") + n("unsupported");
    const share = (k: number) => (checked ? `${k} (${pct(k / checked)})` : "0");
    const [lo, hi] = wilson(n("unsupported"), checked);
    const claims = new Set(rs.map((r) => `${r.model}|${r.question_id}|${r.claim}`)).size;
    lines.push(`| ${g} | ${claims} | ${n("uncited")} | ${cited.length} | ${n("unchecked")} | ${checked} | ${share(n("supported"))} | ${share(n("partial"))} | ${share(n("unsupported"))} | ${checked ? `${pct(lo)} to ${pct(hi)}` : "n/a"} |`);
  }
  return lines.join("\n");
}

// A claim can cite several sources. At claim level it counts by its best citation:
// supported if any cited source supports it, unsupported only if every readable one fails.
function claimTable(title: string, rows: Row[], key: (r: Row) => string): string {
  const rank: Record<string, number> = { supported: 3, partial: 2, unsupported: 1, unchecked: 0 };
  const claims = new Map<string, { group: string; best: Verdict }>();
  for (const r of rows) {
    if (r.verdict === "uncited") continue;
    const id = `${r.model}|${r.question_id}|${r.claim}`;
    const cur = claims.get(id);
    if (!cur || rank[r.verdict] > rank[cur.best]) claims.set(id, { group: key(r), best: r.verdict });
  }
  const groups = new Map<string, Verdict[]>();
  for (const c of claims.values()) groups.set(c.group, [...(groups.get(c.group) ?? []), c.best]);
  const lines = [`### ${title}`, "", "| Group | Cited claims | Unchecked | Checked | Supported | Partial | Unsupported | Unsupported 95% range |", "|---|---|---|---|---|---|---|---|"];
  for (const [g, vs] of [...groups].sort()) {
    const n = (v: Verdict) => vs.filter((x) => x === v).length;
    const checked = n("supported") + n("partial") + n("unsupported");
    const share = (k: number) => (checked ? `${k} (${pct(k / checked)})` : "0");
    const [lo, hi] = wilson(n("unsupported"), checked);
    lines.push(`| ${g} | ${vs.length} | ${n("unchecked")} | ${checked} | ${share(n("supported"))} | ${share(n("partial"))} | ${share(n("unsupported"))} | ${checked ? `${pct(lo)} to ${pct(hi)}` : "n/a"} |`);
  }
  return lines.join("\n");
}

function summary() {
  const rows = loadResults();
  if (!rows.length) return console.log(`No results for judge "${JUDGE}". Run: npx tsx check.ts run`);
  const unverified = rows.filter((r) => (r.verdict === "supported" || r.verdict === "partial") && !r.evidence_verified).length;
  const reasons = new Map<string, number>();
  for (const r of rows.filter((r) => r.verdict === "unchecked")) reasons.set(r.fetch_status, (reasons.get(r.fetch_status) ?? 0) + 1);
  const out = [
    `# Results (judge: ${JUDGE})`, "",
    "Percentages are of checked citations. Unchecked means the page could not be read, and is never counted as unsupported.", "",
    "## Claim level (headline)", "",
    "Each claim counts once, by its best citation.", "",
    claimTable("By model", rows, (r) => r.model), "",
    claimTable("By scope", rows, (r) => r.scope), "",
    claimTable("By model and scope", rows, (r) => `${r.model} / ${r.scope}`), "",
    claimTable("By area", rows, (r) => r.area), "",
    "## Citation level", "",
    "Each claim-source pair counts separately.", "",
    table("By model", rows, (r) => r.model), "",
    table("By scope", rows, (r) => r.scope), "",
    table("By model and scope", rows, (r) => `${r.model} / ${r.scope}`), "",
    table("By area", rows, (r) => r.area), "",
    "### Why pages were unchecked", "",
    ...[...reasons].sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`), "",
    "### Why citations were unsupported", "",
    ...["not_stated", "contradicted", "landing_page", "no reason given"].map((w) => `- ${w}: ${rows.filter((r) => r.verdict === "unsupported" && (w === "no reason given" ? !/^\[(not_stated|contradicted|landing_page)\]/.test(r.note) : r.note.startsWith(`[${w}]`))).length}`), "",
    `Quotes the judge gave that were not found on the page: ${unverified}`, "",
  ].join("\n");
  fs.writeFileSync(`results/summary.${JUDGE}.md`, out);
  console.log(out);
}

// ---------- gold set ----------

function sample() {
  const n = Number(args[1] ?? 60);
  if (fs.existsSync("gold.csv")) return console.log("gold.csv already exists. Move or delete it first so labels are never overwritten.");
  const rows = loadResults().filter((r) => ["supported", "partial", "unsupported"].includes(r.verdict));
  if (!rows.length) return console.log("No checked citations yet. Run the checker first.");
  const rand = rng(SEED);
  const strata = new Map<string, Row[]>();
  for (const r of rows) strata.set(`${r.model}|${r.scope}`, [...(strata.get(`${r.model}|${r.scope}`) ?? []), r]);
  for (const list of strata.values()) // shuffle each group
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1));[list[i], list[j]] = [list[j], list[i]]; }
  const picked: Row[] = [];
  const lists = [...strata.entries()].sort().map(([, l]) => l);
  for (let round = 0; picked.length < n && lists.some((l) => l[round]); round++) // take one from each group in turn
    for (const l of lists) if (l[round] && picked.length < n) picked.push(l[round]);
  for (let i = picked.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1));[picked[i], picked[j]] = [picked[j], picked[i]]; }
  // the checker's verdict is left out on purpose, so labeling is blind
  const head = "row_id,question_id,model,claim,source_url,label,evidence,note";
  fs.writeFileSync("gold.csv", [head, ...picked.map((r) => [r.row_id, r.question_id, r.model, r.claim, r.source_url, "", "", ""].map(csvCell).join(","))].join("\n") + "\n");
  console.log(`Wrote gold.csv with ${picked.length} rows (seed ${SEED}). Fill the label column using LABELING.md, then run: npx tsx check.ts score`);
}

function score() {
  if (!fs.existsSync("gold.csv")) return console.log("No gold.csv. Run: npx tsx check.ts sample 60");
  const labels = ["supported", "partial", "unsupported"];
  const gold = parseCsv(fs.readFileSync("gold.csv", "utf8")).map((g): Record<string, string> => ({ ...g, label: g.label.trim().toLowerCase() }));
  const usable = gold.filter((g) => labels.includes(g.label));
  console.log(`gold.csv: ${gold.length} rows, ${usable.length} labeled supported/partial/unsupported, ${gold.filter((g) => g.label === "unchecked").length} unchecked, ${gold.filter((g) => !g.label).length} blank\n`);
  for (const judge of ["gemini", "baseline"]) {
    const byId = new Map(loadResults(judge).map((r) => [r.row_id, r]));
    const pairs = usable.map((g) => ({ gold: g.label, tool: byId.get(g.row_id)?.verdict })).filter((p) => p.tool && labels.includes(p.tool));
    if (!pairs.length) continue;
    const correct = pairs.filter((p) => p.gold === p.tool).length;
    const [lo, hi] = wilson(correct, pairs.length);
    const lines = [`## Judge: ${judge} (${pairs.length} rows)`, "", `Agreement with hand labels: ${correct}/${pairs.length} = ${pct(correct / pairs.length)} (95% range ${pct(lo)} to ${pct(hi)})`, "", "| Hand label \\ Checker | supported | partial | unsupported |", "|---|---|---|---|"];
    for (const g of labels) lines.push(`| ${g} | ${labels.map((t) => pairs.filter((p) => p.gold === g && p.tool === t).length).join(" | ")} |`);
    lines.push("");
    for (const l of labels) {
      const tp = pairs.filter((p) => p.gold === l && p.tool === l).length;
      const said = pairs.filter((p) => p.tool === l).length, truth = pairs.filter((p) => p.gold === l).length;
      lines.push(`- ${l}: caught ${tp} of ${truth} (recall ${truth ? pct(tp / truth) : "n/a"}); right ${tp} of the ${said} times the checker said it (precision ${said ? pct(tp / said) : "n/a"})`);
    }
    const out = lines.join("\n") + "\n";
    fs.writeFileSync(`results/score.${judge}.md`, out);
    console.log(out);
  }
}

// ---------- main ----------

const commands: Record<string, () => unknown> = { run, summary, sample, score };
if (!commands[cmd]) console.log("Usage: npx tsx check.ts run | summary | sample [n] | score   [--judge gemini|baseline] [--limit N] [--only model]");
else Promise.resolve(commands[cmd]()).catch((e) => { console.error(`\n${e.message}`); process.exit(1); });