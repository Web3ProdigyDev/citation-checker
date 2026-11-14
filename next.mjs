// Usage: node next.mjs <assistant>
// Finds the next question that assistant has not answered, copies the prompt to the
// clipboard, and opens the file to paste the answer into.
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const model = process.argv[2];
if (!model) { console.log("Usage: node next.mjs <assistant>   e.g. node next.mjs chatgpt"); process.exit(1); }
const dir = `answers/${model}`;
fs.mkdirSync(dir, { recursive: true });
const questions = fs.readFileSync("questions.csv", "utf8").split(/\r?\n/).slice(1)
  .map((l) => l.match(/^([^,]+),[^,]*,[^,]*,[^,]*,"(.*)"$/)).filter(Boolean).map((m) => ({ id: m[1], q: m[2].replace(/""/g, '"') }));
const saved = (id) => fs.existsSync(`${dir}/${id}.md`) && fs.readFileSync(`${dir}/${id}.md`, "utf8").trim().length > 0;
const done = questions.filter((x) => saved(x.id)).length;
const next = questions.find((x) => !saved(x.id));
if (!next) { console.log(`${model}: all ${questions.length} answers saved.`); process.exit(0); }
const prompt = `Search the web, then answer the question below. Give a source link for every factual claim.\n\n${next.q}`;
const clip = spawnSync("clip.exe", { input: prompt });
console.log(`${model}: ${done}/${questions.length} saved. Next is ${next.id}.\n`);
console.log(clip.status === 0 ? "The prompt is on your clipboard. Paste it into a new chat." : `Copy this prompt into a new chat:\n\n${prompt}`);
console.log(`\nThen copy the answer, paste it into ${dir}/${next.id}.md (opening now) and press Ctrl+S.`);
spawnSync("code", [`${dir}/${next.id}.md`], { stdio: "ignore" });
