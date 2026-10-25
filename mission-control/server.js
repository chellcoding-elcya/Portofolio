#!/usr/bin/env node
'use strict';
/*
 * Mission Control — server.js
 * Node.js TANPA dependensi eksternal (http, fs, path, os, child_process).
 * Jalan di 127.0.0.1:3001. Semua data nyata: ledger JSONL + /proc + file cron.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 3001;
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const HOME = os.homedir();
const WORKSPACE = path.join(HOME, 'workspace');

/* ------------------------------------------------------------------ roster */
const ROSTER = [
  { id: 'anca', name: 'Anca', role: 'Project Manager / General', color: '#8b93a7', accent: '#c7ccd8',
    capabilities: ['Koordinasi tugas', 'Perencanaan', 'Delegasi ke agent lain', 'Ringkasan & laporan'] },
  { id: 'mu', name: 'Mu', role: 'Graphic Designer', color: '#7c5cbf', accent: '#a78bfa',
    capabilities: ['Desain grafis', 'Ilustrasi', 'Branding', 'Layout'] },
  { id: 'cipu', name: 'Cipu', role: 'Video Editor', color: '#b3402f', accent: '#e2543e',
    capabilities: ['Edit video', 'Caption & subtitle', 'Rough cut', 'Render & ekspor'] },
  { id: 'jaka', name: 'Jaka', role: 'QC Visual', color: '#3e6b8f', accent: '#5b9bd5',
    capabilities: ['Review visual', 'Cek kualitas gambar/video', 'Deteksi cacat visual'] },
  { id: 'tono', name: 'Tono', role: 'Riset', color: '#4a7a57', accent: '#6ab07d',
    capabilities: ['Riset web', 'Riset pasar', 'Fakta & sumber', 'Ringkasan temuan'] },
  { id: 'dani', name: 'Dani', role: 'Coding', color: '#4a5568', accent: '#e8a33d',
    capabilities: ['Menulis kode', 'Debugging', 'Otomasi & skrip', 'Review kode'] },
];
const ROSTER_IDS = new Set(ROSTER.map(a => a.id));

/* Anak buah tetap per agent inti (keputusan Bos 2026-10-24; detail di STRUKTUR-TIM.md).
 * id anak buah dipakai di field `subagent` ledger tasks.jsonl. */
const SUBORDINATES = {
  anca: [
    { id: 'anca-1', name: 'Anca-1', role: 'Perencana' },
    { id: 'anca-2', name: 'Anca-2', role: 'Pencatat' },
    { id: 'anca-3', name: 'Anca-3', role: 'Pemantau' },
  ],
  mu: [
    { id: 'mu-1', name: 'Mu-1', role: 'Konsep' },
    { id: 'mu-2', name: 'Mu-2', role: 'Eksekutor' },
    { id: 'mu-3', name: 'Mu-3', role: 'Variasi' },
  ],
  cipu: [
    { id: 'cipu-1', name: 'Cipu-1', role: 'Animasi' },
    { id: 'cipu-2', name: 'Cipu-2', role: 'Audio' },
    { id: 'cipu-3', name: 'Cipu-3', role: 'Perakit' },
  ],
  jaka: [
    { id: 'jaka-1', name: 'Jaka-1', role: 'Cek Detail' },
    { id: 'jaka-2', name: 'Jaka-2', role: 'Cek Konsistensi' },
    { id: 'jaka-3', name: 'Jaka-3', role: 'Cek Akhir' },
  ],
  tono: [
    { id: 'tono-1', name: 'Tono-1', role: 'Pencari' },
    { id: 'tono-2', name: 'Tono-2', role: 'Pembaca' },
    { id: 'tono-3', name: 'Tono-3', role: 'Pembanding' },
  ],
  dani: [
    { id: 'dani-1', name: 'Dani-1', role: 'Builder' },
    { id: 'dani-2', name: 'Dani-2', role: 'Penguji' },
    { id: 'dani-3', name: 'Dani-3', role: 'Perapi' },
  ],
};

/* ------------------------------------------------------------------ util */
function nowWIB() {
  // WIB = UTC+7, tanpa DST — aman diformat manual dari UTC.
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+07:00`;
}
function readText(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
}
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function readJSONL(file) {
  const out = [];
  for (const line of readText(file).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { const o = JSON.parse(s); if (o && typeof o === 'object') out.push(o); } catch { /* baris rusak di-skip */ }
  }
  return out;
}
function pageSize() {
  try { return parseInt(require('child_process').execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim(), 10) || 4096; }
  catch { return 4096; }
}
const PAGE_SIZE = pageSize();

/* ------------------------------------------------------------------ /proc */
function procMetrics() {
  const m = { load: [0, 0, 0], cores: os.cpus().length, cpu_model: '', uptime_sec: 0,
    mem_host_total: 0, mem_host_free: 0, mem_host_available: 0,
    mem_container_bytes: 0, processes: 0, page_size: PAGE_SIZE };
  const la = readText('/proc/loadavg').trim().split(/\s+/);
  if (la.length >= 3) m.load = la.slice(0, 3).map(Number);
  const cpu = readText('/proc/cpuinfo');
  const mm = cpu.match(/model name\s*:\s*(.+)/);
  if (mm) m.cpu_model = mm[1].trim();
  if (!m.cpu_model && os.cpus()[0]) m.cpu_model = os.cpus()[0].model;
  m.uptime_sec = Math.floor(Number(readText('/proc/uptime').trim().split(/\s+/)[0]) || os.uptime());
  const meminfo = {};
  for (const line of readText('/proc/meminfo').split('\n')) {
    const kv = line.match(/^(\w+):\s+(\d+)\s*kB/);
    if (kv) meminfo[kv[1]] = Number(kv[2]) * 1024;
  }
  m.mem_host_total = meminfo.MemTotal || 0;
  m.mem_host_free = meminfo.MemFree || 0;
  m.mem_host_available = meminfo.MemAvailable || 0;
  // Memory container = jumlah RSS semua proses yang terlihat di /proc (statm kolom resident).
  let rssPages = 0, procs = 0;
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter(x => /^\d+$/.test(x)); } catch { /* abaikan */ }
  for (const pid of pids) {
    try {
      const statm = fs.readFileSync(`/proc/${pid}/statm`, 'utf8').trim().split(/\s+/);
      const resident = Number(statm[1]);
      if (Number.isFinite(resident)) { rssPages += resident; procs++; }
    } catch { /* proses sudah mati / tak terbaca */ }
  }
  m.mem_container_bytes = rssPages * PAGE_SIZE;
  m.processes = procs;
  return m;
}
function diskInfo() {
  try {
    const s = fs.statfsSync('/');
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    const used = total - free;
    return { mount: '/', total, free, used, pct: total ? Math.round(used / total * 1000) / 10 : 0 };
  } catch { return { mount: '/', total: 0, free: 0, used: 0, pct: 0 }; }
}
function osInfo() {
  let pretty = os.type();
  const rel = readText('/etc/os-release');
  const mm = rel.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
  if (mm) pretty = mm[1];
  return { pretty, kernel: os.release(), arch: os.arch(), hostname: os.hostname() };
}

/* ------------------------------------------------------------------ ledger */
function buildAgents(tasks, queue) {
  const state = readJSON(path.join(DATA, 'agent_state.json'), {});
  const dispatch = readJSON(path.join(DATA, 'dispatch.json'), { paused: false });
  // Task terakhir per task_id menentukan status aktif.
  const latest = new Map();
  for (const t of tasks) if (t.task_id) latest.set(t.task_id, t);
  // Portofolio = task unik yang status terakhirnya done, terbaru dulu (data nyata dari ledger).
  const doneSorted = [...latest.values()]
    .filter(t => t.status === 'done')
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  const portfolioOf = pred => doneSorted.filter(pred).map(t => ({
    task_id: t.task_id, title: t.title || t.task_id, ts: t.ts, detail: t.detail || '' }));
  return ROSTER.map(r => {
    let active = null;
    for (const t of latest.values()) {
      if (t.agent === r.id && (t.status === 'started' || t.status === 'progress')) {
        if (!active || String(t.ts) > String(active.ts)) active = t;
      }
    }
    const queued = queue.filter(q => q.agent === r.id && q.status === 'queued').length;
    const paused = Boolean(dispatch.paused || (state[r.id] && state[r.id].paused));
    // Anak buah: working bila ada task ledger dengan subagent-nya yang sedang berjalan;
    // portofolionya dari task done yang subagent-nya dia (awalnya kosong = masih standby).
    const subordinates = (SUBORDINATES[r.id] || []).map(s => {
      let sActive = null;
      for (const t of latest.values()) {
        if (t.subagent === s.id && (t.status === 'started' || t.status === 'progress')) {
          if (!sActive || String(t.ts) > String(sActive.ts)) sActive = t;
        }
      }
      const sPortfolio = portfolioOf(t => t.subagent === s.id);
      return { id: s.id, name: s.name, role: s.role, color: r.color, accent: r.accent,
        status: paused ? 'paused' : (sActive ? 'working' : 'idle'), paused,
        active_task: sActive, portfolio: sPortfolio.slice(0, 8), portfolio_total: sPortfolio.length };
    });
    const portfolio = portfolioOf(t => t.agent === r.id);
    return { id: r.id, name: r.name, role: r.role, color: r.color, accent: r.accent,
      capabilities: r.capabilities, status: paused ? 'paused' : (active ? 'working' : 'idle'),
      paused, active_task: active, queued_count: queued,
      portfolio: portfolio.slice(0, 8), portfolio_total: portfolio.length, subordinates };
  });
}

/* ------------------------------------------------------------------ YAML mini + schedules */
function stripQuotes(v) {
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}
function parseFrontmatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  const block = text.slice(3, end);
  const root = {};
  let parent = null; // nama key induk (indent 0) yang sedang menampung sub-key
  for (const raw of block.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const line = raw.trim();
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    // buang komentar inline " # ..." hanya di luar quote sederhana
    if (val && !val.startsWith('"') && !val.startsWith("'")) {
      const hash = val.indexOf(' #');
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    if (indent === 0) {
      if (val === '') { root[key] = {}; parent = key; }
      else { root[key] = stripQuotes(val); parent = null; }
    } else if (parent && typeof root[parent] === 'object') {
      root[parent][key] = stripQuotes(val);
    }
  }
  return root;
}
const ID_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
function parseEvery(every) {
  if (!every) return 0;
  const m = String(every).trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!m) return 0;
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2].toLowerCase()];
  return Number(m[1]) * mult;
}
function everyLabel(every) {
  const ms = parseEvery(every);
  if (!ms) return `tiap ${every}`;
  if (ms % 86400000 === 0) return `tiap ${ms / 86400000} hari`;
  if (ms % 3600000 === 0) return `tiap ${ms / 3600000} jam`;
  if (ms % 60000 === 0) return `tiap ${ms / 60000} menit`;
  return `tiap ${Math.round(ms / 1000)} detik`;
}
function tzOffsetMs(date, tz) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const parts = {};
    for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
    const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return asUTC - Math.floor(date.getTime() / 1000) * 1000;
  } catch { return 7 * 3600000; } // fallback WIB
}
function wallToUTC(y, mo, d, h, mi, s, tz) {
  let guess = Date.UTC(y, mo, d, h, mi, s);
  for (let i = 0; i < 3; i++) guess = Date.UTC(y, mo, d, h, mi, s) - tzOffsetMs(new Date(guess), tz);
  return new Date(guess);
}
function wallParts(date, tz) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    const p = {};
    for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
    return { y: +p.year, mo: +p.month - 1, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second,
      wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
  } catch { const d = new Date(date.getTime() + 7 * 3600000);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), wd: d.getUTCDay() }; }
}
function parseTimeStr(t) {
  const m = String(t || '00:00').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  return m ? { h: +m[1], mi: +m[2], s: +(m[3] || 0) } : { h: 0, mi: 0, s: 0 };
}
function computeNext(sch, tz) {
  const now = new Date();
  if (!sch || !sch.kind) return null;
  const kind = sch.kind;
  if (kind === 'runonce') {
    if (!sch.at) return null;
    const d = new Date(sch.at.length <= 19 && !/[zZ+]/.test(sch.at.slice(10)) ? sch.at + '+07:00' : sch.at);
    if (isNaN(d) || d <= now) return null;
    return d;
  }
  if (kind === 'interval') {
    const every = parseEvery(sch.every);
    if (!every) return null;
    const anchor = sch.at ? new Date(sch.at).getTime() : 0;
    if (anchor && !isNaN(anchor)) {
      const steps = Math.floor((now.getTime() - anchor) / every) + 1;
      return new Date(anchor + Math.max(steps, 0) * every);
    }
    return new Date(now.getTime() + every);
  }
  if (kind === 'daily') {
    const { h, mi, s } = parseTimeStr(sch.time);
    const w = wallParts(now, tz);
    let cand = wallToUTC(w.y, w.mo, w.d, h, mi, s, tz);
    if (cand <= now) { const t = new Date(cand.getTime() + 86400000); const w2 = wallParts(t, tz); cand = wallToUTC(w2.y, w2.mo, w2.d, h, mi, s, tz); }
    return cand;
  }
  if (kind === 'weekly') {
    const { h, mi, s } = parseTimeStr(sch.time);
    const want = sch.weekday !== undefined ? Number(sch.weekday) : (sch.day !== undefined ? Number(sch.day) : -1);
    for (let add = 0; add < 8; add++) {
      const probe = new Date(now.getTime() + add * 86400000);
      const w = wallParts(probe, tz);
      if (want >= 0 && w.wd !== want) continue;
      const cand = wallToUTC(w.y, w.mo, w.d, h, mi, s, tz);
      if (cand > now) return cand;
      if (want < 0) return cand;
    }
    return null;
  }
  if (kind === 'monthly') {
    const { h, mi, s } = parseTimeStr(sch.time);
    const dom = sch.day ? Number(sch.day) : 1;
    for (let add = 0; add < 62; add++) {
      const probe = new Date(now.getTime() + add * 86400000);
      const w = wallParts(probe, tz);
      if (w.d !== dom) continue;
      const cand = wallToUTC(w.y, w.mo, w.d, h, mi, s, tz);
      if (cand > now) return cand;
    }
    return null;
  }
  return null;
}
function scheduleLabel(sch, tz) {
  if (!sch || !sch.kind) return 'jadwal tidak dikenal';
  const p2 = n => String(n).padStart(2, '0');
  if (sch.kind === 'runonce' && sch.at) {
    const d = new Date(sch.at.length <= 19 && !/[zZ+]/.test(sch.at.slice(10)) ? sch.at + '+07:00' : sch.at);
    if (!isNaN(d)) { const w = wallParts(d, tz); return `sekali • ${w.d} ${ID_MONTHS[w.mo]} ${w.y}, ${p2(w.h)}:${p2(w.mi)}`; }
    return 'sekali';
  }
  if (sch.kind === 'interval') return everyLabel(sch.every);
  if (sch.kind === 'daily') { const t = parseTimeStr(sch.time); return `harian • ${p2(t.h)}:${p2(t.mi)}`; }
  if (sch.kind === 'weekly') { const t = parseTimeStr(sch.time); return `mingguan • ${p2(t.h)}:${p2(t.mi)}`; }
  if (sch.kind === 'monthly') { const t = parseTimeStr(sch.time); return `bulanan • tgl ${sch.day || 1}, ${p2(t.h)}:${p2(t.mi)}`; }
  return sch.kind;
}
const KNOWN_SYSTEM_IDS = new Set(['heartbeat', 'agentic-feature-tour']);
function collectSchedules() {
  const roots = [path.join(WORKSPACE, 'cron.d')];
  const goalsDir = path.join(WORKSPACE, 'goals');
  try {
    for (const g of fs.readdirSync(goalsDir)) {
      for (const sub of ['crons', 'cron.d', 'cron']) {
        const p = path.join(goalsDir, g, sub);
        if (fs.existsSync(p)) roots.push(p);
      }
    }
  } catch { /* belum ada goals */ }
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith('.md')) files.push(full);
    }
  };
  for (const r of roots) walk(r, 0);
  const out = [];
  for (const f of files) {
    try {
      const fm = parseFrontmatter(fs.readFileSync(f, 'utf8'));
      if (!fm || !fm.id) continue;
      const sch = (fm.schedule && typeof fm.schedule === 'object') ? fm.schedule : {};
      const meta = (fm.metadata && typeof fm.metadata === 'object') ? fm.metadata : {};
      const tz = sch.timezone || 'Asia/Jakarta';
      const next = fm.enabled === 'false' || fm.enabled === false ? null : computeNext(sch, tz);
      const isSystem = meta.created_by === 'system' || KNOWN_SYSTEM_IDS.has(fm.id) ||
        (typeof fm.owner === 'string' && fm.owner.startsWith('system'));
      out.push({ id: fm.id, title: fm.title || fm.id, enabled: !(fm.enabled === 'false' || fm.enabled === false),
        owner: fm.owner || null, mode: fm.mode || null, kind: sch.kind || null,
        label: scheduleLabel(sch, tz), timezone: tz, next_iso: next ? next.toISOString() : null,
        is_system: Boolean(isSystem), source: path.relative(HOME, f) });
    } catch { /* file rusak di-skip tanpa crash */ }
  }
  out.sort((a, b) => (a.is_system - b.is_system) || String(a.title).localeCompare(String(b.title)));
  return out;
}

/* ------------------------------------------------------------------ token */
let tokenCache = { at: 0, data: null };
function getTokenStatus(cb) {
  if (tokenCache.data && Date.now() - tokenCache.at < 60000) return cb(tokenCache.data);
  execFile('subscription-status', ['status'], { timeout: 6000 }, (err, stdout) => {
    let data;
    if (err && !stdout) {
      data = { available: false, placeholder: true,
        message: 'Perintah subscription-status tidak tersedia/gagal. Sambungkan di sini: parse output `subscription-status status` (persen pemakaian + waktu reset).' };
    } else {
      const text = String(stdout || '');
      const pct = text.match(/Usage:\s*([\d.]+)%/i);
      const reset = text.match(/resets\s+(.+)/i);
      const plan = text.match(/does not have a subscription/i) ? 'Tanpa langganan berbayar (paket gratis)'
        : (text.match(/plan[:\s]+(.+)/i) || [])[1] || null;
      data = { available: Boolean(pct), placeholder: !pct,
        usage_percent: pct ? Number(pct[1]) : null,
        reset_text: reset ? reset[1].trim() : null, plan,
        message: pct ? null : 'Format output subscription-status tidak dikenali — tampilkan raw di server untuk disambung.' };
    }
    tokenCache = { at: Date.now(), data };
    cb(data);
  });
}

/* ------------------------------------------------------------------ tunnel */
let tunnelCache = { at: 0, online: false, url: null };
function checkTunnel(cb) {
  const url = readText(path.join(ROOT, 'PUBLIC_URL.txt')).trim();
  if (!url) { tunnelCache = { at: Date.now(), online: false, url: null }; return cb(tunnelCache); }
  if (tunnelCache.url === url && Date.now() - tunnelCache.at < 20000) return cb(tunnelCache);
  let done = false;
  const finish = online => { if (done) return; done = true; tunnelCache = { at: Date.now(), online, url }; cb(tunnelCache); };
  try {
    const u = new URL(url + '/api/health');
    const lib = u.protocol === 'https:' ? require('https') : http;
    const req = lib.get(u, { timeout: 3500 }, res => { res.resume(); finish(res.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); finish(false); });
    req.on('error', () => finish(false));
  } catch { finish(false); }
}
function watchdogLast() {
  const lines = readJSONL(path.join(ROOT, 'watchdog-history.jsonl'));
  if (lines.length) return lines[lines.length - 1];
  try { const st = fs.statSync(path.join(ROOT, 'watchdog-history.jsonl')); return { ts: new Date(st.mtimeMs).toISOString(), event: 'history-file' }; }
  catch { return null; }
}

/* ------------------------------------------------------------------ state */
function buildState(cb) {
  const tasksAll = readJSONL(path.join(DATA, 'tasks.jsonl'));
  const queueAll = readJSONL(path.join(DATA, 'queue.jsonl'));
  const dispatch = readJSON(path.join(DATA, 'dispatch.json'), { paused: false });
  const proc = procMetrics();
  const disk = diskInfo();
  const osi = osInfo();
  getTokenStatus(token => {
    checkTunnel(tunnel => {
      const tasks = tasksAll.slice(-200);
      const logLines = [];
      for (const t of tasksAll.slice(-80)) logLines.push(`[${t.ts || '?'}] ${t.agent || '?'} ${t.status || '?'} — ${t.title || t.task_id || ''}${t.detail ? ' · ' + t.detail : ''}`);
      for (const q of queueAll.slice(-20)) logLines.push(`[${q.ts || '?'}] queue ${q.status || '?'} → ${q.agent || '?'}: ${q.prompt || ''}`);
      const wd = watchdogLast();
      cb({
        ok: true, fetched_at: nowWIB(), server_ts: new Date().toISOString(),
        roster: ROSTER,
        agents: buildAgents(tasksAll, queueAll),
        queue: queueAll.slice(-100),
        queue_queued_count: queueAll.filter(q => q.status === 'queued').length,
        tasks, tasks_total: tasksAll.length,
        dispatch_paused: Boolean(dispatch.paused),
        system: { load: proc.load, cores: proc.cores, cpu_model: proc.cpu_model, uptime_sec: proc.uptime_sec,
          mem_host_total: proc.mem_host_total, mem_host_available: proc.mem_host_available,
          mem_container_bytes: proc.mem_container_bytes, processes: proc.processes, hostname: osi.hostname },
        vps: { disk, cpu: { model: proc.cpu_model, cores: proc.cores, load: proc.load },
          memory_container: { used_bytes: proc.mem_container_bytes, processes: proc.processes, page_size: proc.page_size,
            host_total: proc.mem_host_total, host_available: proc.mem_host_available },
          uptime_sec: proc.uptime_sec,
          tunnel: { url: tunnel.url, online: tunnel.online, checked_at: new Date(tunnelCache.at).toISOString() },
          os: osi, watchdog_last: wd },
        schedules: collectSchedules(),
        token,
        public_url: tunnel.url,
        log: logLines.slice(-120),
      });
    });
  });
}

/* ------------------------------------------------------------------ HTTP */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, cb) {
  let size = 0; const chunks = [];
  req.on('data', c => { size += c.length; if (size > 65536) { req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { cb(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { cb(null); } });
  req.on('error', () => cb(null));
}
/* ------------------------------------------------------------------ webhook MetaKit */
// Endpoint penerima event MetaKit (jurnal trading otomatis). URL berisi token
// acak sebagai kunci bersama; event mentah diantrekan ke data/webhook-events.jsonl
// untuk diproses pipa mt5-sync ke Google Sheets.
function webhookToken() {
  return readText(path.join(DATA, 'webhook-token.txt')).trim();
}
function readRawBody(req, cb) {
  let size = 0; const chunks = [];
  req.on('data', c => { size += c.length; if (size > 262144) { req.destroy(); } else chunks.push(c); });
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
  req.on('error', () => cb(''));
}
function handleMetakitWebhook(req, res) {
  readRawBody(req, raw => {
    let body = null;
    try { body = JSON.parse(raw || '{}'); } catch { /* simpan mentah apa adanya */ }
    const rec = { received_at: nowWIB(),
      event: req.headers['x-metakit-event'] || (body && body.event) || null,
      signature: req.headers['x-metakit-signature'] || null,
      body: body !== null ? body : raw };
    try { fs.appendFileSync(path.join(DATA, 'webhook-events.jsonl'), JSON.stringify(rec) + '\n'); }
    catch { return sendJSON(res, 500, { ok: false, error: 'gagal antre' }); }
    return sendJSON(res, 200, { ok: true });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  if (p === '/api/health') return sendJSON(res, 200, { ok: true, ts: nowWIB() });
  if (req.method === 'POST' && p.startsWith('/hooks/metakit/')) {
    const tok = p.slice('/hooks/metakit/'.length);
    if (!tok || tok !== webhookToken()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404 tidak ditemukan'); }
    return handleMetakitWebhook(req, res);
  }
  if (p === '/api/state' && req.method === 'GET') return buildState(state => sendJSON(res, 200, state));
  if (p === '/api/equity' && req.method === 'GET') {
    const eq = readJSON(path.join(DATA, 'metakit-equity.json'), null);
    if (!eq) return sendJSON(res, 200, { available: false });
    return sendJSON(res, 200, Object.assign({ available: true }, eq));
  }
  if (p === '/api/queue' && req.method === 'POST') return readBody(req, body => {
    if (!body || !body.prompt || typeof body.prompt !== 'string') return sendJSON(res, 400, { ok: false, error: 'prompt wajib diisi' });
    const agent = ROSTER_IDS.has(body.agent) ? body.agent : null;
    if (!agent) return sendJSON(res, 400, { ok: false, error: 'agent tidak dikenal; pakai id roster: ' + [...ROSTER_IDS].join(', ') });
    const item = { ts: nowWIB(), prompt: body.prompt.slice(0, 500), agent, status: 'queued' };
    fs.appendFileSync(path.join(DATA, 'queue.jsonl'), JSON.stringify(item) + '\n');
    return sendJSON(res, 200, { ok: true, item });
  });
  if (p === '/api/dispatch' && req.method === 'POST') return readBody(req, body => {
    if (!body || typeof body.paused !== 'boolean') return sendJSON(res, 400, { ok: false, error: 'paused harus boolean' });
    fs.writeFileSync(path.join(DATA, 'dispatch.json'), JSON.stringify({ paused: body.paused }) + '\n');
    return sendJSON(res, 200, { ok: true, paused: body.paused });
  });
  if (p === '/api/agent-pause' && req.method === 'POST') return readBody(req, body => {
    if (!body || !ROSTER_IDS.has(body.agent) || typeof body.paused !== 'boolean') return sendJSON(res, 400, { ok: false, error: 'agent/paused tidak valid' });
    const state = readJSON(path.join(DATA, 'agent_state.json'), {});
    state[body.agent] = { paused: body.paused, ts: nowWIB() };
    fs.writeFileSync(path.join(DATA, 'agent_state.json'), JSON.stringify(state, null, 1) + '\n');
    return sendJSON(res, 200, { ok: true, agent: body.agent, paused: body.paused });
  });
  if (req.method !== 'GET') return sendJSON(res, 405, { ok: false, error: 'method tidak didukung' });
  // statis — whitelist: hanya index.html + vendor/ (jangan ekspos data/, *.sh, *.log, source)
  let rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  if (!(rel === 'index.html' || rel.startsWith('vendor/'))) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404 tidak ditemukan');
  }
  const full = path.normalize(path.join(ROOT, rel));
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404 tidak ditemukan');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(full).pipe(res);
});
server.listen(PORT, HOST, () => {
  console.log(`Mission Control jalan di http://${HOST}:${PORT} — ${nowWIB()}`);
});
// Listener loopback IPv6 tambahan: devtunnel meneruskan koneksi ke "localhost"
// yang bisa ter-resolve ke ::1 — tanpa ini tunnel publik menabrak pintu kosong.
const server6 = http.createServer();
server6.on('request', (req, res) => server.emit('request', req, res));
server6.on('error', () => { /* IPv6 tidak tersedia — abaikan, IPv4 tetap utama */ });
try { server6.listen(PORT, '::1'); } catch { /* abaikan */ }
