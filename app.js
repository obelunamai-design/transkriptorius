'use strict';
const APP_VERSION = '15 (2026-11-19)';

/* Jei kas nors nepavyksta (ypač senesniuose telefonuose) – rodoma aiški klaida ekrane */
window.addEventListener('error', e => showFatal(e.message + (e.lineno ? ' (eil. ' + e.lineno + ')' : '')));
window.addEventListener('unhandledrejection', e => showFatal(String(e.reason && e.reason.message || e.reason)));
function showFatal(msg) {
  let b = document.getElementById('fatal');
  if (!b) {
    b = document.createElement('div'); b.id = 'fatal';
    b.style.cssText = 'position:fixed;left:8px;right:8px;top:8px;z-index:99;background:#b3261e;color:#fff;padding:12px 14px;border-radius:10px;font:14px/1.4 system-ui,sans-serif';
    document.body.appendChild(b);
  }
  b.textContent = 'Programos klaida: ' + msg + '. Nufotografuokite šį pranešimą ir perduokite pagalbai. Naršyklė: ' + navigator.userAgent;
}

/* Langų (dialog) atsarginis variantas senesniems iPhone (iki iOS 15.4) */
if (typeof HTMLDialogElement === 'undefined' || !HTMLDialogElement.prototype.showModal) {
  document.querySelectorAll('dialog').forEach(d => {
    d.showModal = () => { d.setAttribute('open', ''); d.classList.add('dlg-fallback'); };
    d.close = v => { d.removeAttribute('open'); d.returnValue = v || ''; d.dispatchEvent(new Event('close')); };
    d.querySelectorAll('button[value]').forEach(b => b.addEventListener('click', () => { d._v = b.value; }));
    d.addEventListener('submit', ev => { ev.preventDefault(); d.close((ev.submitter && ev.submitter.value) || d._v || ''); });
  });
}

/* ================= Kalbos ================= */
const LANGS = [
  ['lt', 'lietuvių', 'lt-LT'], ['en', 'anglų', 'en-US'], ['de', 'vokiečių', 'de-DE'],
  ['pl', 'lenkų', 'pl-PL'], ['lv', 'latvių', 'lv-LV'], ['et', 'estų', 'et-EE'],
  ['ru', 'rusų', 'ru-RU'], ['uk', 'ukrainiečių', 'uk-UA'], ['fr', 'prancūzų', 'fr-FR'],
  ['es', 'ispanų', 'es-ES'], ['it', 'italų', 'it-IT'], ['sv', 'švedų', 'sv-SE'],
  ['no', 'norvegų', 'nb-NO'], ['fi', 'suomių', 'fi-FI'], ['da', 'danų', 'da-DK'],
  ['nl', 'olandų', 'nl-NL'], ['pt', 'portugalų', 'pt-PT'], ['cs', 'čekų', 'cs-CZ']
];
const EN = { lt: 'Lithuanian', en: 'English', de: 'German', pl: 'Polish', lv: 'Latvian', et: 'Estonian', ru: 'Russian', uk: 'Ukrainian', fr: 'French', es: 'Spanish', it: 'Italian', sv: 'Swedish', no: 'Norwegian', fi: 'Finnish', da: 'Danish', nl: 'Dutch', pt: 'Portuguese', cs: 'Czech' };
const langName = c => (LANGS.find(l => l[0] === c) || [, c])[1];
const bcp47 = c => (LANGS.find(l => l[0] === c) || [, , c])[2];

/* ================= Nustatymai ================= */
const DEFAULTS = {
  srcLang: 'lt', dstLang: 'none', engine: 'browser', apiKey: '', glossary: '',
  sttModel: 'gpt-4o-transcribe', trEngine: 'mymemory', trModel: 'gpt-4o-mini',
  autoPunct: true, showTime: true, keepAwake: true, welcomed: false,
  micId: '', sensitivity: 3, noiseLevel: 1, source: 'mic', includeMic: true
};
const store = {
  get(k, d) { try { const v = localStorage.getItem('tr_' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tr_' + k, JSON.stringify(v)); } catch {} }
};
const cfg = {};
for (const k in DEFAULTS) cfg[k] = store.get(k, DEFAULTS[k]);

const PARA_GAP = 4;        // s tylos – nauja pastraipa
const PARA_MAX = 650;      // simbolių – pastraipa skaidoma ties sakinio pabaiga

/* ================= DOM ================= */
const $ = id => document.getElementById(id);
const el = {
  srcLang: $('srcLang'), dstLang: $('dstLang'), recBtn: $('recBtn'), status: $('status'),
  transcript: $('transcript'), translation: $('translation'), timer: $('timer'), dstLabel: $('dstLabel'),
  toast: $('toast'), panels: document.querySelector('.panels'), trPanel: $('translationPanel'),
  modeBtns: [...document.querySelectorAll('.mode-btn')], polishBtn: $('polishBtn'), origBtn: $('origBtn')
};
for (const [c, n] of LANGS) el.srcLang.add(new Option(n, c));
el.dstLang.add(new Option('Nevesti', 'none'));
for (const [c, n] of LANGS) el.dstLang.add(new Option(n, c));
el.srcLang.value = cfg.srcLang; el.dstLang.value = cfg.dstLang;

/* ================= Būsena ================= */
// Pastraipa: { id, t, tEnd, lang, parts:[{text, auto}], closed, trChunks:[{text, tr, state}], trFrom, polished, polishedTr }
let segments = store.get('paras', []);
let running = false, startedAt = 0, sessionOffset = 0, timerId = null, wakeLock = null;
let engine = null, interimText = '', showOriginal = false;

const elapsed = () => sessionOffset + (running ? (Date.now() - startedAt) / 1000 : 0);
const fmt = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0'); };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const words = s => (s.trim().match(/\S+/g) || []).length;
const save = () => store.set('paras', segments);
const translating = () => el.dstLang.value !== 'none' && el.dstLang.value !== el.srcLang.value;

function setStatus(text, kind = '') { el.status.textContent = text; el.status.className = 'status ' + kind; }
function toast(msg, ms = 7000) { el.toast.textContent = msg; clearTimeout(toast.t); toast.t = setTimeout(() => el.toast.textContent = '', ms); }

/* ================= Automatinė skyryba (nemokamam režimui) ================= */
// Paprastos taisyklės: kablelis prieš jungtukus ir santykinius įvardžius, taškas pauzės vietoje,
// didžioji raidė sakinio pradžioje. Tai apytikslis rezultatas – tiksliam naudokite „Sutvarkyti skyrybą“.
const LT_COMMA = new Set(['kad', 'nes', 'jog', 'bet', 'tačiau', 'kai', 'jeigu', 'jei', 'o', 'kuris', 'kuri', 'kurie', 'kurios', 'kurio', 'kurių', 'kuriam', 'kuriai', 'kuriems', 'kurioms', 'kurį', 'kurią', 'kuriuos', 'kurias', 'kuriuo', 'kuria', 'kuriais', 'kuriomis', 'kuriame', 'kurioje', 'kuriuose', 'kuriose']);
const LT_NO_COMMA_AFTER = new Set(['ir', 'o', 'ar', 'bei', 'net', 'tik', 'ne', 'nebent', 'kad', 'nes', 'jog', 'bet', 'kai', 'jei', 'jeigu', 'tai', 'kaip', 'arba', 'nei', 'todėl']);
const BET_ANY = /^(kas|ko|kam|ką|kuo|kur|kada|koks|kokia|kokie|kokios|kokį|kokią|kokių|kaip|kuris|kuri|kurį|kurią|kurie|kurios|kieno)$/;
const QUESTION = { lt: /^(ar|kodėl|argi|negi|nejaugi)\b/i, en: /^(what|why|how|when|where|who|which|is|are|do|does|did|can|could|would|will|should)\b/i };

function addCommasLt(text) {
  const w = text.split(/\s+/);
  for (let i = 1; i < w.length; i++) {
    const cur = w[i].toLowerCase(), prev = w[i - 1].toLowerCase().replace(/[^\p{L}]/gu, ''), next = (w[i + 1] || '').toLowerCase();
    if (cur === 'todėl' && next === 'kad' && !/[,.;:!?]$/.test(w[i - 1])) { w[i - 1] += ','; continue; }  // „, todėl kad“
    if (!LT_COMMA.has(cur) || /[,.;:!?–-]$/.test(w[i - 1]) || LT_NO_COMMA_AFTER.has(prev)) continue;
    if (cur === 'kai' && /^(kur|kas|ka|kie|kok)/.test(next)) continue;      // „kai kurie“, „kai kas“
    if (cur === 'bet' && BET_ANY.test(next)) continue;                       // „bet kas“, „bet kada“
    if (cur === 'o' && (i < 2 || !next)) continue;
    w[i - 1] += ',';
  }
  return w.join(' ');
}
function assemble(parts, lang, closed) {
  let out = '';
  parts.forEach((p, i) => {
    let t = p.text.trim();
    if (!t) return;
    if (p.auto && cfg.autoPunct) {
      if (lang === 'lt') t = addCommasLt(t);
      const last = i === parts.length - 1;
      if (!/[.?!…:;,]$/.test(t) && (words(t) >= 3 || (last && closed))) {
        const q = QUESTION[lang];
        t += q && q.test(t) ? '?' : '.';
      }
    }
    out = out ? out + ' ' + t : t;
  });
  if (cfg.autoPunct || parts.some(p => !p.auto)) {
    out = out.replace(/(^|[.?!…]\s+)(\p{Ll})/gu, (m, a, b) => a + b.toUpperCase());
  }
  return out;
}
const paraText = s => (!showOriginal && s.polished) || assemble(s.parts, s.lang, s.closed);
function paraTranslation(s) {
  if (!showOriginal && s.polished && s.polishedTr) return s.polishedTr;
  return s.trChunks.map(c => c.state === 'ok' ? c.tr : '').join(' ').trim();
}

/* ================= Teksto pridėjimas ================= */
function addText(text, { auto, speechAt }) {
  text = (text || '').trim();
  if (!text) return;
  const t0 = speechAt ?? elapsed();
  let seg = segments[segments.length - 1];
  const cur = seg ? assemble(seg.parts, seg.lang, false) : '';
  // vėluojantis paskutinės atkarpos tekstas po „Stabdyti“ prijungiamas prie tos pačios pastraipos
  if (seg && seg.closed && !running && (t0 - seg.tEnd) <= PARA_GAP) seg.closed = false;
  const newPara = !seg || seg.closed || (t0 - seg.tEnd) > PARA_GAP || (cur.length > PARA_MAX && /[.?!]$/.test(cur));
  if (newPara) {
    if (seg && !seg.closed) closePara(seg);
    seg = { id: Date.now() + Math.random(), t: t0, tEnd: t0, lang: el.srcLang.value, parts: [], closed: false, trChunks: [], trFrom: 0, polished: null, polishedTr: null };
    segments.push(seg);
  }
  seg.parts.push({ text, auto: !!auto });
  seg.tEnd = elapsed();
  queueTranslation(seg, false);
  if (!running) { closePara(seg); setStatus('Sustabdyta. Tekstą galite atsisiųsti.'); }
  save(); render();
}
function closePara(seg) {
  if (!seg || seg.closed) return;
  seg.closed = true;
  queueTranslation(seg, true);
  save();
}

/* ================= Vertimas ================= */
const trQueue = []; let trBusy = false;
function queueTranslation(seg, flush) {
  if (!translating() || seg.trFrom >= seg.parts.length) return;
  const slice = seg.parts.slice(seg.trFrom);
  const isEnd = slice.length && /[.?!]$/.test(assemble(slice, seg.lang, false));
  if (!flush && (words(slice.map(p => p.text).join(' ')) < 6 && !isEnd)) return;
  const chunk = { text: assemble(slice, seg.lang, flush || seg.closed), tr: '', state: 'pending' };
  seg.trChunks.push(chunk); seg.trFrom = seg.parts.length;
  trQueue.push({ seg, chunk }); pumpTranslations();
}
async function pumpTranslations() {
  if (trBusy) return; trBusy = true;
  while (trQueue.length) {
    const job = trQueue.shift();
    const src = job.seg.lang, dst = el.dstLang.value;
    if (dst === 'none' || dst === src) continue;
    const text = job.chunk ? job.chunk.text : job.seg.polished;
    try {
      const prev = segments.slice(Math.max(0, segments.indexOf(job.seg) - 2), segments.indexOf(job.seg)).map(paraText).join(' ');
      const tr = (cfg.trEngine === 'openai' && cfg.apiKey) ? await translateOpenAI(text, src, dst, prev) : await translateMyMemory(text, src, dst);
      if (job.chunk) { job.chunk.tr = tr; job.chunk.state = 'ok'; } else job.seg.polishedTr = tr;
    } catch (e) {
      if (job.chunk) { job.chunk.tr = e.message; job.chunk.state = 'error'; }
      toast('Vertimo klaida: ' + e.message);
    }
    save(); render();
  }
  trBusy = false;
}
async function translateMyMemory(text, src, dst) {
  const parts = []; let cur = '';
  for (const s of text.replace(/([.!?…])\s+/g, '$1\n').split('\n')) {   // be „lookbehind“ – veikia ir senesniuose iPhone
    if ((cur + ' ' + s).length > 400 && cur) { parts.push(cur); cur = s; } else cur = cur ? cur + ' ' + s : s;
  }
  if (cur) parts.push(cur);
  const out = [];
  for (const p of parts) {
    const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(p)}&langpair=${src}|${dst}`);
    if (!r.ok) throw new Error('MyMemory ' + r.status);
    const j = await r.json();
    if (Number(j.responseStatus) !== 200) throw new Error(/LIMIT|QUOTA/i.test(j.responseDetails || '') ? 'baigėsi nemokamo vertimo dienos limitas' : (j.responseDetails || 'MyMemory klaida'));
    out.push(j.responseData.translatedText);
  }
  return out.join(' ');
}
async function openai(path, body, isForm) {
  const r = await fetch('https://api.openai.com/v1/' + path, {
    method: 'POST',
    headers: isForm ? { Authorization: 'Bearer ' + cfg.apiKey } : { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: isForm ? body : JSON.stringify(body)
  });
  if (!r.ok) {
    let msg = 'klaida ' + r.status;
    try { const j = await r.json(); if (j.error && j.error.message) msg += ': ' + j.error.message; } catch {}
    if (r.status === 401) msg = 'neteisingas API raktas';
    if (r.status === 429) msg = 'baigėsi kreditas arba viršytas limitas';
    throw new Error(msg);
  }
  return r.json();
}
async function translateOpenAI(text, src, dst, context) {
  const sys = `You are a professional interpreter. Translate the user's text from ${EN[src] || src} to ${EN[dst] || dst}. ` +
    `It comes from live speech recognition and may contain recognition errors; convey the intended meaning faithfully and naturally. ` +
    `Keep names, abbreviations and numbers exact. Output only the translation.` +
    (cfg.glossary ? ` Domain terms: ${cfg.glossary}.` : '') + (context ? `\nPreceding context (do not translate): ${context}` : '');
  const j = await openai('chat/completions', { model: cfg.trModel, temperature: 0.2, messages: [{ role: 'system', content: sys }, { role: 'user', content: text }] });
  return j.choices[0].message.content.trim();
}

/* ================= Skyrybos tvarkymas (OpenAI) ================= */
async function polishAll() {
  if (running) return toast('Pirmiausia sustabdykite įrašymą.');
  if (!segments.length) return toast('Kol kas nėra teksto.');
  if (!cfg.apiKey) { toast('Skyrybos tvarkymui reikia OpenAI rakto (kaina – keli centai). Įveskite jį nustatymuose.'); return openSettings(); }
  segments.forEach(closePara);
  el.polishBtn.disabled = true; setStatus('Tvarkoma skyryba…', 'live');
  const lang = EN[el.srcLang.value] || el.srcLang.value;
  try {
    for (let i = 0; i < segments.length; i += 12) {
      const batch = segments.slice(i, i + 12);
      const sys = `You edit raw ${lang} speech-recognition transcripts. For each paragraph: add correct punctuation (commas, periods, question marks) and capitalization according to ${lang} grammar rules; join words that were split; fix obvious recognition errors only when context makes the intended word certain; remove accidental immediate word repetitions. ` +
        `Do NOT paraphrase, summarize, translate, add or remove meaning. Keep the speaker's wording.` + (cfg.glossary ? ` Correct spelling of these terms: ${cfg.glossary}.` : '') +
        ` Respond with JSON {"paragraphs": [...]} containing exactly ${batch.length} strings in the same order.`;
      const j = await openai('chat/completions', {
        model: cfg.trModel, temperature: 0, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify({ paragraphs: batch.map(s => assemble(s.parts, s.lang, true)) }) }]
      });
      const out = JSON.parse(j.choices[0].message.content).paragraphs;
      if (!Array.isArray(out) || out.length !== batch.length) throw new Error('netikėtas atsakymo formatas, bandykite dar kartą');
      batch.forEach((s, k) => { s.polished = String(out[k]).trim(); s.polishedTr = null; });
      showOriginal = false; save(); render();
    }
    if (translating() && cfg.trEngine === 'openai') segments.forEach(s => trQueue.push({ seg: s }));
    pumpTranslations();
    toast('Skyryba sutvarkyta. Originalą galite peržiūrėti mygtuku „Rodyti originalą“.');
  } catch (e) {
    toast('Nepavyko sutvarkyti: ' + e.message);
  }
  el.polishBtn.disabled = false; setStatus(running ? 'Klausausi… kalbėkite' : 'Paspauskite mygtuką ir kalbėkite');
}

/* ================= Atvaizdavimas ================= */
function render() {
  const showTr = translating();
  el.trPanel.hidden = !showTr;
  el.panels.classList.toggle('single', !showTr);
  el.dstLabel.textContent = showTr ? '→ ' + langName(el.dstLang.value) : '';
  el.origBtn.hidden = !segments.some(s => s.polished);
  el.origBtn.textContent = showOriginal ? 'Rodyti sutvarkytą' : 'Rodyti originalą';

  if (!segments.length && !interimText) {
    el.transcript.innerHTML = '<p class="placeholder">Čia atsiras tekstas. Paspauskite mygtuką viršuje ir kalbėkite.</p>';
    el.translation.innerHTML = '<p class="placeholder">Čia atsiras vertimas.</p>';
    return;
  }
  const ts = s => cfg.showTime ? `<span class="ts">${fmt(s.t)}</span>` : '';
  const last = segments[segments.length - 1];
  let html = segments.map(s => {
    const tail = (s === last && !s.closed && interimText) ? ` <span class="interim">${esc(interimText)}</span>` : '';
    return `<p>${ts(s)}${esc(paraText(s))}${tail}</p>`;
  }).join('');
  if (interimText && (!last || last.closed)) html += `<p class="interim">${esc(interimText)}</p>`;
  el.transcript.innerHTML = html;

  if (showTr) {
    el.translation.innerHTML = segments.map(s => {
      const tr = paraTranslation(s);
      const errs = s.trChunks.filter(c => c.state === 'error');
      const waiting = s.trChunks.some(c => c.state === 'pending') || (!s.closed && s.trFrom < s.parts.length);
      return `<p>${ts(s)}${esc(tr)}${waiting ? ' <span class="pending">…</span>' : ''}${errs.length && !tr ? `<span class="err">Vertimo klaida: ${esc(errs[0].tr)}</span>` : ''}</p>`;
    }).join('');
  }
  for (const box of [el.transcript, el.translation]) box.scrollTop = box.scrollHeight;
}

/* ================= Garsas: šaltinis, triukšmo filtras, garsumas ================= */
// Garsumas 1–5: stiprinimas ir kalbos aptikimo slenkstis
const SENS = { gain: [1, 1.6, 2.5, 4, 6], min: [0.02, 0.012, 0.007, 0.0045, 0.003], k: [4, 3.5, 3, 2.6, 2.2] };
const SENS_LABELS = ['Mažas', 'Žemesnis', 'Vidutinis', 'Didelis', 'Labai didelis'];
const NOISE_LABELS = ['Išjungtas', 'Įprastas', 'Stiprus'];
const sIdx = v => Math.min(4, Math.max(0, (Number(v ?? cfg.sensitivity) || 3) - 1));
const speechThreshold = (floor = noiseFloor) => Math.max(SENS.min[sIdx()], floor * SENS.k[sIdx()]) * (cfg.noiseLevel === 2 ? 1.3 : 1);
let curRms = 0, noiseFloor = 0.01, meter = null, live = null, testInput = null;
const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_ANDROID = /Android/i.test(navigator.userAgent);
const IS_MOBILE = IS_IOS || IS_ANDROID;
let sharedCtx = null;
// Kviečiama iškart paspaudus mygtuką (iPhone kitaip garso apdorojimo nepaleidžia)
function getCtx() {
  if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (sharedCtx.state !== 'running' && sharedCtx.resume) sharedCtx.resume().catch(() => {});
  return sharedCtx;
}

async function openMic(micId = cfg.micId) {
  const c = { echoCancellation: true, noiseSuppression: cfg.noiseLevel > 0, autoGainControl: true };
  if (micId) c.deviceId = { exact: micId };
  try { return await navigator.mediaDevices.getUserMedia({ audio: c }); }
  catch (e) {
    if (micId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
      toast('Pasirinktas mikrofonas nerastas – naudojamas numatytasis.');
      cfg.micId = ''; store.set('micId', ''); listMics();
      delete c.deviceId; return navigator.mediaDevices.getUserMedia({ audio: c });
    }
    throw e;
  }
}

// Sukuria apdorotą garso srautą: mikrofonas (filtras, garsumas) ir (ar) kompiuterio garsas (Teams, Zoom).
async function buildInput(source = cfg.source) {
  let disp = null, mic = null;
  if (source === 'meeting') {
    if (!navigator.mediaDevices.getDisplayMedia) throw new Error('Pokalbio garsą galima užrašyti tik kompiuteryje, naršyklėje Chrome arba Edge.');
    try {
      disp = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 }, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include', selfBrowserSurface: 'exclude'
      });
    } catch (e) { throw new Error('Bendrinimas atšauktas. Kad programa girdėtų pokalbį, pasirinkite „Visas ekranas“ ir pažymėkite „Bendrinti sistemos garsą“.'); }
    if (!disp.getAudioTracks().length) {
      disp.getTracks().forEach(t => t.stop());
      throw new Error('Nepažymėjote garso bendrinimo. Spauskite įrašymą dar kartą ir bendrinimo lango apačioje uždėkite varnelę „Bendrinti sistemos garsą“.');
    }
  }
  try { if (source !== 'meeting' || cfg.includeMic) mic = await openMic(); }
  catch (e) { if (disp) disp.getTracks().forEach(t => t.stop()); throw e; }

  const ctx = getCtx(), nodes = [];
  const dest = ctx.createMediaStreamDestination();
  let gainNode = null;
  if (mic) {
    let node = ctx.createMediaStreamSource(mic); nodes.push(node);
    if (cfg.noiseLevel === 2) {                 // stiprus filtras: nukerpami žemi (ūžesys) ir aukšti (šnypštimas) dažniai
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 120;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7000;
      node.connect(hp); hp.connect(lp); node = lp; nodes.push(hp, lp);
    }
    gainNode = ctx.createGain(); gainNode.gain.value = SENS.gain[sIdx()];
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 10; comp.ratio.value = 12; comp.attack.value = 0.003; comp.release.value = 0.25;
    node.connect(gainNode); gainNode.connect(comp); comp.connect(dest); nodes.push(gainNode, comp);
  }
  if (disp) { const ds = ctx.createMediaStreamSource(new MediaStream(disp.getAudioTracks())); ds.connect(dest); nodes.push(ds); }
  const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
  const as = ctx.createMediaStreamSource(dest.stream); as.connect(analyser); nodes.push(as, analyser);
  return {
    stream: dest.stream, analyser, gainNode, disp, mic,
    close() {
      [disp, mic].forEach(x => x && x.getTracks().forEach(t => t.stop()));
      dest.stream.getTracks().forEach(t => t.stop());
      nodes.forEach(n => { try { n.disconnect(); } catch {} });
    }
  };
}

// Garso lygio juosta, mygtuko „pulsavimas“ ir užuomina „girdžiu / tylu“
function startMeter(input) {
  stopMeter();
  const buf = new Float32Array(input.analyser.fftSize); let heard = 0;
  noiseFloor = 0.01;
  meter = setInterval(() => {
    input.analyser.getFloatTimeDomainData(buf);
    let sum = 0; for (const v of buf) sum += v * v;
    curRms = Math.sqrt(sum / buf.length);
    noiseFloor = curRms < noiseFloor ? curRms : noiseFloor * 1.002 + 0.00002;
    const thr = speechThreshold(), pct = v => Math.min(100, Math.sqrt(v / 0.25) * 100), on = curRms > thr;
    if (on) heard = Date.now();
    $('levelBar').style.width = pct(curRms) + '%';
    $('levelThr').style.left = pct(thr) + '%';
    $('levelBar').classList.toggle('ok', on);
    $('testInfo').textContent = Date.now() - heard < 700 ? 'Girdžiu ✓' : 'Tylu – kalbėkite arba didinkite garsumą';
    if (running) el.recBtn.style.boxShadow = `0 0 0 ${Math.min(26, curRms * 160).toFixed(1)}px var(--rec-soft)`;
  }, 60);
}
function stopMeter() {
  clearInterval(meter); meter = null; curRms = 0;
  el.recBtn.style.boxShadow = ''; $('levelBar').style.width = '0'; $('levelBar').classList.remove('ok'); $('testInfo').textContent = '';
}

/* ================= Nemokamas režimas: naršyklės atpažinimas ================= */
function BrowserEngine() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) throw new Error('Ši naršyklė nemokamo režimo nepalaiko. Atidarykite programą per Chrome arba Edge, arba rinkitės „Profesionalus“.');
  let androidCommit = () => {};
  let rec = null, stopped = false, input = null, utterStart = null, quickEnds = 0, sessionStart = 0, gotResult = false, lastErr = 'nėra';
  const tech = () => ` [Techninė info: klaida „${lastErr}“, kalba ${bcp47(el.srcLang.value)}, ${(navigator.userAgent.match(/(iPhone OS [\d_]+|Android [\d.]+|Windows NT [\d.]+)/) || [''])[0]}, ${(navigator.userAgent.match(/(CriOS|Chrome|Version|Edg|SamsungBrowser)\/[\d.]+/) || [''])[0]}]`;
  const IOS_HELP = 'iPhone nemokamas atpažinimas nepasileido. Galimos priežastys: 1) išjungtas diktavimas – įjunkite: Nustatymai → Bendrieji → Klaviatūra → Įjungti diktavimą; 2) iPhone diktavimas nepalaiko pasirinktos kalbos. Patikimiausia iPhone – rinktis „Profesionalus“ režimą.';
  return {
    async start() {
      if (IS_MOBILE) {
        // Telefonai neleidžia mikrofono naudoti dviem tikslais vienu metu – atidaromas tik atpažinimas (kaip pirmoje, veikusioje versijoje)
        if (cfg.source === 'meeting') throw new Error('Teams / Zoom pokalbio telefone užrašyti negalima.');
        setStatus('Klausausi… kalbėkite', 'live');
      } else {
      // Kompiuteryje: mikrofonas atidaromas tik garso lygio juostai, o atpažinimas klauso pats (patikrintas būdas).
      // Tik Teams / Zoom režime atpažinimui perduodamas pokalbio garsas.
      input = await buildInput();
      if (input.disp) input.disp.getAudioTracks()[0].addEventListener('ended', () => { if (running) { stop(); toast('Ekrano bendrinimas sustabdytas – įrašymas baigtas.'); } });
      live = input;
      startMeter(input);
      }
      const make = () => {
        sessionStart = Date.now(); gotResult = false;
        rec = new SR();
        // Klausoma be pertraukų (kitaip „Android“ persijungimo metu praleidžia žodžius)
        rec.lang = bcp47(el.srcLang.value); rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
        let sessionFinal = '';
        const doneIdx = new Map();   // Android kartais iš naujo grąžina jau apdorotus rezultatus (indeksas -> jau užrašytas tekstas)
        if (IS_ANDROID) {
          // „Android Chrome“ kiekvieną kartą grąžina VISĄ iki šiol pasakytą tekstą. Todėl laikomas vienas „juodraštis“:
          // jis pakeičiamas naujesne versija, o į tekstą įrašoma tik nauja dalis (pagal jau įrašytų žodžių skaičių).
          let chainHead = [], chainWords = 0, draft = '', draftAt = 0;
          const commit = () => { if (draft) addText(draft, { auto: true, speechAt: draftAt }); draft = ''; interimText = ''; };
          androidCommit = () => { commit(); chainHead = []; chainWords = 0; };
          rec.onresult = e => {
            gotResult = true; quickEnds = 0;
            const lastR = e.results[e.results.length - 1];
            const cur = ((lastR && lastR[0].transcript) || '').trim();
            if (!cur) return;
            const words = cur.split(/\s+/), lw = words.map(x => x.toLowerCase());
            const n = Math.min(3, chainHead.length, lw.length);
            const sameChain = n > 0 && chainHead.slice(0, n).join(' ') === lw.slice(0, n).join(' ');
            if (!sameChain) { commit(); chainWords = 0; chainHead = lw.slice(0, 3); }
            else if (chainHead.length < 3) chainHead = lw.slice(0, 3);
            if (!draft) draftAt = elapsed();
            draft = words.slice(chainWords).join(' ');
            // ilgą kalbą įrašome dalimis, kad tekstas nebūtų tik pilkas juodraštis
            if (lastR.isFinal && draft.split(/\s+/).length >= 20) { commit(); chainWords = words.length; }
            interimText = draft; render();
          };
        } else
        rec.onresult = e => {
          gotResult = true; quickEnds = 0;
          if (utterStart === null) utterStart = elapsed();
          let interim = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i];
            if (r.isFinal) {
              const full = r[0].transcript.trim();
              // Apsauga nuo pasikartojimų: jei rezultatas kartoja jau užrašytą tekstą, paimama tik nauja dalis
              const seen = doneIdx.has(i) ? doneIdx.get(i) : sessionFinal;
              let t = full;
              if (seen && full.toLowerCase().startsWith(seen.toLowerCase())) t = full.slice(seen.length).trim();
              doneIdx.set(i, full); sessionFinal = full;
              const last = segments.length ? segments[segments.length - 1] : null;
              const lastPart = last && last.parts.length ? last.parts[last.parts.length - 1].text.trim().toLowerCase() : '';
              if (t && t.toLowerCase() !== lastPart) addText(t, { auto: true, speechAt: utterStart });
              utterStart = elapsed();
            }
            else interim += r[0].transcript;
          }
          if (!interim) utterStart = null;
          interimText = interim.trim(); render();
        };
        rec.onerror = e => {
          lastErr = e.error || 'nežinoma';
          if (e.error === 'no-speech' || e.error === 'aborted') return;
          if (e.error === 'service-not-allowed' && IS_IOS) { stopped = true; fail(IOS_HELP + tech()); return; }
          if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { stopped = true; fail('Mikrofonas neleidžiamas. Žr. „Pagalba“ → „Jei neveikia mikrofonas“.'); return; }
          if (e.error === 'audio-capture') { stopped = true; fail('Mikrofonas nepasiekiamas – galbūt jį naudoja kita programa (pvz., skambutis). Uždarykite ją ir bandykite dar kartą.'); return; }
          if (e.error === 'network') { toast('Nutrūko ryšys su atpažinimo tarnyba, jungiamasi iš naujo…'); return; }
          if (e.error === 'language-not-supported') { stopped = true; fail(IS_IOS ? 'iPhone diktavimas nepalaiko pasirinktos kalbos. Rinkitės „Profesionalus“ režimą.' : 'Ši naršyklė nepalaiko pasirinktos kalbos. Naudokite Chrome arba „Profesionalus“ režimą.'); return; }
          toast('Atpažinimo klaida: ' + e.error + tech());
        };
        rec.onend = () => {
          if (IS_ANDROID) androidCommit();
          else if (interimText) { addText(interimText, { auto: true, speechAt: utterStart }); interimText = ''; utterStart = null; }
          // Jei atpažinimas vis iškart užsidaro ir nieko negirdi – nebandome be galo, o parodome priežastį
          if (!gotResult && Date.now() - sessionStart < 1000) quickEnds++; else quickEnds = 0;
          if (!stopped && quickEnds >= 6) { stopped = true; fail((IS_IOS ? IOS_HELP : (input && input.disp) ? 'Nemokamas režimas šioje naršyklėje pokalbio garso neatpažįsta. Teams / Zoom pokalbiui rinkitės „Profesionalus“.' : 'Nemokamas atpažinimas nepasileidžia. Patikrinkite, ar naršyklei leistas mikrofonas, arba rinkitės „Profesionalus“ režimą.') + tech()); return; }
          if (!stopped) setTimeout(() => { if (!stopped) { try { make(); } catch (err) { stopped = true; fail('Atpažinimo nepavyko paleisti: ' + err.message); } } }, IS_ANDROID ? 0 : 300);
        };
        if (input && input.disp) {
          try { rec.start(input.stream.getAudioTracks()[0]); }
          catch (err) { stopped = true; fail('Nemokamas režimas šioje naršyklėje pokalbio garso nepriima. Teams / Zoom pokalbiui rinkitės „Profesionalus“.'); }
        } else rec.start();
      };
      make();
    },
    stop() {
      stopped = true;
      try { rec && rec.stop(); } catch {}
      live = null; stopMeter(); if (input) input.close();
    }
  };
}

/* ================= Profesionalus režimas: OpenAI, karpoma pagal pauzes ================= */
function OpenAIEngine() {
  if (!cfg.apiKey) throw new Error('Profesionaliam režimui įveskite OpenAI raktą nustatymuose.');
  if (!window.MediaRecorder) throw new Error('Ši naršyklė nepalaiko garso įrašymo.');
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(m => MediaRecorder.isTypeSupported(m)) || '';
  const ext = mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : 'webm';
  const MIN_LEN = 4000, MAX_LEN = 28000, PAUSE = 700, MIN_SPEECH = 500, IDLE_RESET = 12000;
  let input = null, stream = null, stopped = false, recorder = null, vadTimer = null, lastText = '';
  const queue = []; let busy = false, pending = 0;

  async function pump() {
    if (busy) return; busy = true;
    while (queue.length) {
      const { blob, speechAt } = queue.shift();
      try {
        const fd = new FormData();
        fd.append('file', blob, 'kalba.' + ext);
        fd.append('model', cfg.sttModel);
        fd.append('language', el.srcLang.value);
        const prompt = [cfg.glossary, lastText.slice(-300)].filter(Boolean).join(' ');
        if (prompt) fd.append('prompt', prompt);
        const j = await openai('audio/transcriptions', fd, true);
        const text = (j.text || '').trim();
        if (text && /\p{L}/u.test(text)) { lastText = text; addText(text, { auto: false, speechAt }); }
      } catch (e) {
        toast('Atpažinimo klaida: ' + e.message);
        if (/raktas/.test(e.message)) { fail('Neteisingas OpenAI raktas. Patikrinkite nustatymuose.'); }
      }
      pending--;
      interimText = pending > 0 ? 'rašoma…' : ''; render();
    }
    busy = false;
  }
  function recordChunk() {
    if (stopped) return;
    const parts = [], began = Date.now(), beganAt = elapsed();
    let speechStart = null, lastVoice = null;
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = e => { if (e.data && e.data.size) parts.push(e.data); };
    recorder.onstop = () => {
      if (!stopped) recordChunk();
      const voiced = speechStart && (lastVoice - speechStart) >= MIN_SPEECH;
      if (!voiced) return;                                   // tyla ar trumpas triukšmas – nesiunčiama
      const blob = new Blob(parts, { type: recorder.mimeType || mime || 'audio/webm' });
      pending++; interimText = 'rašoma…'; render();
      queue.push({ blob, speechAt: beganAt + (speechStart - began) / 1000 }); pump();
    };
    recorder.start();
    clearInterval(vadTimer);
    vadTimer = setInterval(() => {
      const now = Date.now(), dur = now - began;
      if (curRms > speechThreshold()) { if (!speechStart) speechStart = now; lastVoice = now; }
      const pauseNow = lastVoice && now - lastVoice >= PAUSE;
      const cut = (dur >= MIN_LEN && speechStart && pauseNow) || dur >= MAX_LEN || (!speechStart && dur >= IDLE_RESET);
      if (cut && recorder.state !== 'inactive') { clearInterval(vadTimer); recorder.stop(); }
    }, 100);
  }
  return {
    async start() {
      input = await buildInput();
      // iPhone įrašomas tiesioginis mikrofono garsas (patikimiau), o garsumas taikomas kalbos aptikimui
      stream = (IS_IOS && input.mic && !input.disp) ? input.mic : input.stream; live = input;
      if (input.disp) input.disp.getAudioTracks()[0].addEventListener('ended', () => { if (running) { stop(); toast('Ekrano bendrinimas sustabdytas – įrašymas baigtas.'); } });
      startMeter(input);
      recordChunk();
    },
    stop() {
      stopped = true; clearInterval(vadTimer);
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch {}
      live = null;
      setTimeout(() => { stopMeter(); if (input) input.close(); }, 300);
    }
  };
}

/* ================= Valdymas ================= */
const canMeeting = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
function setMode(m) {
  cfg.engine = m; store.set('engine', m);
  el.modeBtns.forEach(b => b.setAttribute('aria-checked', String(b.dataset.engine === m)));
  updateAudioPanel();
}
function setSource(src) {
  cfg.source = src; store.set('source', src);
  document.querySelectorAll('.src-btn').forEach(b => b.setAttribute('aria-checked', String(b.dataset.source === src)));
  updateAudioPanel();
}
el.modeBtns.forEach(b => b.onclick = () => {
  if (running) return toast('Režimą pakeisite sustabdę įrašymą.');
  setMode(b.dataset.engine);
  if (b.dataset.engine === 'openai' && !cfg.apiKey) { toast('Profesionaliam režimui reikia OpenAI rakto. Įveskite jį nustatymuose.'); openSettings(); }
});
document.querySelectorAll('.src-btn').forEach(b => b.onclick = () => {
  if (running) return toast('Šaltinį pakeisite sustabdę įrašymą.');
  setSource(b.dataset.source);
  if (b.dataset.source === 'meeting') {
    toast('Paspaudus įrašymą, naršyklė paprašys pasirinkti ekraną – pasirinkite „Visas ekranas“ ir pažymėkite „Bendrinti sistemos garsą“.', 12000);
  }
});

/* --- Garso nustatymų skydelis --- */
async function listMics() {
  const sel = $('micId');
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    sel.innerHTML = '';
    sel.add(new Option('Numatytasis mikrofonas', ''));
    devs.forEach((d, i) => sel.add(new Option(d.label || ('Mikrofonas ' + (i + 1)), d.deviceId)));
    sel.value = devs.some(d => d.deviceId === cfg.micId) ? cfg.micId : '';
  } catch {}
}
function updateAudioPanel() {
  $('sensitivity').value = cfg.sensitivity;
  $('sensLabel').textContent = SENS_LABELS[sIdx()];
  document.querySelectorAll('#noiseSeg button').forEach(b => b.setAttribute('aria-checked', String(Number(b.dataset.n) === cfg.noiseLevel)));
  $('includeMic').checked = cfg.includeMic;
  $('includeMicRow').hidden = cfg.source !== 'meeting';
  $('winSound').hidden = !/Windows/i.test(navigator.userAgent);
  $('audioSummary').textContent = `garsumas: ${SENS_LABELS[sIdx()].toLowerCase()}, filtras: ${NOISE_LABELS[cfg.noiseLevel].toLowerCase()}`;
}
const restartNote = () => { if (running) toast('Šis pakeitimas įsigalios kitą kartą pradėjus įrašymą.'); else if (testInput) { stopTest(); startTest(); } };
$('sensitivity').oninput = () => {
  cfg.sensitivity = Number($('sensitivity').value); store.set('sensitivity', cfg.sensitivity);
  const g = SENS.gain[sIdx()];
  [live, testInput].forEach(x => { if (x && x.gainNode) x.gainNode.gain.value = g; });   // keičiama iškart, net įrašant
  updateAudioPanel();
};
document.querySelectorAll('#noiseSeg button').forEach(b => b.onclick = () => {
  cfg.noiseLevel = Number(b.dataset.n); store.set('noiseLevel', cfg.noiseLevel); updateAudioPanel(); restartNote();
});
$('micId').onchange = () => { cfg.micId = $('micId').value; store.set('micId', cfg.micId); restartNote(); };
$('includeMic').onchange = () => { cfg.includeMic = $('includeMic').checked; store.set('includeMic', cfg.includeMic); restartNote(); };
$('audioPanel').addEventListener('toggle', () => { if ($('audioPanel').open) listMics(); else stopTest(); });

async function startTest() {
  getCtx();
  try {
    testInput = await buildInput('mic');
    startMeter(testInput); listMics();
    $('testBtn').textContent = 'Baigti tikrinimą';
  } catch (e) { testInput = null; toast('Mikrofono atidaryti nepavyko: ' + e.message); }
}
function stopTest() {
  if (!testInput) return;
  stopMeter(); testInput.close(); testInput = null;
  $('testBtn').textContent = 'Tikrinti garsą';
}
$('testBtn').onclick = () => {
  if (running) return toast('Įrašant garso lygis jau rodomas juostoje.');
  testInput ? stopTest() : startTest();
};

async function start() {
  getCtx();
  if (IS_IOS && cfg.engine === 'browser' && !store.get('iosWarned', false)) {
    store.set('iosWarned', true);
    toast('iPhone nemokamas režimas naudoja Apple diktavimą: jis turi būti įjungtas (Nustatymai → Bendrieji → Klaviatūra), o lietuvių kalba gali būti nepalaikoma. Jei tekstas neatsiras – rinkitės „Profesionalus“.', 15000);
  }
  stopTest();
  try {
    engine = cfg.engine === 'openai' ? OpenAIEngine() : BrowserEngine();
    running = true; startedAt = Date.now();
    el.recBtn.classList.add('on'); el.recBtn.setAttribute('aria-label', 'Stabdyti įrašymą'); document.body.classList.add('rec');
    setStatus(cfg.source === 'meeting' ? 'Klausausi pokalbio…' : 'Klausausi… kalbėkite', 'live');
    await engine.start();
    timerId = setInterval(() => el.timer.textContent = fmt(elapsed()), 500);
    if (cfg.keepAwake && 'wakeLock' in navigator) { try { wakeLock = await navigator.wakeLock.request('screen'); } catch {} }
    el.srcLang.disabled = true;
  } catch (e) {
    fail(e.name === 'NotAllowedError' ? 'Mikrofonas neleidžiamas. Žr. „Pagalba“ → „Jei neveikia mikrofonas“.' :
         e.name === 'NotFoundError' ? 'Nerastas mikrofonas. Prijunkite mikrofoną ir bandykite dar kartą.' : e.message);
  }
}
function stop(silent) {
  if (engine) engine.stop();
  engine = null;
  if (running) sessionOffset += (Date.now() - startedAt) / 1000;
  running = false;
  clearInterval(timerId);
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  el.recBtn.classList.remove('on'); el.recBtn.setAttribute('aria-label', 'Pradėti įrašymą'); document.body.classList.remove('rec');
  el.srcLang.disabled = false;
  if (!silent) setStatus(segments.length ? 'Sustabdyta. Tekstą galite atsisiųsti.' : 'Paspauskite mygtuką ir kalbėkite');
  setTimeout(() => { closePara(segments[segments.length - 1]); if (cfg.engine === 'browser') interimText = ''; render(); }, cfg.engine === 'openai' ? 0 : 400);
}
function fail(msg) { stop(true); setStatus('Nepavyko pradėti', 'error'); toast(msg, 60000); }

el.recBtn.onclick = () => running ? stop() : start();
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && running && cfg.keepAwake && 'wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
});
el.srcLang.onchange = () => { cfg.srcLang = el.srcLang.value; store.set('srcLang', cfg.srcLang); render(); };
el.dstLang.onchange = () => {
  store.set('dstLang', el.dstLang.value);
  segments.forEach(s => { s.trChunks = []; s.trFrom = 0; s.polishedTr = null; });
  if (translating()) segments.forEach(s => {
    if (s.polished && cfg.trEngine === 'openai') trQueue.push({ seg: s });
    queueTranslation(s, true);
  });
  pumpTranslations(); save(); render();
};

/* ================= Eksportas ================= */
const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const fileBase = () => 'transkripcija_' + stamp().replace(/[: ]/g, '-');
const need = () => { if (!segments.length) { toast('Kol kas nėra teksto.'); return false; } return true; };
function plainText() {
  const tr = translating();
  return segments.map(s => (cfg.showTime ? `[${fmt(s.t)}] ` : '') + paraText(s) + (tr && paraTranslation(s) ? `\n[${langName(el.dstLang.value)}] ${paraTranslation(s)}` : '')).join('\n\n');
}
function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$('copyBtn').onclick = async () => {
  if (!need()) return;
  try { await navigator.clipboard.writeText(plainText()); toast('Tekstas nukopijuotas. Galite įklijuoti į Word ar el. laišką.'); } catch { toast('Nepavyko nukopijuoti.'); }
};
$('txtBtn').onclick = () => need() && download(fileBase() + '.txt', '﻿' + plainText(), 'text/plain;charset=utf-8');
function buildDoc() {
  const tr = translating();
  const body = segments.map(s => {
    const t = cfg.showTime ? `<span style="color:#777;font-size:9pt">${fmt(s.t)}</span><br>` : '';
    return tr
      ? `<tr><td>${t}${esc(paraText(s))}</td><td>${esc(paraTranslation(s))}</td></tr>`
      : `<p>${t}${esc(paraText(s))}</p>`;
  }).join('');
  return '﻿' + `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>Transkripcija</title>
<style>body{font-family:Calibri,Arial;font-size:11pt;line-height:1.4}p{margin:0 0 10pt}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:5pt;vertical-align:top;width:50%}th{background:#e8eef5;text-align:left}</style></head>
<body><h2>Transkripcija</h2><p style="color:#555">Data: ${stamp()}. Kalba: ${langName(el.srcLang.value)}${tr ? '; vertimas: ' + langName(el.dstLang.value) : ''}. Tekstas sugeneruotas automatiškai – prieš naudojant būtina peržiūrėti.</p>
${tr ? `<table><tr><th>${langName(el.srcLang.value)}</th><th>${langName(el.dstLang.value)}</th></tr>${body}</table>` : body}</body></html>`;
}
$('docBtn').onclick = () => {
  if (!need()) return;
  download(fileBase() + '.doc', buildDoc(), 'application/msword');
  toast(IS_MOBILE ? 'Failas atsisiųstas į „Atsisiuntimai“ (Files / Failai).' : 'Atsisiųsta. Jei Word praneš apie failo formatą – spauskite „Taip“.');
};
// Telefone: išsiųsti el. paštu, per „Teams“, „Messenger“, išsaugoti į „Drive“ ir pan.
if (navigator.share) $('shareBtn').hidden = false;
$('shareBtn').onclick = async () => {
  if (!need()) return;
  try {
    const file = new File([buildDoc()], fileBase() + '.doc', { type: 'application/msword' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: 'Transkripcija' });
    else await navigator.share({ title: 'Transkripcija', text: plainText() });
  } catch (e) { if (e.name !== 'AbortError') toast('Nepavyko pasidalinti: ' + e.message); }
};
$('srtBtn').onclick = () => {
  if (!need()) return;
  const t2 = t => { const ms = Math.round(t * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000), x = ms % 1000; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(x).padStart(3, '0')}`; };
  const tr = translating();
  download(fileBase() + '.srt', segments.map((s, i) => `${i + 1}\n${t2(s.t)} --> ${t2(Math.max(s.tEnd, s.t + 2))}\n${paraText(s)}${tr && paraTranslation(s) ? '\n' + paraTranslation(s) : ''}\n`).join('\n'), 'text/plain;charset=utf-8');
};
el.polishBtn.onclick = polishAll;
$('polishBtn2').onclick = () => { document.querySelector('.more').open = false; polishAll(); };
$('clearBtn').addEventListener('click', () => document.querySelector('.more').open = false);
el.origBtn.onclick = () => { showOriginal = !showOriginal; render(); };
$('clearBtn').onclick = () => {
  if (!segments.length) return;
  if (!confirm('Ištrinti visą tekstą? Jei jo dar neišsaugojote – pirmiausia spauskite „Atsisiųsti Word“.')) return;
  segments = []; interimText = ''; trQueue.length = 0; showOriginal = false;
  sessionOffset = running ? -(Date.now() - startedAt) / 1000 : 0;
  el.timer.textContent = fmt(elapsed()); save(); render();
};

/* ================= Langai ================= */
const SETTINGS = ['apiKey', 'glossary', 'trEngine', 'autoPunct', 'showTime', 'keepAwake', 'sttModel', 'trModel'];
function openSettings() {
  for (const k of SETTINGS) { const i = $(k); if (i.type === 'checkbox') i.checked = !!cfg[k]; else i.value = cfg[k]; }
  $('settings').showModal();
}
$('settingsBtn').onclick = openSettings;
$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
  for (const k of SETTINGS) {
    const i = $(k);
    cfg[k] = i.type === 'checkbox' ? i.checked : (i.value.trim() || DEFAULTS[k]);
    store.set(k, cfg[k]);
  }
  render(); toast('Nustatymai išsaugoti.');
});

const device = /iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'ios' : /Android/i.test(navigator.userAgent) ? 'android' : 'windows';
$('helpBtn').onclick = () => {
  document.querySelectorAll('#help details[data-dev]').forEach(d => d.open = d.dataset.dev === device);
  $('help').showModal();
};
$('helpClose').onclick = () => $('help').close();
$('verInfo').textContent = 'Programos versija: ' + APP_VERSION;
$('verFoot').textContent = 'Versija ' + APP_VERSION;

$('welcomeOk').onclick = () => { cfg.welcomed = true; store.set('welcomed', true); $('welcome').close(); };
$('permBtn').onclick = async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(t => t.stop());
    $('permBtn').textContent = 'Mikrofonas leidžiamas ✓'; $('permBtn').disabled = true;
  } catch { $('permBtn').textContent = 'Mikrofonas neleistas – žr. „Pagalba“'; }
};

/* ================= Diegimas (PWA) ================= */
let deferredPrompt = null;
const localRun = location.hostname === 'localhost' || location.hostname === '127.0.0.1';  // paleista per darbalaukio piktogramą
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); if (localRun) return; deferredPrompt = e; $('installBtn').hidden = false; });
window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; toast('Programa įdiegta. Ją rasite darbalaukyje arba programų sąraše.'); });
// Įdiegimo instrukcija pagal telefoną ir naršyklę
const UA = navigator.userAgent;
const INAPP = /FBAN|FBAV|FB_IAB|Instagram|Messenger|Line\/|GSA\/|Teams|Outlook|; wv\)/i.test(UA);
function installSteps() {
  if (INAPP) return { title: 'Atidarykite naršyklėje', warn: 'Nuoroda atidaryta kitos programėlės viduje (pvz., Messenger, Gmail, Teams). Iš čia įdiegti neįmanoma.',
    steps: IS_IOS ? ['Paspauskite <b>Kopijuoti nuorodą</b> žemiau.', 'Atidarykite <b>Safari</b>.', 'Įklijuokite nuorodą į adreso juostą ir atidarykite.', 'Tada dar kartą paspauskite <b>Įdiegti</b>.']
                  : ['Viršuje dešinėje paspauskite <b>⋮</b> (trys taškai).', 'Pasirinkite <b>Atidaryti naršyklėje</b> / <b>Open in Chrome</b>.', 'Tada dar kartą paspauskite <b>Įdiegti</b>.'] };
  if (IS_IOS && /CriOS|FxiOS|EdgiOS/i.test(UA)) return { title: 'Įdiegimas iPhone', warn: 'iPhone programą patikimiausia įdiegti per Safari.',
    steps: ['Paspauskite <b>Kopijuoti nuorodą</b> žemiau.', 'Atidarykite <b>Safari</b> ir įklijuokite nuorodą.', 'Apačioje paspauskite <b>Bendrinti</b> (kvadratas su rodykle aukštyn).', 'Slinkite žemyn ir pasirinkite <b>Į pradžios ekraną</b> (Add to Home Screen).', 'Paspauskite <b>Pridėti</b>.'] };
  if (IS_IOS) return { title: 'Įdiegimas iPhone',
    steps: ['Ekrano apačioje paspauskite <b>Bendrinti</b> (kvadratas su rodykle aukštyn). Jei apačioje mygtukų nematote – bakstelėkite ekrano apačią.', 'Slinkite žemyn ir pasirinkite <b>Į pradžios ekraną</b> (Add to Home Screen).', 'Paspauskite <b>Pridėti</b> viršuje dešinėje.', 'Programą atidarykite iš pradžios ekrano piktogramos <b>Transkriptorius</b>.'] };
  if (/SamsungBrowser/i.test(UA)) return { title: 'Įdiegimas (Samsung naršyklė)',
    steps: ['Apačioje paspauskite <b>≡</b> (meniu).', 'Pasirinkite <b>Pridėti puslapį prie</b> → <b>Pradžios ekranas</b>.', 'Patvirtinkite <b>Pridėti</b>.'] };
  if (/Android/i.test(UA)) return { title: 'Įdiegimas Android',
    steps: ['Viršuje dešinėje paspauskite <b>⋮</b> (trys taškai).', 'Pasirinkite <b>Įdiegti programą</b> arba <b>Pridėti prie pagrindinio ekrano</b>.', 'Patvirtinkite <b>Įdiegti</b>.', 'Piktograma <b>Transkriptorius</b> atsiras telefono ekrane.'] };
  return { title: 'Įdiegimas kompiuteryje',
    steps: ['Adreso juostos dešinėje paspauskite piktogramą su rodykle (Įdiegti) arba naršyklės meniu → <b>Įdiegti Transkriptorius</b>.', 'Patvirtinkite <b>Įdiegti</b>.'] };
}
function showInstallHelp() {
  const i = installSteps();
  $('instTitle').textContent = i.title;
  $('instWarn').hidden = !i.warn; $('instWarn').textContent = i.warn || '';
  $('instSteps').innerHTML = i.steps.map((t, n) => `<li><span class="num">${n + 1}</span><div>${t}</div></li>`).join('') +
    '<li><span class="num">i</span><div>Įdiegti <b>nebūtina</b> – programa visiškai veikia ir tiesiog naršyklėje. Telefonas neleidžia programai įsidiegti pačiai, todėl tai daroma per naršyklės meniu.</div></li>';
  $('install').showModal();
}
$('instCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(location.href.split('#')[0]); $('instCopy').textContent = 'Nuoroda nukopijuota ✓'; }
  catch { prompt('Nukopijuokite nuorodą:', location.href); }
};
$('instClose').onclick = () => $('install').close();
$('installBtn').onclick = async () => {
  if (!deferredPrompt) return showInstallHelp();
  deferredPrompt.prompt(); const r = await deferredPrompt.userChoice; deferredPrompt = null;
  if (r.outcome === 'accepted') $('installBtn').hidden = true;
};
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (IS_MOBILE && !standalone && !localRun) $('installBtn').hidden = false;   // telefone mygtukas rodomas visada
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
  // Atsiradus naujai versijai – programa persikrauna pati (bet ne įrašymo metu)
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    if (running) { toast('Yra nauja programos versija – ji įsijungs sustabdžius įrašymą ir perkrovus.'); return; }
    reloading = true; location.reload();
  });
}

/* ================= Paleidimas ================= */
segments = segments.filter(s => Array.isArray(s.parts));
segments.forEach(s => { s.closed = true; s.trChunks = (s.trChunks || []).map(c => c.state === 'pending' ? { ...c, state: 'error', tr: 'nutrauktas' } : c); });
if (IS_IOS) el.modeBtns[0].querySelector('small').textContent = 'iPhone – veikia nepatikimai';
if (!(window.SpeechRecognition || window.webkitSpeechRecognition) && cfg.engine === 'browser') {
  el.modeBtns[0].querySelector('small').textContent = 'šioje naršyklėje neveikia';
}
if (!canMeeting) { $('sourceRow').hidden = true; if (cfg.source === 'meeting') cfg.source = 'mic'; }
setMode(cfg.engine);
setSource(cfg.source);
if (cfg.source === 'mic' && cfg.engine === 'openai' && !cfg.apiKey) setMode('browser');
el.timer.textContent = fmt(0);
if (location.protocol === 'file:') toast('Programa atidaryta kaip failas – mikrofonas neveiks. Naudokite nuorodą arba darbalaukio piktogramą.', 15000);
render();
if (!cfg.welcomed) $('welcome').showModal();
