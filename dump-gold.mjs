import fs from "node:fs";
import { createHash } from "node:crypto";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const clean = (u) => u.replace(/[.,;:!?)\]}>'"*]+$/, "");
const fetchUrl = (u) => clean(u).replace(/#.*$/, "").replace(/([?&])utm_[^&]*&?/gi, "$1").replace(/[?&]$/, "");
const key = (u) => fetchUrl(u).replace(/\/$/, "").toLowerCase();
const lines = fs.readFileSync("gold.csv", "utf8").trim().split("\n").slice(1);
fs.mkdirSync("gold-pages", { recursive: true });
lines.forEach((line, i) => {
  const cells = line.match(/"((?:[^"]|"")*)"/g).map((c) => c.slice(1, -1).replace(/""/g, '"'));
  const [rowId, qid, model, claim, url] = cells;
  const file = `cache/sources/${sha(key(url)).slice(0, 24)}.json`;
  const src = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { status: "not_in_cache", text: "" };
  fs.writeFileSync(`gold-pages/${String(i + 1).padStart(2, "0")}.txt`,
    `ROW ${i + 1} | ${rowId} | ${model} | ${qid}\nCLAIM: ${claim}\nURL: ${url}\nSTATUS: ${src.status}\n\n${src.text}`);
});
console.log("wrote", lines.length, "files");
