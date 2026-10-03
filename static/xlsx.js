/* Spreadsheets, the engine: zip, number formats, formulas and their
   calculation, the workbook model (SheetBook) and xlsx in both directions.
   xlsx files are only read here (XlsxBook); editing happens in ods (ods.js),
   and XlsxOut writes a fresh xlsx from any workbook, for export.
   Formulas: + - * / ^ & % and comparisons, references and ranges (also to
   other sheets) and the functions in FN. A formula with anything else keeps
   the result the file has. */
'use strict';

/* ---- zip (no zip64, no encryption: what office files use) ---- */
const ZIP = {
  table: null,
  crc(b) {
    let t = ZIP.table;
    if (!t) {
      t = ZIP.table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  },

  /* the entries, from the central directory; data stays compressed */
  read(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let e = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('not a spreadsheet file (no zip directory)');
    const n = dv.getUint16(e + 10, true);
    let p = dv.getUint32(e + 16, true);
    if (n === 0xFFFF || p === 0xFFFFFFFF) throw new Error('zip64 files are not supported');
    const dec = new TextDecoder(), out = [];
    for (let k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('broken zip directory');
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      const f = {
        made: dv.getUint16(p + 4, true), flags: dv.getUint16(p + 8, true), method: dv.getUint16(p + 10, true),
        time: dv.getUint16(p + 12, true), date: dv.getUint16(p + 14, true), crc: dv.getUint32(p + 16, true),
        csize: dv.getUint32(p + 20, true), size: dv.getUint32(p + 24, true),
        iattr: dv.getUint16(p + 36, true), eattr: dv.getUint32(p + 38, true),
        name: dec.decode(b.subarray(p + 46, p + 46 + nl)),
      };
      if (f.flags & 1) throw new Error('encrypted files are not supported');
      const lo = dv.getUint32(p + 42, true);
      if (dv.getUint32(lo, true) !== 0x04034b50) throw new Error('broken zip entry ' + f.name);
      const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
      f.data = b.subarray(start, start + f.csize);
      out.push(f);
      p += 46 + nl + xl + cl;
    }
    return out;
  },

  async inflate(f) {
    if (f.method === 0) return f.data;
    if (f.method !== 8) throw new Error(f.name + ': unknown compression');
    return new Uint8Array(await new Response(new Blob([f.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  },

  /* now, as DOS time and date */
  stamp() {
    const d = new Date();
    return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
  },
  /* old with new content */
  async entry(old, raw) {
    const data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    return Object.assign({}, old, { method: 8, data, crc: ZIP.crc(raw), csize: data.length, size: raw.length }, ZIP.stamp());
  },
  /* a new entry, deflated; store: kept as it is (an ods mimetype must be) */
  async add(name, raw, store) {
    if (typeof raw === 'string') raw = new TextEncoder().encode(raw);
    const f = { made: 20, flags: /^[\x20-\x7e]*$/.test(name) ? 0 : 0x800, iattr: 0, eattr: 0, name };
    if (!store) return ZIP.entry(f, raw);
    return Object.assign(f, { method: 0, data: raw, crc: ZIP.crc(raw), csize: raw.length, size: raw.length }, ZIP.stamp());
  },

  /* sizes go in the headers, so no data descriptors (flag bit 3) */
  write(files) {
    const enc = new TextEncoder(), names = files.map(f => enc.encode(f.name));
    let size = 22;
    files.forEach((f, i) => { size += 76 + 2 * names[i].length + f.data.length; });
    const out = new Uint8Array(size), dv = new DataView(out.buffer), offs = [];
    const head = (p, f, i) => {
      dv.setUint16(p, f.flags & ~8, true); dv.setUint16(p + 2, f.method, true);
      dv.setUint16(p + 4, f.time, true); dv.setUint16(p + 6, f.date, true); dv.setUint32(p + 8, f.crc, true);
      dv.setUint32(p + 12, f.csize, true); dv.setUint32(p + 16, f.size, true); dv.setUint16(p + 20, names[i].length, true);
    };
    let p = 0;
    files.forEach((f, i) => {
      offs.push(p);
      dv.setUint32(p, 0x04034b50, true); dv.setUint16(p + 4, 20, true); head(p + 6, f, i);
      out.set(names[i], p + 30);
      out.set(f.data, p + 30 + names[i].length);
      p += 30 + names[i].length + f.data.length;
    });
    const cd = p;
    files.forEach((f, i) => {
      dv.setUint32(p, 0x02014b50, true); dv.setUint16(p + 4, f.made, true); dv.setUint16(p + 6, 20, true); head(p + 8, f, i);
      dv.setUint16(p + 36, f.iattr, true); dv.setUint32(p + 38, f.eattr, true); dv.setUint32(p + 42, offs[i], true);
      out.set(names[i], p + 46);
      p += 46 + names[i].length;
    });
    dv.setUint32(p, 0x06054b50, true); dv.setUint16(p + 8, files.length, true); dv.setUint16(p + 10, files.length, true);
    dv.setUint32(p + 12, p - cd, true); dv.setUint32(p + 16, cd, true);
    return out;
  },
};

/* ---- cells and XML ---- */
const XNS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const XNS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MAXC = 16384, MAXR = 1048576;

function xkid(el, name) { for (let c = el ? el.firstElementChild : null; c; c = c.nextElementSibling) if (c.localName === name) return c; return null; }
function xkids(el, name) { const o = []; for (let c = el ? el.firstElementChild : null; c; c = c.nextElementSibling) if (c.localName === name) o.push(c); return o; }
function colOf(s) { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; }
function cellAt(s) { const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(s || ''); return m ? { r: +m[2] - 1, c: colOf(m[1]) } : null; }
function refOf(r, c) { return CSV.colName(c) + (r + 1); }
/* a relationship target, from the folder of the part that has it */
function partPath(dir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const out = [];
  for (const s of (dir + target).split('/')) { if (s === '..') out.pop(); else if (s !== '.' && s !== '') out.push(s); }
  return out.join('/');
}
/* text of a shared string or inline string: plain, or runs of rich text */
function siText(si) {
  const t = xkid(si, 't');
  const s = t ? t.textContent : xkids(si, 'r').map(r => { const x = xkid(r, 't'); return x ? x.textContent : ''; }).join('');
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (m, x) => String.fromCharCode(parseInt(x, 16)));
}
function round15(x) { return +x.toPrecision(15); }

class XErr { constructor(e) { this.e = e; } }
const E = { div: '#DIV/0!', na: '#N/A', name: '#NAME?', num: '#NUM!', ref: '#REF!', value: '#VALUE!', circ: '#CIRC!' };

/* ---- dates: serial numbers, day 1 = 1900-01-01, with Excel's 1900-02-29 ---- */
const XDate = {
  parts(v, d1904, ms) {
    let days = Math.floor(v), t = (v - days) * 864e5;
    t = ms ? Math.round(t) : Math.round(t / 1000) * 1000;
    const base = d1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, days < 60 ? 31 : 30);
    const d = new Date(base + days * 864e5 + t);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: d.getUTCDay(),
      H: d.getUTCHours(), Mi: d.getUTCMinutes(), S: d.getUTCSeconds(), ms: d.getUTCMilliseconds() };
  },
  serial(y, mo, d, H, Mi, S, d1904) {
    let days = Math.round((Date.UTC(y, mo - 1, d) - Date.UTC(1899, 11, 30)) / 864e5);
    if (d1904) days -= 1462; else if (days < 61) days--;
    return days + ((H || 0) * 3600 + (Mi || 0) * 60 + (S || 0)) / 86400;
  },
  /* how a date cell reads in the editor: 2025-06-26, 2025-06-26 14:30, 14:30 */
  iso(v, d1904, kind) {
    if (!(v >= 0 && v < 2958466)) return String(v);
    const p = XDate.parts(v, d1904);
    const time = pad2(p.H) + ':' + pad2(p.Mi) + (p.S ? ':' + pad2(p.S) : '');
    if (kind === 'time' && v < 1) return time;
    const date = p.y + '-' + pad2(p.mo) + '-' + pad2(p.d);
    return p.H || p.Mi || p.S ? date + ' ' + time : date;
  },
};

/* what typed text means: {k: '' | 'n' | 's' | 'b' | 'e' | 'f', v, fmt}; fmt: for dates, times and percentages, a format that shows them as typed */
function typed(raw, d1904) {
  if (!raw) return { k: '' };
  if (raw[0] === "'") return { k: 's', v: raw.slice(1) };
  if (raw[0] === '=' && raw.length > 1) return { k: 'f', v: raw.slice(1) };
  const t = raw.trim();
  if (!t) return { k: 's', v: raw };
  if (/^(true|false)$/i.test(t)) return { k: 'b', v: /^t/i.test(t) };
  if (/^#(DIV\/0!|N\/A|NAME\?|NULL!|NUM!|REF!|VALUE!)$/i.test(t)) return { k: 'e', v: t.toUpperCase() };
  const n = CSV.num(t);
  if (!isNaN(n)) {
    if (!t.endsWith('%')) return { k: 'n', v: n };
    const dp = /[.,](\d+)\s*%$/.exec(t);
    return { k: 'n', v: round15(n / 100), fmt: '0' + (dp ? '.' + '0'.repeat(Math.min(dp[1].length, 10)) : '') + '%' };
  }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t), y, mo, d, fmt;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; fmt = 'yyyy-mm-dd'; }
  else if ((m = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4}|\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t))) {
    d = +m[1]; mo = +m[2]; y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    fmt = m[3].length === 2 ? 'd.m.yy' : 'd.m.yyyy';
  }
  if (m && y >= 1900 && mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate() &&
      (!m[4] || (+m[4] < 24 && +m[5] < 60 && (!m[6] || +m[6] < 60)))) {
    return { k: 'n', v: XDate.serial(y, mo, d, +m[4] || 0, +m[5] || 0, +m[6] || 0, d1904), fmt: fmt + (m[4] ? m[6] ? ' hh:mm:ss' : ' hh:mm' : '') };
  }
  if ((m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t)) && +m[1] < 24 && +m[2] < 60 && (!m[3] || +m[3] < 60)) {
    return { k: 'n', v: (+m[1] * 3600 + +m[2] * 60 + (+m[3] || 0)) / 86400, fmt: m[3] ? 'h:mm:ss' : 'h:mm' };
  }
  return { k: 's', v: raw };
}

/* ---- number formats ---- */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const NumFmt = {
  builtin: {
    0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
    14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss',
    22: 'm/d/yyyy h:mm', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
    45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
  },

  /* sections are split by ; outside quotes and brackets */
  sections(code) {
    const out = [];
    let cur = '', q = false, b = false;
    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      if (q) { cur += ch; if (ch === '"') q = false; continue; }
      if (ch === '\\' || ch === '_' || ch === '*') { cur += ch + (code[i + 1] || ''); i++; continue; }
      if (ch === '"') q = true;
      else if (ch === '[') b = true;
      else if (ch === ']') b = false;
      else if (ch === ';' && !b) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  },
  /* without quoted text, escapes and [..] (but [h] [mm] [ss]): what tells dates from numbers */
  bare(sec) { return sec.replace(/"[^"]*"|\\.|_.|\*./g, '').replace(/\[(?!(h+|m+|s+)\])[^\]]*\]/gi, ''); },
  /* 'date', 'time', 'datetime' or null */
  dateKind(code) {
    const s = NumFmt.bare(NumFmt.sections(code)[0]);
    if (/general/i.test(s) || !/[ymdhs]/i.test(s)) return null;
    const t = /[hs]/i.test(s), d = /[yd]/i.test(s) || /m/i.test(s.replace(/[hs][^a-z]*m+|m+[^a-z]*s/gi, ''));
    return d && t ? 'datetime' : t ? 'time' : 'date';
  },

  format(v, code, d1904) {
    if (!code || /^general$/i.test(code)) return NumFmt.general(v);
    const secs = NumFmt.sections(code);
    let sec = secs[0], neg = v < 0;
    if (v < 0 && secs.length > 1 && secs[1] !== '') { sec = secs[1]; v = -v; neg = false; }
    else if (v === 0 && secs.length > 2) sec = secs[2];
    if (/^\s*(general|@)\s*$/i.test(NumFmt.bare(sec))) return NumFmt.general(v);
    if (NumFmt.dateKind(sec)) return v < 0 || v >= 2958466 ? '#####' : NumFmt.date(v, sec, d1904);
    const s = NumFmt.number(Math.abs(v), sec);
    return neg && /[1-9]/.test(s) ? '-' + s : s;
  },

  /* up to ten digits, then exponents; like the General format */
  general(v) {
    if (!isFinite(v)) return E.num;
    const a = Math.abs(v);
    let s = a !== 0 && (a >= 1e11 || a < 1e-9) ? 'e' : String(+v.toPrecision(10));
    if (s.includes('e')) s = v.toExponential(5).replace(/\.?0+e/, 'e').replace(/e([+-])(\d)$/, 'e$10$2').toUpperCase();
    return s;
  },

  /* a number section in parts: {pre, pat, post, pct, sym, symAt, color}; sym: the [$…] currency, which is
     also in pre (at symAt) or post (at symAt - pre.length); color: [Red] and the like */
  numParts(sec) {
    let pre = '', pat = '', post = '', pct = 0, sym = null, symAt = 0, color = null, i = 0;
    const lit = s => { if (pat) post += s; else pre += s; };
    while (i < sec.length) {
      const ch = sec[i];
      if (ch === '"') { const j = sec.indexOf('"', i + 1); lit(sec.slice(i + 1, j < 0 ? undefined : j)); i = j < 0 ? sec.length : j + 1; continue; }
      if (ch === '\\') { lit(sec[i + 1] || ''); i += 2; continue; }
      if (ch === '_') { lit(' '); i += 2; continue; }
      if (ch === '*') { i += 2; continue; }
      if (ch === '[') {
        const j = sec.indexOf(']', i), inner = sec.slice(i + 1, j < 0 ? undefined : j), m = /^\$([^-]*)/.exec(inner);
        if (m) { if (sym === null && m[1]) { sym = m[1]; symAt = pre.length + post.length; } lit(m[1]); }
        else if (/^[a-z]+$/i.test(inner)) color = inner.toLowerCase();
        i = j < 0 ? sec.length : j + 1;
        continue;
      }
      if (pat && !post && (ch === 'E' || ch === 'e') && (sec[i + 1] === '+' || sec[i + 1] === '-')) {
        pat += 'E' + sec[i + 1];
        i += 2;
        while (i < sec.length && '0#?'.includes(sec[i])) pat += sec[i++];
        continue;
      }
      if ('0#?.,'.includes(ch) && !post) { pat += ch; i++; continue; }
      if (ch === '%') pct++;
      lit(ch);
      i++;
    }
    return { pre, pat, post, pct, sym, symAt, color };
  },
  /* the digits of a pattern: {minI, maxD, minD, group, factor (1000 per trailing comma), sci, minE, eng} */
  digits(pat) {
    const ei = pat.indexOf('E'), mant = ei < 0 ? pat : pat.slice(0, ei), ex = ei < 0 ? '' : pat.slice(ei + 2);
    const dot = mant.indexOf('.');
    let ip = dot < 0 ? mant : mant.slice(0, dot), factor = 1;
    const dp = dot < 0 ? '' : mant.slice(dot + 1).replace(/,/g, '');
    while (ip.endsWith(',')) { factor *= 1000; ip = ip.slice(0, -1); }
    const group = ip.includes(',');
    ip = ip.replace(/,/g, '');
    return { minI: (ip.match(/0/g) || []).length, maxD: dp.length, minD: (dp.match(/0/g) || []).length, group, factor,
      sci: ei >= 0, plus: pat[ei + 1] === '+', minE: (ex.match(/0/g) || []).length || 1, eng: ip.length > 1 ? ip.length : 1 };
  },

  number(v, sec) {
    const { pre, pat, post, pct } = NumFmt.numParts(sec);
    if (!pat) return pre + post;
    v *= Math.pow(100, pct);
    const { minI, maxD, minD, group, factor, sci, plus, minE, eng } = NumFmt.digits(pat);
    v /= factor;
    let e = 0;
    if (sci && v !== 0) {
      e = Math.floor(Math.log10(v));
      if (eng > 1) e = Math.floor(e / eng) * eng;   // engineering: ##0.0E+0
      v /= Math.pow(10, e);
      if (eng <= 1 && +v.toFixed(maxD) >= 10) { v /= 10; e++; }
    }
    const m = Math.pow(10, maxD);
    let [a, b = ''] = (Math.round(round15(v * m)) / m).toFixed(maxD).split('.');
    while (b.length > minD && b.endsWith('0')) b = b.slice(0, -1);
    if (a === '0' && minI === 0) a = '';
    while (a.length < minI) a = '0' + a;
    if (group) a = a.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    let out = a + (b ? '.' + b : '');
    if (sci) out += 'E' + (e < 0 ? '-' : plus ? '+' : '') + String(Math.abs(e)).padStart(minE, '0');
    return pre + out + post;
  },

  /* a date section as tokens: {lit} or {k: y m M (minutes) d h s f (fraction of s) ap el ([h] [mm] [ss]), n, u}, and its [Red] color */
  dateToks(sec) {
    const toks = [], low = sec.toLowerCase();
    let color = null, i = 0;
    while (i < sec.length) {
      const ch = sec[i], lc = low[i];
      if (ch === '"') { const j = sec.indexOf('"', i + 1); toks.push({ lit: sec.slice(i + 1, j < 0 ? undefined : j) }); i = j < 0 ? sec.length : j + 1; continue; }
      if (ch === '\\') { toks.push({ lit: sec[i + 1] || '' }); i += 2; continue; }
      if (ch === '_') { toks.push({ lit: ' ' }); i += 2; continue; }
      if (ch === '*') { i += 2; continue; }
      if (ch === '[') {
        const j = sec.indexOf(']', i), inner = sec.slice(i + 1, j < 0 ? undefined : j), m = /^\$([^-]*)/.exec(inner);
        if (/^(h+|m+|s+)$/i.test(inner)) toks.push({ k: 'el', u: inner[0].toLowerCase(), n: inner.length });
        else if (m) toks.push({ lit: m[1] });
        else if (/^[a-z]+$/i.test(inner)) color = inner.toLowerCase();
        i = j < 0 ? sec.length : j + 1;
        continue;
      }
      if (low.startsWith('am/pm', i)) { toks.push({ k: 'ap', n: 5 }); i += 5; continue; }
      if (low.startsWith('a/p', i)) { toks.push({ k: 'ap', n: 3 }); i += 3; continue; }
      if ('ymdhse'.includes(lc)) { let j = i; while (low[j] === lc) j++; toks.push({ k: lc === 'e' ? 'y' : lc, n: j - i }); i = j; continue; }
      if (ch === '.' && sec[i + 1] === '0' && toks.length && /^(s|el)$/.test(toks[toks.length - 1].k)) {
        let j = i + 1;
        while (sec[j] === '0') j++;
        toks.push({ k: 'f', n: j - i - 1 });
        i = j;
        continue;
      }
      toks.push({ lit: ch });
      i++;
    }
    // m right after an hour or right before seconds is minutes
    const at = toks.map((t, j) => (t.k ? j : -1)).filter(j => j >= 0);
    at.forEach((j, n) => {
      const t = toks[j];
      if (t.k !== 'm' || t.n > 2) return;
      const prev = n > 0 ? toks[at[n - 1]] : null, next = n < at.length - 1 ? toks[at[n + 1]] : null;
      if ((prev && (prev.k === 'h' || (prev.k === 'el' && prev.u === 'h'))) || (next && (next.k === 's' || (next.k === 'el' && next.u === 's')))) t.k = 'M';
    });
    return { toks, color };
  },

  date(v, sec, d1904) {
    const { toks } = NumFmt.dateToks(sec);
    const ap = toks.some(t => t.k === 'ap'), p = XDate.parts(v, d1904, toks.some(t => t.k === 'f'));
    return toks.map(t => {
      if (t.lit !== undefined) return t.lit;
      switch (t.k) {
        case 'y': return t.n <= 2 ? pad2(p.y % 100) : String(p.y);
        case 'm': return t.n === 1 ? String(p.mo) : t.n === 2 ? pad2(p.mo) : t.n === 3 ? MONTHS[p.mo - 1].slice(0, 3) : t.n === 5 ? MONTHS[p.mo - 1][0] : MONTHS[p.mo - 1];
        case 'd': return t.n === 1 ? String(p.d) : t.n === 2 ? pad2(p.d) : t.n === 3 ? WDAYS[p.wd].slice(0, 3) : WDAYS[p.wd];
        case 'h': { const x = ap ? p.H % 12 || 12 : p.H; return t.n > 1 ? pad2(x) : String(x); }
        case 'M': return t.n > 1 ? pad2(p.Mi) : String(p.Mi);
        case 's': return t.n > 1 ? pad2(p.S) : String(p.S);
        case 'f': return String(p.ms).padStart(3, '0').slice(0, t.n);
        case 'ap': return t.n === 5 ? (p.H < 12 ? 'AM' : 'PM') : (p.H < 12 ? 'A' : 'P');
        case 'el': return String(Math.floor(round15(v * (t.u === 'h' ? 24 : t.u === 'm' ? 1440 : 86400)))).padStart(t.n, '0');
      }
      return '';
    }).join('');
  },
};

/* ---- formulas ---- */
const Formula = {
  SHEET: "(?:'(?:[^']|'')+'|[\\p{L}_][\\p{L}\\p{N}_.]*)!",   // unquoted sheet names may have any letters
  lex(src) {
    const AREA = new RegExp('^(' + Formula.SHEET + ')?(\\$?)([A-Za-z]{1,3})(\\$?)(\\d+)(?::(\\$?)([A-Za-z]{1,3})(\\$?)(\\d+))?(?![\\p{L}\\p{N}_(.!])', 'u');
    const COLS = new RegExp('^(' + Formula.SHEET + ')?(\\$?)([A-Za-z]{1,3}):(\\$?)([A-Za-z]{1,3})(?![\\p{L}\\p{N}_(.!])', 'u');
    const out = [];
    let i = 0, m;
    const sheet = s => (s ? s.slice(0, -1).replace(/^'(.*)'$/, (x, y) => y.replace(/''/g, "'")) : null);
    const ok = (c, r) => c < MAXC && (r === undefined || (r >= 0 && r < MAXR));
    while (i < src.length) {
      const ch = src[i], rest = src.slice(i);
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '"') {
        let j = i + 1, s = '';
        for (;;) {
          const k = src.indexOf('"', j);
          if (k < 0) throw new Error('unclosed "');
          s += src.slice(j, k);
          if (src[k + 1] === '"') { s += '"'; j = k + 2; } else { j = k + 1; break; }
        }
        out.push({ t: 's', v: s, s: i, e: j });
        i = j;
        continue;
      }
      if ((m = /^#(DIV\/0!|N\/A|NAME\?|NULL!|NUM!|REF!|VALUE!)/i.exec(rest))) { out.push({ t: 'e', v: m[0].toUpperCase(), s: i, e: i + m[0].length }); i += m[0].length; continue; }
      if ((m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(rest))) { out.push({ t: 'n', v: +m[0], s: i, e: i + m[0].length }); i += m[0].length; continue; }
      if ((m = AREA.exec(rest))) {
        const a = { c: colOf(m[3]), r: +m[5] - 1, ac: !!m[2], ar: !!m[4] }, b = m[7] ? { c: colOf(m[7]), r: +m[9] - 1, ac: !!m[6], ar: !!m[8] } : null;
        if (ok(a.c, a.r) && (!b || ok(b.c, b.r))) {
          out.push({ t: 'a', sheet: sheet(m[1]), pre: m[1] || '', a, b, s: i, e: i + m[0].length });
          i += m[0].length;
          continue;
        }
      }
      if ((m = COLS.exec(rest)) && ok(colOf(m[3])) && ok(colOf(m[5]))) {
        out.push({ t: 'a', cols: true, sheet: sheet(m[1]), pre: m[1] || '', a: { c: colOf(m[3]), ac: !!m[2] }, b: { c: colOf(m[5]), ac: !!m[4] }, s: i, e: i + m[0].length });
        i += m[0].length;
        continue;
      }
      if ((m = /^(?:_xlfn\.|_xlws\.)?([\p{L}_\\][\p{L}\p{N}_.]*)\s*\(/u.exec(rest))) { out.push({ t: 'fn', v: m[1].toUpperCase(), s: i, e: i + m[0].length }); i += m[0].length; continue; }
      if ((m = /^[\p{L}_\\][\p{L}\p{N}_.]*/u.exec(rest))) {
        const u = m[0].toUpperCase();
        out.push(u === 'TRUE' || u === 'FALSE' ? { t: 'b', v: u === 'TRUE', s: i, e: i + m[0].length } : { t: 'name', v: m[0], s: i, e: i + m[0].length });
        i += m[0].length;
        continue;
      }
      if ((m = /^(<>|<=|>=|[-+*/^&=<>%(),;])/.exec(rest))) { out.push({ t: 'op', v: m[0] === ';' ? ',' : m[0], s: i, e: i + m[0].length }); i += m[0].length; continue; }
      throw new Error('cannot read ' + rest.slice(0, 10));
    }
    return out;
  },

  /* to a tree: comparisons < & < + - < * / < ^ < % < unary minus < operands */
  parse(src) {
    const toks = Formula.lex(src);
    let i = 0;
    const isOp = (...ops) => toks[i] && toks[i].t === 'op' && ops.includes(toks[i].v);
    const bin = (sub, ops) => () => {
      let a = sub();
      while (isOp(...ops)) { const op = toks[i++].v; a = { k: 'op', op, a, b: sub() }; }
      return a;
    };
    const primary = () => {
      const t = toks[i++];
      if (!t) throw new Error('unexpected end');
      if (t.t === 'n' || t.t === 's' || t.t === 'b' || t.t === 'e') return { k: t.t, v: t.v };
      if (t.t === 'a') return { k: 'a', t };
      if (t.t === 'name') return { k: 'name', v: t.v };
      if (t.t === 'fn') {
        const args = [];
        if (isOp(')')) { i++; return { k: 'fn', name: t.v, args }; }
        for (;;) {
          args.push(isOp(',', ')') ? { k: 'miss' } : expr());
          const s = toks[i++];
          if (!s || s.t !== 'op' || (s.v !== ',' && s.v !== ')')) throw new Error('bad arguments');
          if (s.v === ')') return { k: 'fn', name: t.v, args };
        }
      }
      if (t.t === 'op' && t.v === '(') {
        const e = expr();
        if (!isOp(')')) throw new Error('missing )');
        i++;
        return e;
      }
      throw new Error('unexpected ' + (t.v === undefined ? t.t : t.v));
    };
    const postfix = () => { let a = primary(); while (isOp('%')) { i++; a = { k: 'pct', a }; } return a; };
    const unary = () => {
      if (isOp('-')) { i++; return { k: 'neg', a: unary() }; }
      if (isOp('+')) { i++; return unary(); }
      return postfix();
    };
    const expr = bin(bin(bin(bin(bin(unary, ['^']), ['*', '/']), ['+', '-']), ['&']), ['=', '<>', '<', '>', '<=', '>=']);
    const e = expr();
    if (i < toks.length) throw new Error('unexpected ' + toks[i].v);
    return e;
  },

  /* the formula as it reads dr rows down and dc columns right: relative references move, $ ones stay */
  shift(src, dr, dc) {
    let toks;
    try { toks = Formula.lex(src); } catch (e) { return src; }
    let out = '', at = 0;
    for (const t of toks) {
      if (t.t !== 'a') continue;
      const one = p => {
        const c = p.ac ? p.c : p.c + dc, r = t.cols ? 0 : p.ar ? p.r : p.r + dr;
        if (c < 0 || c >= MAXC || r < 0 || r >= MAXR) return null;
        return (p.ac ? '$' : '') + CSV.colName(c) + (t.cols ? '' : (p.ar ? '$' : '') + (r + 1));
      };
      const a = one(t.a), b = t.b ? one(t.b) : '';
      out += src.slice(at, t.s) + (a === null || b === null ? E.ref : t.pre + a + (t.b ? ':' + b : ''));
      at = t.e;
    }
    return out + src.slice(at);
  },

  /* a sheet name as a formula has it */
  sheetRef(name) { return /^[\p{L}_][\p{L}\p{N}_.]*$/u.test(name) && !cellAt(name) ? name : "'" + name.replace(/'/g, "''") + "'"; },
  /* the formula as an xlsx file has it: , between arguments, _xlfn. on the newer functions;
     rename: lowercased sheet names that had to change on the way. null when it does not lex. */
  excel(src, rename) {
    let toks;
    try { toks = Formula.lex(src); } catch (e) { return null; }
    let out = '', at = 0;
    for (const t of toks) {
      let s = null;
      const to = t.t === 'a' && t.sheet !== null && rename ? rename.get(t.sheet.toLowerCase()) : undefined;
      if (t.t === 'op' && t.v === ',') s = ',';
      else if (t.t === 'fn' && XLFN.has(t.v) && !/^_xl/i.test(src.slice(t.s, t.e))) s = '_xlfn.' + src.slice(t.s, t.e);
      else if (to !== undefined) s = Formula.sheetRef(to) + '!' + src.slice(t.s + t.pre.length, t.e);
      if (s === null) continue;
      out += src.slice(at, t.s) + s;
      at = t.e;
    }
    return out + src.slice(at);
  },
};
/* functions Excel files keep behind _xlfn. */
const XLFN = new Set(['CONCAT', 'TEXTJOIN', 'IFS', 'SWITCH', 'MAXIFS', 'MINIFS', 'XLOOKUP', 'XMATCH', 'IFNA', 'DAYS', 'FILTER', 'SORT', 'UNIQUE', 'SEQUENCE', 'LET']);

class Area { constructor(sh, r0, c0, r1, c1) { this.sh = sh; this.r0 = r0; this.c0 = c0; this.r1 = r1; this.c1 = c1; } }
class NoFn extends Error {}
const BUSY = {};

/* values: number, string, boolean, null (empty) or XErr; results are kept per sheet until reset() */
class Calc {
  constructor(book) { this.book = book; this.asts = new Map(); this.reset(); }
  reset() { for (const sh of this.book.sheets) { sh.memo = new Map(); sh.nofn = new Set(); } this.unknown = false; }
  ast(text) {
    let a = this.asts.get(text);
    if (a === undefined) { try { a = Formula.parse(text); } catch (e) { a = null; } this.asts.set(text, a); }
    return a;
  }
  /* every formula, top to bottom, so chains down a column stay shallow */
  all() {
    for (const sh of this.book.sheets) sh.rows.forEach((row, r) => row.forEach((raw, c) => { if (raw && raw[0] === '=') this.value(sh, r, c); }));
  }

  value(sh, r, c) {
    const k = r * MAXC + c, m = sh.memo.get(k);
    if (m === BUSY) return new XErr(E.circ);
    if (m !== undefined) return m;
    const row = sh.rows[r], raw = row && row[c];
    if (!raw) return null;
    const cell = sh.cells.get(k), same = cell && raw === sh.base.get(k) ? cell : null;
    let v;
    if (same && !same.f) v = same.v;   // untouched: exactly what the file has
    else {
      const t = typed(raw, this.book.d1904);
      if (t.k === 'f') { sh.memo.set(k, BUSY); v = this.formula(sh, r, c, t.v, same); }
      else v = t.k === 'e' ? new XErr(t.v) : t.k === '' ? null : t.v;
    }
    sh.memo.set(k, v);
    return v;
  }

  formula(sh, r, c, text, same) {
    try {
      const ast = same && same.keep ? null : this.ast(text);
      if (!ast) throw new NoFn();
      let v = this.scalar(this.ev(ast, sh, r, c), r, c);
      if (v === null) v = 0;
      if (typeof v === 'number' && !isFinite(v)) v = new XErr(E.num);
      return v;
    } catch (e) {
      if (e instanceof XErr) return e;
      if (!(e instanceof NoFn)) console.warn('formula', text, e);
      if (same) { this.unknown = true; return same.v; }
      sh.nofn.add(r * MAXC + c);
      return new XErr(E.name);
    }
  }

  ev(n, sh, r, c) {
    switch (n.k) {
      case 'n': case 's': case 'b': return n.v;
      case 'e': throw new XErr(n.v);
      case 'miss': return null;
      case 'a': return this.area(n.t, sh);
      case 'neg': return -this.num(this.ev(n.a, sh, r, c), r, c);
      case 'pct': return this.num(this.ev(n.a, sh, r, c), r, c) / 100;
      case 'op': return this.op(n, sh, r, c);
      case 'fn': { const f = FN[n.name]; if (!f) throw new NoFn(); return f(this, n.args, sh, r, c); }
    }
    throw new NoFn();   // defined names and the like
  }

  area(t, sh) {
    if (t.sheet !== null) {
      const want = t.sheet.toLowerCase();
      sh = this.book.sheets.find(s => s.name.toLowerCase() === want);
      if (!sh) throw new XErr(E.ref);
    }
    if (t.cols) return new Area(sh, 0, Math.min(t.a.c, t.b.c), Infinity, Math.max(t.a.c, t.b.c));
    const b = t.b || t.a;
    return new Area(sh, Math.min(t.a.r, b.r), Math.min(t.a.c, b.c), Math.max(t.a.r, b.r), Math.max(t.a.c, b.c));
  }

  /* one value; a range gives the cell in the formula's own row or column */
  scalar(v, r, c) {
    if (v instanceof Area) {
      let rr = v.r0, cc = v.c0;
      if (v.r1 !== v.r0) { if (r >= v.r0 && r <= v.r1) rr = r; else throw new XErr(E.value); }
      if (v.c1 !== v.c0) { if (c >= v.c0 && c <= v.c1) cc = c; else throw new XErr(E.value); }
      v = this.value(v.sh, rr, cc);
    }
    if (v instanceof XErr) throw v;
    return v;
  }
  num(v, r, c) {
    v = this.scalar(v, r, c);
    if (typeof v === 'number') return v;
    if (v === null) return 0;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const t = typed(v, this.book.d1904);
    if (t.k === 'n') return t.v;
    throw new XErr(E.value);
  }
  str(v, r, c) {
    v = this.scalar(v, r, c);
    if (v === null) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'number') return String(round15(v));
    return v;
  }
  bool(v, r, c) {
    v = this.scalar(v, r, c);
    if (v === null) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (/^(true|false)$/i.test(v)) return /^t/i.test(v);
    throw new XErr(E.value);
  }
  /* numbers < text < logicals; empty is 0, "" or FALSE, whatever the other side is */
  cmp(a, b) {
    if (a === null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
    if (b === null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
    const rank = v => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (typeof a === 'number') { a = round15(a); b = round15(b); } else if (typeof a === 'string') { a = a.toLowerCase(); b = b.toLowerCase(); }
    return a < b ? -1 : a > b ? 1 : 0;
  }
  /* fn(value, rowInArea, colInArea) for the cells of an area that hold something */
  each(a, fn) {
    const rows = a.sh.rows, r1 = Math.min(a.r1, rows.length - 1);
    for (let r = a.r0; r <= r1; r++) {
      const row = rows[r];
      if (!row) continue;
      const c1 = Math.min(a.c1, row.length - 1);
      for (let c = a.c0; c <= c1; c++) if (row[c]) fn(this.value(a.sh, r, c), r - a.r0, c - a.c0);
    }
  }

  op(n, sh, r, c) {
    const a = this.ev(n.a, sh, r, c), b = this.ev(n.b, sh, r, c);
    switch (n.op) {
      case '+': return this.num(a, r, c) + this.num(b, r, c);
      case '-': return this.num(a, r, c) - this.num(b, r, c);
      case '*': return this.num(a, r, c) * this.num(b, r, c);
      case '/': { const x = this.num(a, r, c), y = this.num(b, r, c); if (y === 0) throw new XErr(E.div); return x / y; }
      case '^': { const v = Math.pow(this.num(a, r, c), this.num(b, r, c)); if (!isFinite(v)) throw new XErr(E.num); return v; }
      case '&': return this.str(a, r, c) + this.str(b, r, c);
    }
    const d = this.cmp(this.scalar(a, r, c), this.scalar(b, r, c));
    return n.op === '=' ? d === 0 : n.op === '<>' ? d !== 0 : n.op === '<' ? d < 0 : n.op === '>' ? d > 0 : n.op === '<=' ? d <= 0 : d >= 0;
  }
}

/* ---- functions: f(calc, argument trees, sheet, row, col) ---- */
/* the numbers SUM sees: from ranges only numbers (text, logicals, empty skipped), direct arguments converted */
function fnNums(x, args, sh, r, c) {
  const out = [];
  for (const n of args) {
    if (n.k === 'miss') continue;
    const v = x.ev(n, sh, r, c);
    if (v instanceof Area) x.each(v, y => { if (typeof y === 'number') out.push(y); else if (y instanceof XErr) throw y; });
    else out.push(x.num(v, r, c));
  }
  return out;
}
function fnArg(x, args, i, sh, r, c, dflt) { const n = args[i]; return !n || n.k === 'miss' ? dflt : x.ev(n, sh, r, c); }
function fnNum(x, args, i, sh, r, c, dflt) {
  if (!args[i] && dflt === undefined) throw new XErr(E.value);
  return x.num(fnArg(x, args, i, sh, r, c, dflt === undefined ? null : dflt), r, c);
}
function fnStr(x, args, i, sh, r, c) { return x.str(fnArg(x, args, i, sh, r, c, null), r, c); }
function fnRound(how) {
  return (x, a, sh, r, c) => {
    const v = fnNum(x, a, 0, sh, r, c), m = Math.pow(10, Math.trunc(fnNum(x, a, 1, sh, r, c, 0)));
    return Math.sign(v) * how(round15(Math.abs(v) * m)) / m;
  };
}
/* SUMIF / COUNTIF criteria: 5, ">5", "<>x", "a*" */
function fnCrit(x, v) {
  if (typeof v === 'number') return y => typeof y === 'number' && round15(y) === round15(v);
  if (typeof v === 'boolean') return y => y === v;
  let s = v === null ? '' : String(v), op = '=';
  const m = /^(<=|>=|<>|<|>|=)/.exec(s);
  if (m) { op = m[1]; s = s.slice(op.length); }
  const t = typed(s, x.book.d1904);
  const test = d => (op === '=' ? d === 0 : op === '<>' ? d !== 0 : op === '<' ? d < 0 : op === '>' ? d > 0 : op === '<=' ? d <= 0 : d >= 0);
  if (t.k === 'n') return y => typeof y === 'number' && test(x.cmp(y, t.v));
  if (s === '') return op === '<>' ? y => y !== null && y !== '' : op === '=' ? y => y === null || y === '' : () => false;
  if (op === '=' || op === '<>') {
    const re = new RegExp('^' + s.replace(/~([*?])|([*?])|([.+^${}()|[\]\\])/g, (a, esc, wild, sp) => (esc ? '\\' + esc : wild ? (wild === '*' ? '.*' : '.') : '\\' + sp)) + '$', 'is');
    const hit = y => typeof y === 'string' && re.test(y);
    return op === '=' ? hit : y => !hit(y);
  }
  return y => typeof y === 'string' && test(x.cmp(y, s));
}
function fnArea(x, args, i, sh, r, c) { const v = fnArg(x, args, i, sh, r, c, null); if (!(v instanceof Area)) throw new XErr(E.value); return v; }

const FN = {
  SUM: (x, a, sh, r, c) => fnNums(x, a, sh, r, c).reduce((s, v) => s + v, 0),
  PRODUCT: (x, a, sh, r, c) => fnNums(x, a, sh, r, c).reduce((s, v) => s * v, 1),
  AVERAGE: (x, a, sh, r, c) => { const l = fnNums(x, a, sh, r, c); if (!l.length) throw new XErr(E.div); return l.reduce((s, v) => s + v, 0) / l.length; },
  MIN: (x, a, sh, r, c) => { const l = fnNums(x, a, sh, r, c); return l.length ? l.reduce((s, v) => (v < s ? v : s)) : 0; },
  MAX: (x, a, sh, r, c) => { const l = fnNums(x, a, sh, r, c); return l.length ? l.reduce((s, v) => (v > s ? v : s)) : 0; },
  COUNT: (x, a, sh, r, c) => {
    let n = 0;
    for (const e of a) {
      if (e.k === 'miss') continue;
      let v;
      try { v = x.ev(e, sh, r, c); } catch (err) { if (err instanceof XErr) continue; throw err; }
      if (v instanceof Area) x.each(v, y => { if (typeof y === 'number') n++; });
      else if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && typed(v, x.book.d1904).k === 'n')) n++;
    }
    return n;
  },
  COUNTA: (x, a, sh, r, c) => {
    let n = 0;
    for (const e of a) {
      if (e.k === 'miss') continue;
      let v;
      try { v = x.ev(e, sh, r, c); } catch (err) { if (err instanceof XErr) { n++; continue; } throw err; }
      if (v instanceof Area) x.each(v, y => { if (y !== null) n++; }); else if (v !== null) n++;
    }
    return n;
  },
  COUNTBLANK: (x, a, sh, r, c) => {
    const ar = fnArea(x, a, 0, sh, r, c);
    let full = 0;
    x.each(ar, y => { if (y !== null && y !== '') full++; });
    return (Math.min(ar.r1, Math.max(ar.sh.rows.length, ar.r0 + 1) - 1) - ar.r0 + 1) * (ar.c1 - ar.c0 + 1) - full;
  },
  ROUND: fnRound(Math.round),
  ROUNDUP: fnRound(Math.ceil),
  ROUNDDOWN: fnRound(Math.floor),
  TRUNC: fnRound(Math.floor),
  INT: (x, a, sh, r, c) => Math.floor(fnNum(x, a, 0, sh, r, c)),
  ABS: (x, a, sh, r, c) => Math.abs(fnNum(x, a, 0, sh, r, c)),
  SIGN: (x, a, sh, r, c) => Math.sign(fnNum(x, a, 0, sh, r, c)),
  SQRT: (x, a, sh, r, c) => { const v = fnNum(x, a, 0, sh, r, c); if (v < 0) throw new XErr(E.num); return Math.sqrt(v); },
  POWER: (x, a, sh, r, c) => { const v = Math.pow(fnNum(x, a, 0, sh, r, c), fnNum(x, a, 1, sh, r, c)); if (!isFinite(v)) throw new XErr(E.num); return v; },
  MOD: (x, a, sh, r, c) => { const n = fnNum(x, a, 0, sh, r, c), d = fnNum(x, a, 1, sh, r, c); if (d === 0) throw new XErr(E.div); return n - d * Math.floor(n / d); },
  PI: () => Math.PI,
  IF: (x, a, sh, r, c) => (x.bool(fnArg(x, a, 0, sh, r, c, null), r, c) ? fnArg(x, a, 1, sh, r, c, a.length > 1 ? null : true) : fnArg(x, a, 2, sh, r, c, a.length > 2 ? null : false)),
  IFERROR: (x, a, sh, r, c) => {
    try { return x.scalar(fnArg(x, a, 0, sh, r, c, null), r, c); } catch (e) { if (e instanceof XErr) return fnArg(x, a, 1, sh, r, c, null); throw e; }
  },
  AND: (x, a, sh, r, c) => fnBools(x, a, sh, r, c).every(Boolean),
  OR: (x, a, sh, r, c) => fnBools(x, a, sh, r, c).some(Boolean),
  NOT: (x, a, sh, r, c) => !x.bool(fnArg(x, a, 0, sh, r, c, null), r, c),
  ISBLANK: (x, a, sh, r, c) => fnTry(x, a, sh, r, c) === null,
  ISNUMBER: (x, a, sh, r, c) => typeof fnTry(x, a, sh, r, c) === 'number',
  ISTEXT: (x, a, sh, r, c) => typeof fnTry(x, a, sh, r, c) === 'string',
  ISERROR: (x, a, sh, r, c) => fnTry(x, a, sh, r, c) instanceof XErr,
  SUMIF: (x, a, sh, r, c) => {
    const ar = fnArea(x, a, 0, sh, r, c), ok = fnCrit(x, x.scalar(fnArg(x, a, 1, sh, r, c, null), r, c));
    const sr = a[2] ? fnArea(x, a, 2, sh, r, c) : ar;
    let s = 0;
    x.each(ar, (y, i, j) => { if (ok(y)) { const v = x.value(sr.sh, sr.r0 + i, sr.c0 + j); if (v instanceof XErr) throw v; if (typeof v === 'number') s += v; } });
    return s;
  },
  COUNTIF: (x, a, sh, r, c) => {
    const ar = fnArea(x, a, 0, sh, r, c), ok = fnCrit(x, x.scalar(fnArg(x, a, 1, sh, r, c, null), r, c));
    let n = 0;
    x.each(ar, y => { if (ok(y)) n++; });
    return n;
  },
  TODAY: x => { const d = new Date(); return XDate.serial(d.getFullYear(), d.getMonth() + 1, d.getDate(), 0, 0, 0, x.book.d1904); },
  NOW: x => { const d = new Date(); return XDate.serial(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), x.book.d1904); },
  DATE: (x, a, sh, r, c) => {
    let y = Math.trunc(fnNum(x, a, 0, sh, r, c));
    if (y < 1900) y += 1900;
    const v = XDate.serial(y, Math.trunc(fnNum(x, a, 1, sh, r, c)), Math.trunc(fnNum(x, a, 2, sh, r, c)), 0, 0, 0, x.book.d1904);
    if (v < 0) throw new XErr(E.num);
    return v;
  },
  YEAR: (x, a, sh, r, c) => XDate.parts(fnNum(x, a, 0, sh, r, c), x.book.d1904).y,
  MONTH: (x, a, sh, r, c) => XDate.parts(fnNum(x, a, 0, sh, r, c), x.book.d1904).mo,
  DAY: (x, a, sh, r, c) => XDate.parts(fnNum(x, a, 0, sh, r, c), x.book.d1904).d,
  CONCATENATE: (x, a, sh, r, c) => a.map((n, i) => fnStr(x, a, i, sh, r, c)).join(''),
  CONCAT: (x, a, sh, r, c) => a.map((n, i) => {
    const v = fnArg(x, a, i, sh, r, c, null);
    if (!(v instanceof Area)) return x.str(v, r, c);
    let s = '';
    x.each(v, y => { if (y instanceof XErr) throw y; s += x.str(y, r, c); });
    return s;
  }).join(''),
  LEN: (x, a, sh, r, c) => fnStr(x, a, 0, sh, r, c).length,
  LEFT: (x, a, sh, r, c) => fnStr(x, a, 0, sh, r, c).slice(0, Math.max(0, fnNum(x, a, 1, sh, r, c, 1))),
  RIGHT: (x, a, sh, r, c) => { const s = fnStr(x, a, 0, sh, r, c), n = Math.max(0, fnNum(x, a, 1, sh, r, c, 1)); return n ? s.slice(-n) : ''; },
  MID: (x, a, sh, r, c) => { const s = fnStr(x, a, 0, sh, r, c), p = fnNum(x, a, 1, sh, r, c); if (p < 1) throw new XErr(E.value); return s.substr(p - 1, Math.max(0, fnNum(x, a, 2, sh, r, c))); },
  UPPER: (x, a, sh, r, c) => fnStr(x, a, 0, sh, r, c).toUpperCase(),
  LOWER: (x, a, sh, r, c) => fnStr(x, a, 0, sh, r, c).toLowerCase(),
  TRIM: (x, a, sh, r, c) => fnStr(x, a, 0, sh, r, c).trim().replace(/ {2,}/g, ' '),
  VALUE: (x, a, sh, r, c) => fnNum(x, a, 0, sh, r, c),
  TEXT: (x, a, sh, r, c) => {
    const v = x.scalar(fnArg(x, a, 0, sh, r, c, null), r, c), f = fnStr(x, a, 1, sh, r, c);
    const n = typeof v === 'number' ? v : typeof v === 'string' && typed(v, x.book.d1904).k === 'n' ? typed(v, x.book.d1904).v : null;
    return n === null ? x.str(v, r, c) : NumFmt.format(n, f, x.book.d1904);
  },
};
function fnTry(x, a, sh, r, c) {
  try { return x.scalar(fnArg(x, a, 0, sh, r, c, null), r, c); } catch (e) { if (e instanceof XErr) return e; throw e; }
}
function fnBools(x, a, sh, r, c) {
  const out = [];
  for (const n of a) {
    if (n.k === 'miss') continue;
    const v = x.ev(n, sh, r, c);
    if (v instanceof Area) x.each(v, y => { if (y instanceof XErr) throw y; if (typeof y === 'number' || typeof y === 'boolean') out.push(!!y); });
    else out.push(x.bool(v, r, c));
  }
  if (!out.length) throw new XErr(E.value);
  return out;
}


/* ---- the workbook: sheets of cells as the editor has them (raw text), over what the file has ----
   sheet = {name, rows: [[raw]], base: k -> raw as loaded, cells: k -> {s, v: the value in the file, f: its formula,
   keep: a formula to leave alone}, merge: k -> columns the grid spans (0: covered), spans: k -> {rows, cols},
   cols: [{a, b, px, s}], defPx, changed: keys edited, pend: k -> style for the next save, memo, nofn};
   k = r * MAXC + c. Styles are indexes into book.xfs: {fmt, date, b, i, u, s, fill, align}. */
class SheetBook {
  static sheet(name) {
    const sh = {
      name, rows: [], base: new Map(), cells: new Map(), merge: new Map(), spans: new Map(), cols: [], defPx: 72,
      changed: new Set(), pend: new Map(), memo: new Map(), nofn: new Set(),
    };
    sh.colAt = c => sh.cols.find(o => c >= o.a && c <= o.b) || null;
    sh.px = c => { const o = sh.colAt(c); return o ? o.px : sh.defPx; };
    return sh;
  }
  /* merged cells; the grid can only show the columns of it */
  static span(sh, r, c, rows, cols) {
    const k = r * MAXC + c;
    sh.spans.set(k, { rows, cols });
    if (cols > 1) { sh.merge.set(k, cols); for (let i = 1; i < cols; i++) sh.merge.set(k + i, 0); }
  }

  async part(name) {
    let x = this.xml.get(name);
    if (!x) {
      const f = this.byName.get(name);
      if (!f) return null;
      const text = new TextDecoder().decode(await ZIP.inflate(f));
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) throw new Error(name + ': broken XML');
      const m = /^\s*<\?xml[^>]*\?>\s*/.exec(text);   // kept as it was, the serializer writes its own
      x = { doc, decl: m ? m[0] : '', ver: 0, saved: 0 };
      this.xml.set(name, x);
    }
    return x;
  }
  touch(x) { x.ver++; }

  /* a cell as the file has it, and how it reads in the editor */
  cell(sh, r, c, cell, raw) {
    const k = r * MAXC + c;
    sh.cells.set(k, cell);
    if (raw) {
      while (sh.rows.length <= r) sh.rows.push([]);
      sh.rows[r][c] = raw;
      sh.base.set(k, raw);
    }
  }

  /* how a value reads in the editor */
  rawOf(v, s) {
    if (v === null || v === undefined) return '';
    if (v instanceof XErr) return v.e;
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'number') {
      const xf = this.xfs[s];
      if (!xf) return String(round15(v));
      if (SheetBook.pct(xf)) return String(round15(v * 100)) + '%';
      if (!xf.date) return String(round15(v));
      const shown = NumFmt.format(v, xf.fmt, this.d1904), t = typed(shown, this.d1904);   // 1.9.26 stays 1.9.26, 9/1/26 does not
      return t.k === 'n' && t.fmt && Math.abs(t.v - v) < 1 / 86400 / 2 ? shown : XDate.iso(v, this.d1904, xf.date);
    }
    // text that would read as a number, date, formula… keeps a leading '
    return v && (v[0] === "'" || typed(v, this.d1904).k !== 's') ? "'" + v : v;
  }

  show(v, s) {
    if (v === null || v === undefined) return '';
    if (v instanceof XErr) return v.e;
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'number') return NumFmt.format(v, (this.xfs[s] || {}).fmt, this.d1904);
    return v;
  }

  /* shows numbers as percentages */
  static pct(xf) {
    if (xf.pct === undefined) xf.pct = !xf.date && /%/.test(NumFmt.bare(NumFmt.sections(xf.fmt || '')[0]));
    return xf.pct;
  }

  /* raw into a cell, from the editor; dates and percentages get a format that shows them, if the cell has none */
  put(sh, r, c, raw) {
    while (sh.rows.length <= r) sh.rows.push([]);
    sh.rows[r][c] = raw;
    const k = r * MAXC + c;
    if (raw === (sh.base.get(k) || '')) sh.changed.delete(k); else sh.changed.add(k);
    sh.pend.delete(k);
    const t = typed(raw, this.d1904);
    const xf = this.xfs[this.styleAt(sh, r, c)] || {};
    if (t.fmt && !(NumFmt.dateKind(t.fmt) ? xf.date : SheetBook.pct(xf))) sh.pend.set(k, this.fmtStyle(sh, r, c, t.fmt));
  }

  static same(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return round15(a) === round15(b);
    if (a instanceof XErr && b instanceof XErr) return a.e === b.e;
    return a === b;
  }
}

/* ---- xlsx, read only ---- */
class XlsxBook extends SheetBook {
  static async open(bytes) {
    const b = new XlsxBook();
    b.files = ZIP.read(bytes);
    b.byName = new Map(b.files.map(f => [f.name, f]));
    b.xml = new Map();       // part name -> {doc, decl, ver, saved}
    await b.load();
    b.xml.clear();           // nothing is written back
    return b;
  }

  async load() {
    let wbPath = 'xl/workbook.xml';
    const root = await this.part('_rels/.rels');
    if (root) for (const r of xkids(root.doc.documentElement, 'Relationship')) if (/\/officeDocument$/.test(r.getAttribute('Type'))) wbPath = partPath('', r.getAttribute('Target'));
    const wb = await this.part(wbPath);
    if (!wb) throw new Error('not a spreadsheet (no workbook)');
    const dir = wbPath.replace(/[^/]*$/, '');
    const rels = {}, byType = {};
    const rx = await this.part(dir + '_rels/' + wbPath.slice(dir.length) + '.rels');
    for (const r of rx ? xkids(rx.doc.documentElement, 'Relationship') : []) {
      if (r.getAttribute('TargetMode') === 'External') continue;
      const p = partPath(dir, r.getAttribute('Target'));
      rels[r.getAttribute('Id')] = p;
      byType[r.getAttribute('Type').replace(/.*\//, '')] = p;
    }
    const w = wb.doc.documentElement, pr = xkid(w, 'workbookPr');
    this.d1904 = !!pr && /^(1|true)$/.test(pr.getAttribute('date1904') || '');
    this.strings = [];
    const sx = byType.sharedStrings && await this.part(byType.sharedStrings);
    if (sx) for (const si of xkids(sx.doc.documentElement, 'si')) this.strings.push(siText(si));
    this.readStyles(byType.styles && await this.part(byType.styles));
    this.sheets = [];
    const bv = xkid(xkid(w, 'bookViews'), 'workbookView'), active = bv ? +bv.getAttribute('activeTab') || 0 : 0;
    let n = 0;
    for (const s of xkids(xkid(w, 'sheets'), 'sheet')) {
      const path = rels[s.getAttributeNS(XNS_R, 'id')];
      const x = path && this.byName.has(path) ? await this.part(path) : null;
      if (x && x.doc.documentElement.localName === 'worksheet') {
        const sh = this.readSheet(s.getAttribute('name'), x);
        if (n === active) this.active = sh;
        this.sheets.push(sh);
      }
      n++;
    }
    if (!this.sheets.length) throw new Error('no worksheets in this file');
    if (!this.active) this.active = this.sheets[0];
  }

  readStyles(x) {
    this.xfs = [{ fmt: 'General' }];
    if (!x) return;
    const st = x.doc.documentElement, fmts = Object.assign({}, NumFmt.builtin);
    for (const f of xkids(xkid(st, 'numFmts'), 'numFmt')) fmts[f.getAttribute('numFmtId')] = f.getAttribute('formatCode');
    const on = el => !!el && !/^(0|false)$/.test(el.getAttribute('val') || '');
    const fonts = xkids(xkid(st, 'fonts'), 'font').map(f => ({ b: on(xkid(f, 'b')), i: on(xkid(f, 'i')), u: !!xkid(f, 'u') && xkid(f, 'u').getAttribute('val') !== 'none', s: on(xkid(f, 'strike')) }));
    const idx = xkids(xkid(xkid(st, 'colors'), 'indexedColors'), 'rgbColor').map(c => c.getAttribute('rgb'));
    const fills = xkids(xkid(st, 'fills'), 'fill').map(f => {
      const p = xkid(f, 'patternFill'), c = p && p.getAttribute('patternType') === 'solid' ? xkid(p, 'fgColor') : null;
      const v = c && (c.getAttribute('rgb') || (c.hasAttribute('indexed') ? idx[+c.getAttribute('indexed')] : null));
      return v && /^[0-9A-F]{6,8}$/i.test(v) ? '#' + v.slice(-6) : null;
    });
    const xfs = xkids(xkid(st, 'cellXfs'), 'xf').map(el => {
      const fmt = fmts[el.getAttribute('numFmtId') || '0'] || 'General', font = fonts[+el.getAttribute('fontId') || 0] || {};
      const al = xkid(el, 'alignment'), ha = al && al.getAttribute('horizontal');
      return {
        fmt, date: NumFmt.dateKind(fmt), b: font.b, i: font.i, u: font.u, s: font.s, fill: fills[+el.getAttribute('fillId') || 0] || null,
        align: ha === 'center' || ha === 'centerContinuous' ? 'c' : ha === 'right' ? 'r' : ha === 'left' ? 'l' : '',
      };
    });
    if (xfs.length) this.xfs = xfs;
  }

  readSheet(name, x) {
    const ws = x.doc.documentElement, sh = SheetBook.sheet(name);
    sh.rowS = new Map();
    sh.shared = new Map();
    const fp = xkid(ws, 'sheetFormatPr');
    const dw = fp && fp.getAttribute('defaultColWidth') ? +fp.getAttribute('defaultColWidth') : (fp && fp.getAttribute('baseColWidth') ? +fp.getAttribute('baseColWidth') : 8) + 0.43;
    const px = w => Math.max(24, Math.round(w * 7.4 + 6));
    sh.defPx = px(dw);
    for (const col of xkids(xkid(ws, 'cols'), 'col')) {
      sh.cols.push({ a: +col.getAttribute('min') - 1, b: +col.getAttribute('max') - 1, px: col.getAttribute('width') ? px(+col.getAttribute('width')) : sh.defPx, s: +col.getAttribute('style') || 0 });
    }
    for (const m of xkids(xkid(ws, 'mergeCells'), 'mergeCell')) {
      const [a, b] = (m.getAttribute('ref') || '').split(':').map(cellAt);
      if (a && b && (b.c > a.c || b.r > a.r)) SheetBook.span(sh, a.r, a.c, b.r - a.r + 1, b.c - a.c + 1);
    }
    let r = -1;
    for (const row of xkids(xkid(ws, 'sheetData'), 'row')) {
      r = row.hasAttribute('r') ? +row.getAttribute('r') - 1 : r + 1;
      if (/^(1|true)$/.test(row.getAttribute('customFormat') || '') && row.hasAttribute('s')) sh.rowS.set(r, +row.getAttribute('s'));
      let c = -1;
      for (const el of xkids(row, 'c')) {
        const p = cellAt(el.getAttribute('r'));
        c = p ? p.c : c + 1;
        this.readCell(sh, r, c, el);
      }
    }
    delete sh.shared;
    return sh;
  }

  readCell(sh, r, c, el) {
    const t = el.getAttribute('t') || 'n', s = +el.getAttribute('s') || 0;
    const f = xkid(el, 'f'), ve = xkid(el, 'v'), vt = ve ? ve.textContent : null;
    let v = null;
    if (t === 's') v = vt === null ? null : this.strings[+vt] === undefined ? '' : this.strings[+vt];
    else if (t === 'inlineStr') { const is = xkid(el, 'is'); v = is ? siText(is) : ''; }
    else if (t === 'str') v = vt === null ? '' : vt;
    else if (t === 'b') v = vt === '1' || vt === 'true';
    else if (t === 'e') v = new XErr(vt || E.na);
    else if (t === 'd') { const x = typed((vt || '').replace(/Z$/, ''), this.d1904); v = x.k === 'n' ? x.v : vt; }
    else if (vt !== null && vt !== '') v = +vt;
    const cell = { s, v, f: null, keep: false };
    let raw;
    if (f) {
      let text = f.textContent;
      const ft = f.getAttribute('t');
      if (ft === 'shared') {
        const si = f.getAttribute('si');
        const g = sh.shared.get(si);
        if (f.hasAttribute('ref') && text) sh.shared.set(si, { r, c, text });
        else if (g) text = Formula.shift(g.text, r - g.r, c - g.c);
      } else if (ft === 'array' || ft === 'dataTable') {
        cell.keep = true;
        const [a, b] = (f.getAttribute('ref') || '').split(':').map(cellAt);
        if (ft === 'array' && a) cell.arr = { rows: b ? b.r - a.r + 1 : 1, cols: b ? b.c - a.c + 1 : 1 };
      }
      raw = text ? '=' + text : this.rawOf(v, s);
      if (text) cell.f = raw;
    } else raw = this.rawOf(v, s);
    this.cell(sh, r, c, cell, raw);
  }

  styleAt(sh, r, c) {
    const k = r * MAXC + c;
    if (sh.pend.has(k)) return sh.pend.get(k);
    const cell = sh.cells.get(k);
    if (cell) return cell.s;
    if (sh.rowS.has(r)) return sh.rowS.get(r);
    const col = sh.colAt(c);
    return col ? col.s : 0;
  }
}

/* ---- XML text ---- */
function xmlEsc(s) {
  return String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, '')
    .replace(/[&<>"]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}
/* where a sheet's cells are: the last row with something, the widest row */
function usedArea(sh) {
  let rows = sh.rows.length, cols = 0;
  while (rows > 0 && !sh.rows[rows - 1].some(Boolean)) rows--;
  for (let r = 0; r < rows; r++) { const row = sh.rows[r]; let n = row.length; while (n > 0 && !row[n - 1]) n--; if (n > cols) cols = n; }
  for (const [k, sp] of sh.spans) {
    const r = Math.floor(k / MAXC), c = k % MAXC;
    rows = Math.max(rows, r + sp.rows);
    cols = Math.max(cols, c + sp.cols);
  }
  return { rows, cols };
}
/* what a formula cell holds for writing: {text: the formula without =, or null for just the value, v: its value, or undefined} */
function cellOut(book, calc, sh, r, c, raw) {
  const k = r * MAXC + c, cell = sh.cells.get(k);
  let v = calc.value(sh, r, c);
  if (raw[0] !== '=' || raw.length < 2) return { text: null, v };
  const text = raw.slice(1), keep = cell && cell.keep && sh.base.get(k) === raw;
  if (sh.nofn.has(k) || (v instanceof XErr && v.e === E.circ)) v = undefined;   // left for the next program that opens it
  return { text: keep || !calc.ast(text) ? null : text, v, keep, arr: keep ? cell.arr : null };
}

/* ---- a new xlsx from any workbook, for export ---- */
const XNS_PKG = 'http://schemas.openxmlformats.org/package/2006/';
const XLSX_ERRS = new Set(['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A']);
const XlsxOut = {
  /* the builtin formats Excel shows the same everywhere */
  ids: { General: 0, '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10, '0.00E+00': 11, '@': 49 },

  async write(book, calc) {
    const T = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    const str = s => xmlEsc(s.replace(/_(x[0-9A-Fa-f]{4}_)/g, '_x005F_$1'));
    const tEl = s => '<t' + (/^\s|\s$/.test(s) ? ' xml:space="preserve"' : '') + '>' + str(s) + '</t>';
    // sheet names: 31 characters, none of []:*?/\, unique
    const names = [], rename = new Map(), taken = new Set();
    for (const sh of book.sheets) {
      let n = sh.name.replace(/[[\]:*?/\\]/g, '_').replace(/^'+|'+$/g, '').slice(0, 31) || 'Sheet';
      for (let i = 2; taken.has(n.toLowerCase()); i++) n = n.slice(0, 31 - String(i).length - 3) + ' (' + i + ')';
      taken.add(n.toLowerCase());
      names.push(n);
      if (n !== sh.name) rename.set(sh.name.toLowerCase(), n);
    }
    // styles: fonts, fills and formats, each once
    const fonts = ['<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'], fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
    const numFmts = [], xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'], xfKeys = new Map([['0/0/0/', 0]]);
    const once = (list, s) => { let i = list.indexOf(s); if (i < 0) { i = list.length; list.push(s); } return i; };
    const fmtId = code => {
      if (!code || /^general$/i.test(code)) return 0;
      if (XlsxOut.ids[code] !== undefined) return XlsxOut.ids[code];
      return 164 + once(numFmts, code);
    };
    const xfOf = new Map();   // book style -> xf
    const xfIndex = s => {
      let i = xfOf.get(s);
      if (i !== undefined) return i;
      const x = book.xfs[s] || {};
      const font = x.b || x.i || x.u || x.s ? once(fonts, '<font>' + (x.b ? '<b/>' : '') + (x.i ? '<i/>' : '') + (x.s ? '<strike/>' : '') + (x.u ? '<u/>' : '') + '<sz val="11"/><name val="Calibri"/><family val="2"/></font>') : 0;
      const fill = x.fill ? once(fills, '<fill><patternFill patternType="solid"><fgColor rgb="FF' + x.fill.slice(1).toUpperCase() + '"/><bgColor indexed="64"/></patternFill></fill>') : 0;
      const nf = fmtId(x.fmt), key = nf + '/' + font + '/' + fill + '/' + (x.align || '');
      i = xfKeys.get(key);
      if (i === undefined) {
        i = xfs.length;
        xfKeys.set(key, i);
        const al = x.align ? '<alignment horizontal="' + { l: 'left', c: 'center', r: 'right' }[x.align] + '"/>' : '';
        xfs.push('<xf numFmtId="' + nf + '" fontId="' + font + '" fillId="' + fill + '" borderId="0" xfId="0"' + (nf ? ' applyNumberFormat="1"' : '') +
          (font ? ' applyFont="1"' : '') + (fill ? ' applyFill="1"' : '') + (al ? ' applyAlignment="1">' + al + '</xf>' : '/>'));
      }
      xfOf.set(s, i);
      return i;
    };
    const strings = [], strIdx = new Map();
    let strCount = 0;
    const sIndex = s => { strCount++; let i = strIdx.get(s); if (i === undefined) { i = strings.length; strings.push(s); strIdx.set(s, i); } return i; };
    const chars = px => Math.max(0.5, Math.round((px - 6) / 7.4 * 100) / 100);

    const sheetXml = [];
    book.sheets.forEach((sh, n) => {
      const { rows, cols } = usedArea(sh), out = [];
      out.push(T + '<worksheet xmlns="' + XNS + '" xmlns:r="' + XNS_R + '">');
      out.push('<sheetViews><sheetView workbookViewId="0"' + (sh === book.active ? ' tabSelected="1"' : '') + '/></sheetViews>');
      out.push('<sheetFormatPr defaultRowHeight="15" defaultColWidth="' + chars(sh.defPx) + '"/>');
      if (cols) {
        out.push('<cols>');
        for (let c = 0; c < cols;) {
          const px = sh.px(c);
          let e = c;
          while (e + 1 < cols && sh.px(e + 1) === px) e++;
          if (px !== sh.defPx) out.push('<col min="' + (c + 1) + '" max="' + (e + 1) + '" width="' + chars(px) + '" customWidth="1"/>');
          c = e + 1;
        }
        out.push('</cols>');
        if (out[out.length - 2] === '<cols>') out.splice(-2, 2);
      }
      out.push('<sheetData>');
      for (let r = 0; r < rows; r++) {
        const row = sh.rows[r] || [], cells = [];
        for (let c = 0; c < cols; c++) {
          const raw = row[c] || '', s = xfIndex(book.styleAt(sh, r, c)), ref = refOf(r, c);
          if (!raw) { if (s) cells.push('<c r="' + ref + '" s="' + s + '"/>'); continue; }
          const o = cellOut(book, calc, sh, r, c, raw), v = o.v;
          let t = '', val = null;
          if (v === undefined || v === null) val = null;
          else if (typeof v === 'number') val = isFinite(v) ? String(v) : null;
          else if (typeof v === 'boolean') { t = 'b'; val = v ? '1' : '0'; }
          else if (v instanceof XErr) { if (XLSX_ERRS.has(v.e)) { t = 'e'; val = v.e; } }
          else if (o.text !== null) { t = 'str'; val = v; }
          else { t = 's'; val = String(sIndex(v)); }
          const f = o.text !== null ? Formula.excel(o.text, rename) : null;
          if (f === null && val === null) { if (s) cells.push('<c r="' + ref + '" s="' + s + '"/>'); continue; }
          cells.push('<c r="' + ref + '"' + (s ? ' s="' + s + '"' : '') + (t ? ' t="' + t + '"' : '') + '>' +
            (f !== null ? '<f>' + xmlEsc(f) + '</f>' : '') + (val !== null ? '<v>' + (t === 'str' ? str(val) : xmlEsc(val)) + '</v>' : '') + '</c>');
        }
        if (cells.length) out.push('<row r="' + (r + 1) + '">' + cells.join('') + '</row>');
      }
      out.push('</sheetData>');
      if (sh.spans.size) {
        out.push('<mergeCells count="' + sh.spans.size + '">');
        for (const [k, sp] of sh.spans) {
          const r = Math.floor(k / MAXC), c = k % MAXC;
          out.push('<mergeCell ref="' + refOf(r, c) + ':' + refOf(r + sp.rows - 1, c + sp.cols - 1) + '"/>');
        }
        out.push('</mergeCells>');
      }
      out.push('</worksheet>');
      sheetXml.push(out.join(''));
    });

    const ct = T + '<Types xmlns="' + XNS_PKG + 'content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheetXml.map((x, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>';
    const rel = (id, type, target) => '<Relationship Id="' + id + '" Type="' + XNS_R + '/' + type + '" Target="' + target + '"/>';
    const rels = T + '<Relationships xmlns="' + XNS_PKG + 'relationships">' + rel('rId1', 'officeDocument', 'xl/workbook.xml') + '</Relationships>';
    const n = book.sheets.length;
    const wbRels = T + '<Relationships xmlns="' + XNS_PKG + 'relationships">' + sheetXml.map((x, i) => rel('rId' + (i + 1), 'worksheet', 'worksheets/sheet' + (i + 1) + '.xml')).join('') +
      rel('rId' + (n + 1), 'styles', 'styles.xml') + rel('rId' + (n + 2), 'sharedStrings', 'sharedStrings.xml') + '</Relationships>';
    const wb = T + '<workbook xmlns="' + XNS + '" xmlns:r="' + XNS_R + '">' + (book.d1904 ? '<workbookPr date1904="1"/>' : '<workbookPr/>') +
      '<bookViews><workbookView activeTab="' + Math.max(0, book.sheets.indexOf(book.active)) + '"/></bookViews><sheets>' +
      names.map((nm, i) => '<sheet name="' + xmlEsc(nm) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') +
      '</sheets><calcPr calcId="0" fullCalcOnLoad="1"/></workbook>';
    const styles = T + '<styleSheet xmlns="' + XNS + '">' +
      (numFmts.length ? '<numFmts count="' + numFmts.length + '">' + numFmts.map((c, i) => '<numFmt numFmtId="' + (164 + i) + '" formatCode="' + xmlEsc(c) + '"/>').join('') + '</numFmts>' : '') +
      '<fonts count="' + fonts.length + '">' + fonts.join('') + '</fonts><fills count="' + fills.length + '">' + fills.join('') + '</fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="' + xfs.length + '">' + xfs.join('') + '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    const sst = T + '<sst xmlns="' + XNS + '" count="' + strCount + '" uniqueCount="' + strings.length + '">' + strings.map(s => '<si>' + tEl(s) + '</si>').join('') + '</sst>';
    const files = [
      ['[Content_Types].xml', ct], ['_rels/.rels', rels], ['xl/workbook.xml', wb], ['xl/_rels/workbook.xml.rels', wbRels],
      ['xl/styles.xml', styles], ['xl/sharedStrings.xml', sst],
    ].concat(sheetXml.map((x, i) => ['xl/worksheets/sheet' + (i + 1) + '.xml', x]));
    const entries = [];
    for (const [name, text] of files) entries.push(await ZIP.add(name, text));
    return ZIP.write(entries);
  },
};
