/* ods: the spreadsheet format edited here (OpenDocument, what LibreOffice writes).
   Saving patches only the cells that changed, and the cached results of the
   formulas that changed with them, in content.xml; every other part of the
   file is copied through byte for byte. OdsOut writes a new file: from an
   xlsx, or an empty one. Needs xlsx.js (the engine). */
'use strict';

const ONS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  number: 'urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0',
  of: 'urn:oasis:names:tc:opendocument:xmlns:of:1.2',
  meta: 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
  config: 'urn:oasis:names:tc:opendocument:xmlns:config:1.0',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
  calcext: 'urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0',
  loext: 'urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0',
  oooc: 'http://openoffice.org/2004/calc',
  msoxl: 'http://schemas.microsoft.com/office/excel/formula',
};
const ODS_MIME = 'application/vnd.oasis.opendocument.spreadsheet';
/* an attribute, null when missing */
function oat(el, ns, name) { return el.hasAttributeNS(ONS[ns], name) ? el.getAttributeNS(ONS[ns], name) : null; }
function isCellEl(k) { return k.namespaceURI === ONS.table && (k.localName === 'table-cell' || k.localName === 'covered-table-cell'); }

/* ---- formulas: [.A1] and ; there, A1 and , here ---- */
/* functions LibreOffice files keep behind COM.MICROSOFT. */
const OF_MS = new Set(['CONCAT', 'TEXTJOIN', 'IFS', 'SWITCH', 'MAXIFS', 'MINIFS', 'XLOOKUP', 'XMATCH', 'FILTER', 'SORT', 'SORTBY', 'UNIQUE', 'SEQUENCE', 'LET']);
const OdsF = {
  /* table:formula to how the editor has it: {text, ok}; ok false: parts of it mean something else here */
  read(attr, el) {
    const m = /^([A-Za-z_][\w.-]*):(.*)$/s.exec(attr);
    const ns = m ? el.lookupNamespaceURI(m[1]) : null;
    let body = m ? m[2] : attr;
    if (body[0] === '=') body = body.slice(1);
    if (ns === ONS.msoxl) return { text: body, ok: true };
    if (m && ns !== ONS.of && ns !== ONS.oooc) return { text: body, ok: false };
    return OdsF.fromOf(body);
  },

  fromOf(s) {
    let out = '', ok = true, i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '"') {
        let j = i + 1;
        for (;;) {
          const k = s.indexOf('"', j);
          if (k < 0) { j = s.length; break; }
          if (s[k + 1] === '"') { j = k + 2; continue; }
          j = k + 1;
          break;
        }
        out += s.slice(i, j);
        i = j;
        continue;
      }
      if (ch === '[') {
        let j = i + 1, q = false;
        while (j < s.length && (q || s[j] !== ']')) { if (s[j] === "'") q = !q; j++; }
        const r = OdsF.ref(s.slice(i + 1, j));
        if (r === null) { ok = false; out += s.slice(i, j + 1); } else out += r;
        i = j + 1;
        continue;
      }
      if (ch === ';') { out += ','; i++; continue; }
      if (ch === '~' || ch === '!' || ch === '{') ok = false;   // union, intersection, inline arrays: other meanings here
      const m = /^[A-Za-z_][\w.]*/.exec(s.slice(i));
      if (m) {
        const after = s.slice(i + m[0].length), call = /^\s*\(\s*\)/.exec(after);
        let name = m[0];
        if (/^\s*\(/.test(after)) name = name.replace(/^COM\.MICROSOFT\./i, '').replace(/^_xlfn\./i, '');
        if (call && /^(TRUE|FALSE)$/i.test(name)) { out += name.toUpperCase(); i += m[0].length + call[0].length; continue; }
        out += name;
        i += m[0].length;
        continue;
      }
      out += ch;
      i++;
    }
    return { text: out, ok };
  },

  /* inside [ ]: .A1, $Sheet1.A1:.B2, $'My sheet'.$A$1, .A:.B -> A1 style; null: not a reference formulas here have */
  ref(s) {
    if (/#REF!/i.test(s)) return E.ref;
    if (/^'[^']*'#/.test(s)) return null;   // in another file
    const parts = [];
    let q = false, at = 0;
    for (let i = 0; i < s.length; i++) { if (s[i] === "'") q = !q; else if (s[i] === ':' && !q) { parts.push(s.slice(at, i)); at = i + 1; } }
    parts.push(s.slice(at));
    if (parts.length > 2) return null;
    const [a, b] = parts.map(OdsF.addr);
    if (!a || (parts.length > 1 && !b)) return null;
    if (b && b.sheet !== null && (a.sheet === null || b.sheet.toLowerCase() !== a.sheet.toLowerCase())) return null;   // across sheets
    const pre = a.sheet !== null ? Formula.sheetRef(a.sheet) + '!' : '';
    const col = x => (x.ac ? '$' : '') + CSV.colName(x.c), one = x => col(x) + (x.ar ? '$' : '') + (x.r + 1);
    if (!b) return a.c !== undefined && a.r !== undefined ? pre + one(a) : null;
    if (a.c === undefined || b.c === undefined) return null;   // whole rows: not here
    if (a.r === undefined && b.r === undefined) return pre + col(a) + ':' + col(b);
    if (a.r === undefined || b.r === undefined) return null;
    if (a.r === 0 && b.r === MAXR - 1) return pre + col(a) + ':' + col(b);   // whole columns, the way LibreOffice writes them
    return pre + one(a) + ':' + one(b);
  },
  addr(s) {
    let sheet = null, i = 0;
    if (s[i] === '$') i++;
    if (s[i] === "'") {
      let j = i + 1, name = '';
      for (;;) {
        const k = s.indexOf("'", j);
        if (k < 0) return null;
        name += s.slice(j, k);
        if (s[k + 1] === "'") { name += "'"; j = k + 2; } else { j = k + 1; break; }
      }
      sheet = name;
      i = j;
    } else {
      const d = s.indexOf('.', i);
      if (d < 0) return null;
      if (d > i) sheet = s.slice(i, d);
      i = d;
    }
    const m = /^\.(\$?)([A-Za-z]{1,3})?(\$?)(\d+)?$/.exec(s.slice(i));
    if (!m || (!m[2] && !m[4])) return null;
    const x = { sheet, ac: !!m[1], ar: !!m[3] };
    if (m[2]) { x.c = colOf(m[2]); if (x.c >= MAXC) return null; }
    if (m[4]) { x.r = +m[4] - 1; if (x.r < 0 || x.r >= MAXR) return null; }
    return x;
  },

  /* the formula (without =) as table:formula */
  write(src) {
    let toks;
    try { toks = Formula.lex(src); } catch (e) { return 'of:=' + src; }   // broken either way
    let out = '', at = 0;
    for (const t of toks) {
      let s = null;
      if (t.t === 'op' && t.v === ',') s = ';';
      else if (t.t === 'b') s = t.v ? 'TRUE()' : 'FALSE()';
      else if (t.t === 'fn') s = (OF_MS.has(t.v) ? 'COM.MICROSOFT.' : '') + t.v + '(';
      else if (t.t === 'a') s = '[' + OdsF.addrOf(t) + ']';
      if (s === null) continue;
      out += src.slice(at, t.s) + s;
      at = t.e;
    }
    return 'of:=' + out + src.slice(at);
  },
  addrOf(t) {
    const sh = t.sheet === null ? '' : '$' + (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(t.sheet) ? t.sheet : "'" + t.sheet.replace(/'/g, "''") + "'");
    const col = p => (p.ac ? '$' : '') + CSV.colName(p.c);
    if (t.cols) return sh + '.' + col(t.a) + '$1:.' + col(t.b) + '$' + MAXR;
    const one = p => col(p) + (p.ar ? '$' : '') + (p.r + 1);
    return sh + '.' + one(t.a) + (t.b ? ':.' + one(t.b) : '');
  },

  /* a line of cell text in pieces: {x: text} {s: n spaces} {tab} (runs of spaces, and leading ones, need text:s) */
  segs(line) {
    const out = [];
    let buf = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\t') { if (buf) out.push({ x: buf }); buf = ''; out.push({ tab: true }); continue; }
      if (ch === ' ' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
        let j = i;
        while (line[j] === ' ') j++;
        if (buf) out.push({ x: buf });
        buf = '';
        out.push({ s: j - i });
        i = j - 1;
        continue;
      }
      buf += ch;
    }
    if (buf) out.push({ x: buf });
    return out;
  },
  /* cell text as <text:p> elements, one per line */
  paras(s) {
    return s.split('\n').map(line => '<text:p>' + OdsF.segs(line).map(g => (g.x !== undefined ? xmlEsc(g.x) : g.tab ? '<text:tab/>' : '<text:s' + (g.s > 1 ? ' text:c="' + g.s + '"' : '') + '/>')).join('') + '</text:p>').join('');
  },
};

/* ---- number formats: ODF data styles <-> format codes (the Excel kind, what NumFmt reads) ---- */
const OdsFmt = {
  COLORS: { black: '#000000', blue: '#0000ff', cyan: '#00ffff', green: '#00ff00', magenta: '#ff00ff', red: '#ff0000', white: '#ffffff', yellow: '#ffff00' },
  lit(s) { return s ? '"' + s.replace(/"/g, '"\\""') + '"' : ''; },

  /* a data style element to a format code; styles: name -> element, for the ones its maps apply */
  code(el, styles, inner) {
    const kind = el.localName;
    if (kind === 'boolean-style') return 'General';
    if (kind === 'text-style') return '@';
    const main = OdsFmt.section(el, kind);
    const maps = Array.from(el.children).filter(k => k.namespaceURI === ONS.style && k.localName === 'map');
    if (!maps.length || inner) return main;
    const cond = m => (oat(m, 'style', 'condition') || '').replace(/\s/g, '');
    const sub = m => { const x = styles.get(oat(m, 'style', 'apply-style-name')); return x ? OdsFmt.code(x, styles, true) : main; };
    const ge = maps.find(m => cond(m) === 'value()>=0'), gt = maps.find(m => cond(m) === 'value()>0'), lt = maps.find(m => cond(m) === 'value()<0');
    if (ge) return sub(ge) + ';' + main;
    if (gt && lt) return sub(gt) + ';' + sub(lt) + ';' + main;
    return main;
  },
  section(el, kind) {
    const L = OdsFmt.lit, num = (k, a) => oat(k, 'number', a);
    let out = '', pct = kind === 'percentage-style', first = true;
    const tp = Array.from(el.children).find(k => k.localName === 'text-properties'), color = tp && oat(tp, 'fo', 'color');
    const cname = color && Object.keys(OdsFmt.COLORS).find(n => OdsFmt.COLORS[n] === color.toLowerCase());
    if (cname) out += '[' + cname[0].toUpperCase() + cname.slice(1) + ']';
    const over = kind === 'time-style' && num(el, 'truncate-on-overflow') === 'false';
    const time = s => { const r = over && first ? '[' + s + ']' : s; first = false; return r; };
    for (const k of el.children) {
      if (k.namespaceURI !== ONS.number) continue;
      const n = k.localName, long = num(k, 'style') === 'long';
      if (n === 'text') {
        const t = k.textContent, i = pct ? t.indexOf('%') : -1;
        if (i >= 0) { out += L(t.slice(0, i)) + '%' + L(t.slice(i + 1)); pct = false; } else out += L(t);
      } else if (n === 'number') {
        const dp = num(k, 'decimal-places');
        if (dp === null) { out += 'General'; continue; }
        const d = +dp || 0, minD = Math.min(d, +(num(k, 'min-decimal-places') ?? oat(k, 'loext', 'min-decimal-places') ?? d) || 0);
        const minI = +(num(k, 'min-integer-digits') || 0);
        let ip = '0'.repeat(minI) || '#';
        if (num(k, 'grouping') === 'true') ip = '#,' + '#'.repeat(Math.max(0, 3 - ip.length)) + ip;
        out += ip + (d ? '.' + '0'.repeat(minD) + '#'.repeat(d - minD) : '');
        const f = +(num(k, 'display-factor') || 1);
        for (let x = f; x >= 1000; x /= 1000) out += ',';
      } else if (n === 'scientific-number') {
        const d = +(num(k, 'decimal-places') || 0), minI = +(num(k, 'min-integer-digits') || 1);
        out += ('0'.repeat(minI) || '#') + (d ? '.' + '0'.repeat(d) : '') + 'E+' + '0'.repeat(+(num(k, 'min-exponent-digits') || 2));
      } else if (n === 'fraction') {
        const mi = +(num(k, 'min-integer-digits') || 0), dv = num(k, 'denominator-value');
        out += (mi ? '0'.repeat(mi) : '#') + ' ' + '?'.repeat(+(num(k, 'min-numerator-digits') || 1)) + '/' + (dv || '?'.repeat(+(num(k, 'min-denominator-digits') || 1)));
      } else if (n === 'currency-symbol') out += '[$' + k.textContent.replace(/[\]-]/g, '') + ']';
      else if (n === 'day') out += long ? 'dd' : 'd';
      else if (n === 'month') out += num(k, 'textual') === 'true' ? (long ? 'mmmm' : 'mmm') : (long ? 'mm' : 'm');
      else if (n === 'year') out += long ? 'yyyy' : 'yy';
      else if (n === 'day-of-week') out += long ? 'dddd' : 'ddd';
      else if (n === 'hours') out += time(long ? 'hh' : 'h');
      else if (n === 'minutes') out += time(long ? 'mm' : 'm');
      else if (n === 'seconds') { const d = +(num(k, 'decimal-places') || 0); out += time(long ? 'ss' : 's') + (d ? '.' + '0'.repeat(d) : ''); }
      else if (n === 'am-pm') out += 'AM/PM';
      else if (n === 'text-content') out += '@';
      // era, quarter, week of year: not shown here
    }
    return out || 'General';
  },
  /* the value-type a data style gives numbers */
  vt(el) { return { 'percentage-style': 'percentage', 'currency-style': 'currency', 'date-style': 'date', 'time-style': 'time' }[el.localName] || 'float'; },
  vtOf(code) {
    const k = NumFmt.dateKind(code);
    if (k) return k === 'time' ? 'time' : 'date';
    return /%/.test(NumFmt.bare(NumFmt.sections(code)[0])) ? 'percentage' : 'float';
  },

  /* a format code to data style elements, as XML: the one named name, before it name+P0, name+P1 for its other sections */
  xml(name, code) {
    let secs = NumFmt.sections(code).slice(0, 3);
    if (secs.length > 1 && secs[1] === '') secs = secs.slice(0, 1);
    const kind = NumFmt.dateKind(code);
    if (kind || secs.length === 1) return OdsFmt.one(name, secs[0], kind, []);
    const map = (c, n) => '<style:map style:condition="' + xmlEsc(c) + '" style:apply-style-name="' + n + '"/>';
    if (secs.length === 2) return OdsFmt.one(name + 'P0', secs[0], null, [], true) + OdsFmt.one(name, secs[1], null, [map('value()>=0', name + 'P0')]);
    return OdsFmt.one(name + 'P0', secs[0], null, [], true) + OdsFmt.one(name + 'P1', secs[1], null, [], true) +
      OdsFmt.one(name, secs[2], null, [map('value()>0', name + 'P0'), map('value()<0', name + 'P1')]);
  },
  one(name, sec, kind, maps, volatile) {
    const items = [];   // {t: text} or {el: xml}
    const text = t => { if (t) items.push({ t }); };
    const N = (tag, attrs, body) => items.push({ el: '<number:' + tag + Object.keys(attrs).map(a => ' number:' + a + '="' + xmlEsc(attrs[a]) + '"').join('') + (body === undefined ? '/>' : '>' + xmlEsc(body) + '</number:' + tag + '>') });
    let tag, color = null, over = false;
    if (kind) {
      const d = NumFmt.dateToks(sec);
      color = d.color;
      tag = kind === 'time' ? 'time-style' : 'date-style';
      const L = t => (t.n > (t.k === 'y' ? 2 : 1) ? { style: 'long' } : {});
      for (const t of d.toks) {
        if (t.lit !== undefined) { text(t.lit); continue; }
        switch (t.k) {
          case 'y': N('year', L(t)); break;
          case 'm': N('month', t.n >= 3 ? Object.assign({ textual: 'true' }, t.n === 4 ? { style: 'long' } : {}) : L(t)); break;
          case 'd': N(t.n >= 3 ? 'day-of-week' : 'day', t.n === 2 || t.n >= 4 ? { style: 'long' } : {}); break;
          case 'h': N('hours', L(t)); break;
          case 'M': N('minutes', L(t)); break;
          case 's': N('seconds', L(t)); break;
          case 'f': { const last = items[items.length - 1]; if (last && last.el && last.el.startsWith('<number:seconds')) last.el = last.el.replace('/>', ' number:decimal-places="' + t.n + '"/>'); break; }
          case 'ap': N('am-pm', {}); break;
          case 'el': N(t.u === 'h' ? 'hours' : t.u === 'm' ? 'minutes' : 'seconds', t.n > 1 ? { style: 'long' } : {}); over = true; break;
        }
      }
    } else if (/^\s*@\s*$/.test(NumFmt.bare(sec)) && !maps.length && !volatile) {
      tag = 'text-style';
      items.push({ el: '<number:text-content/>' });
    } else {
      const g = /general/i.exec(sec);
      if (g && /general/i.test(NumFmt.bare(sec))) {   // General, maybe with text around it
        const a = NumFmt.numParts(sec.slice(0, g.index)), b = NumFmt.numParts(sec.slice(g.index + 7));
        color = a.color || b.color;
        tag = 'number-style';
        text(a.pre + a.post);
        N('number', { 'min-integer-digits': '1' });
        text(b.pre + b.post);
      } else {
        const p = NumFmt.numParts(sec);
        color = p.color;
        tag = p.sym ? 'currency-style' : p.pct ? 'percentage-style' : 'number-style';
        const numEl = () => {
          if (!p.pat) return;
          const x = NumFmt.digits(p.pat);
          if (x.sci) return N('scientific-number', { 'decimal-places': x.maxD, 'min-integer-digits': x.minI, 'min-exponent-digits': x.minE });
          const a = { 'decimal-places': x.maxD };
          if (x.minD !== x.maxD) a['min-decimal-places'] = x.minD;
          a['min-integer-digits'] = x.minI;
          if (x.group) a.grouping = 'true';
          if (x.factor > 1) a['display-factor'] = x.factor;
          N('number', a);
        };
        const sym = () => N('currency-symbol', {}, p.sym);
        if (p.sym && p.symAt < p.pre.length) {
          text(p.pre.slice(0, p.symAt)); sym(); text(p.pre.slice(p.symAt + p.sym.length)); numEl(); text(p.post);
        } else if (p.sym) {
          const at = p.symAt - p.pre.length;
          text(p.pre); numEl(); text(p.post.slice(0, at)); sym(); text(p.post.slice(at + p.sym.length));
        } else { text(p.pre); numEl(); text(p.post); }
      }
    }
    // text next to text is one element
    const out = [];
    for (const it of items) {
      const last = out[out.length - 1];
      if (it.t !== undefined && last && last.t !== undefined) last.t += it.t; else out.push(Object.assign({}, it));
    }
    const hex = color && OdsFmt.COLORS[color];
    return '<number:' + tag + ' style:name="' + xmlEsc(name) + '"' + (volatile ? ' style:volatile="true"' : '') + (over && tag === 'time-style' ? ' number:truncate-on-overflow="false"' : '') + '>' +
      (hex ? '<style:text-properties fo:color="' + hex + '"/>' : '') +
      out.map(it => (it.t !== undefined ? '<number:text>' + xmlEsc(it.t) + '</number:text>' : it.el)).join('') + maps.join('') + '</number:' + tag + '>';
  },
};

/* the value attributes of a cell: {attrs: [[ns, name, value]], text: what it shows}, or null for none;
   vt: the value type its style gives numbers; cur: the currency code the cell had; ext: the file knows calcext (LibreOffice's error values) */
function odsValue(v, shown, vt, isF, cur, ext, d1904) {
  if (v === undefined || v === null) return null;
  const a = [];
  let type;
  if (typeof v === 'number') {
    if (!isFinite(v)) return null;
    type = vt === 'currency' && !cur ? 'float' : vt || 'float';
    if (type === 'date' && !(v >= 0 && v < 2958466)) type = 'float';
    a.push(['office', 'value-type', type]);
    if (type === 'date') a.push(['office', 'date-value', OdsBook.dateOut(v, d1904)]);
    else if (type === 'time') a.push(['office', 'time-value', OdsBook.timeOut(v)]);
    else {
      if (type === 'currency') a.push(['office', 'currency', cur]);
      a.push(['office', 'value', String(v)]);
    }
  } else if (typeof v === 'boolean') {
    type = 'boolean';
    a.push(['office', 'value-type', 'boolean'], ['office', 'boolean-value', v ? 'true' : 'false']);
  } else if (v instanceof XErr) {
    if (!ext) return null;
    a.push(['office', 'value-type', 'string'], ['office', 'string-value', ''], ['calcext', 'value-type', 'error']);   // as LibreOffice has them
    return { attrs: a, text: shown };
  } else {
    type = 'string';
    a.push(['office', 'value-type', 'string']);
    if (isF) a.push(['office', 'string-value', v]);
  }
  if (ext) a.push(['calcext', 'value-type', type]);
  return { attrs: a, text: shown };
}

/* ---- an ods file ---- */
class OdsBook extends SheetBook {
  static async open(bytes) {
    const b = new OdsBook();
    b.editable = true;
    b.files = ZIP.read(bytes);
    b.byName = new Map(b.files.map(f => [f.name, f]));
    b.xml = new Map();       // part name -> {doc, decl, ver, saved}
    b.added = new Map();     // styles made for dates: "style/code" -> index
    b.pfx = new Map();
    await b.load();
    return b;
  }

  async load() {
    const mt = this.byName.get('mimetype');
    if (mt) {
      const t = new TextDecoder().decode(await ZIP.inflate(mt)).trim();
      if (!/^application\/vnd\.oasis\.opendocument\.spreadsheet(-template)?$/.test(t)) throw new Error('not a spreadsheet (' + t + ')');
    }
    const man = await this.part('META-INF/manifest.xml');
    if (man && man.doc.getElementsByTagNameNS(ONS.manifest, 'encryption-data').length) throw new Error('password protected files are not supported');
    const cx = this.cx = await this.part('content.xml');
    if (!cx) throw new Error('not a spreadsheet (no content.xml)');
    const root = cx.doc.documentElement, ss = xkid(xkid(root, 'body'), 'spreadsheet');
    if (!ss) throw new Error('not a spreadsheet (no spreadsheet in it)');
    this.ext = root.lookupPrefix(ONS.calcext) !== null;
    const nd = xkid(xkid(ss, 'calculation-settings'), 'null-date');
    this.d1904 = !!nd && oat(nd, 'table', 'date-value') === '1904-01-01';
    const sx = await this.part('styles.xml');
    this.readStyles(sx && xkid(sx.doc.documentElement, 'styles'), xkid(root, 'automatic-styles'), sx && xkid(sx.doc.documentElement, 'automatic-styles'));
    this.sheets = [];
    let cells = 0;
    for (const t of xkids(ss, 'table')) {
      const sh = this.readSheet(t, cells);
      cells += sh.cells.size;
      this.sheets.push(sh);
    }
    if (!this.sheets.length) throw new Error('no sheets in this file');
    let active = null;
    const st = await this.part('settings.xml');
    if (st) for (const it of st.doc.getElementsByTagNameNS(ONS.config, 'config-item')) if (oat(it, 'config', 'name') === 'ActiveTable') { active = it.textContent; break; }
    this.active = this.sheets.find(s => s.name === active) || this.sheets[0];
  }

  /* the styles cells can have: named ones (styles.xml), automatic ones (content.xml);
     LibreOffice also puts data styles that content.xml uses (0.00…) in styles.xml's automatic ones */
  readStyles(named, auto, namedAuto) {
    this.dataStyles = new Map();
    for (const el of namedAuto ? namedAuto.children : []) if (el.namespaceURI === ONS.number) this.dataStyles.set(oat(el, 'style', 'name'), el);
    this.cellStyles = new Map();   // name -> {el, auto}
    this.colPx = new Map();
    this.defStyle = null;
    const scan = (box, isAuto) => {
      for (const el of box ? box.children : []) {
        const name = oat(el, 'style', 'name');
        if (el.namespaceURI === ONS.number) this.dataStyles.set(name, el);
        else if (el.localName === 'default-style' && oat(el, 'style', 'family') === 'table-cell') this.defStyle = el;
        else if (el.localName !== 'style') continue;
        else if (oat(el, 'style', 'family') === 'table-cell') this.cellStyles.set(name, { el, auto: isAuto });
        else if (oat(el, 'style', 'family') === 'table-column') {
          const p = xkid(el, 'table-column-properties'), w = p && oat(p, 'style', 'column-width');
          const px = OdsBook.px(w);
          if (px) this.colPx.set(name, px);
        }
      }
    };
    scan(named, false);
    scan(auto, true);
    this.xfs = [];
    this.xfNames = [];
    this.xfIdx = new Map();
    this.styleIdx(this.cellStyles.has('Default') ? 'Default' : '');
  }
  /* a length (0.889in, 2.258cm, 64pt…) in pixels */
  static px(w) {
    const m = /^([\d.]+)(in|cm|mm|pt|pc|px)$/.exec(w || '');
    if (!m) return 0;
    return Math.max(16, Math.round(+m[1] * { in: 96, cm: 96 / 2.54, mm: 96 / 25.4, pt: 96 / 72, pc: 16, px: 1 }[m[2]]));
  }

  /* the index into xfs of a cell style, by name, with what it takes from its parents */
  styleIdx(name) {
    let i = this.xfIdx.get(name);
    if (i !== undefined) return i;
    const chain = [];
    for (let n = name, guard = 0; n && guard < 30; guard++) {
      const st = this.cellStyles.get(n);
      if (!st) break;
      chain.unshift(st.el);
      n = oat(st.el, 'style', 'parent-style-name');
    }
    if (this.defStyle) chain.unshift(this.defStyle);
    const xf = { fmt: 'General', vt: 'float', b: false, i: false, u: false, s: false, fill: null, align: '' };
    let ds = null, src = null, align = null;
    for (const el of chain) {
      ds = oat(el, 'style', 'data-style-name') || ds;
      const tp = xkid(el, 'text-properties'), cp = xkid(el, 'table-cell-properties'), pp = xkid(el, 'paragraph-properties');
      if (tp) {
        const fw = oat(tp, 'fo', 'font-weight'), fs = oat(tp, 'fo', 'font-style'), ul = oat(tp, 'style', 'text-underline-style'), lt = oat(tp, 'style', 'text-line-through-style');
        if (fw) xf.b = fw === 'bold' || +fw >= 600;
        if (fs) xf.i = fs === 'italic' || fs === 'oblique';
        if (ul) xf.u = ul !== 'none';
        if (lt) xf.s = lt !== 'none';
      }
      if (cp) {
        const bg = oat(cp, 'fo', 'background-color');
        if (bg) xf.fill = /^#[0-9a-f]{6}$/i.test(bg) ? bg : null;
        src = oat(cp, 'style', 'text-align-source') || src;
      }
      if (pp) align = oat(pp, 'fo', 'text-align') || align;
    }
    if (align && src !== 'value-type') xf.align = { start: 'l', left: 'l', center: 'c', end: 'r', right: 'r', justify: 'l' }[align] || '';
    const d = ds && this.dataStyles.get(ds);
    if (d) { xf.fmt = OdsFmt.code(d, this.dataStyles); xf.vt = OdsFmt.vt(d); }
    xf.date = NumFmt.dateKind(xf.fmt);
    i = this.xfs.length;
    this.xfs.push(xf);
    this.xfNames.push(name);
    this.xfIdx.set(name, i);
    return i;
  }

  /* runs: [{r0, r1, s: the row's default style or -1, cells: [{a, b, s}]}], the cell styles, row by row;
     rowIx: [{r0, n, el}] and colEls: [{c0, n, el}], where the elements are, for patching */
  readSheet(t, before) {
    const sh = SheetBook.sheet(oat(t, 'table', 'name') || 'Sheet' + (this.sheets.length + 1));
    Object.assign(sh, { t, runs: [], rowIx: [], colEls: [], fixed: new Map(), defPx: 85 });
    let c = 0;
    const cols = box => {
      for (const k of box.children) {
        if (k.namespaceURI !== ONS.table) continue;
        if (k.localName === 'table-column') {
          const n = +(oat(k, 'table', 'number-columns-repeated') || 1), st = oat(k, 'table', 'style-name'), ds = oat(k, 'table', 'default-cell-style-name');
          const px = (st && this.colPx.get(st)) || sh.defPx, s = ds ? this.styleIdx(ds) : 0;
          sh.colEls.push({ c0: c, n, el: k });
          if (c < MAXC && (px !== sh.defPx || s)) sh.cols.push({ a: c, b: Math.min(c + n, MAXC) - 1, px, s });
          c += n;
        } else if (/^table-(header-columns|columns|column-group)$/.test(k.localName)) cols(k);
      }
    };
    cols(t);
    sh.ncolEl = c;
    let r = 0, budget = 4e6 - before;
    const rows = box => {
      for (const k of box.children) {
        if (k.namespaceURI !== ONS.table || r >= MAXR) continue;
        if (k.localName === 'table-row') {
          const n = Math.min(+(oat(k, 'table', 'number-rows-repeated') || 1), MAXR - r);
          sh.rowIx.push({ r0: r, n, el: k });
          budget -= this.readRow(sh, k, r, n, budget);
          r += n;
        } else if (/^table-(header-rows|rows|row-group)$/.test(k.localName)) rows(k);
      }
    };
    rows(t);
    return sh;
  }
  readRow(sh, row, r, n, budget) {
    const ds = oat(row, 'table', 'default-cell-style-name');
    const run = { r0: r, r1: r + n - 1, s: ds ? this.styleIdx(ds) : -1, cells: [] };
    let c = 0, used = 0;
    for (const k of row.children) {
      if (!isCellEl(k) || c >= MAXC) continue;
      const m = Math.min(+(oat(k, 'table', 'number-columns-repeated') || 1), MAXC - c), sn = oat(k, 'table', 'style-name');
      const s = sn ? this.styleIdx(sn) : -1;
      if (s >= 0) {
        const last = run.cells[run.cells.length - 1];
        if (last && last.s === s && last.b === c - 1) last.b = c + m - 1; else run.cells.push({ a: c, b: c + m - 1, s });
      }
      if (k.localName === 'table-cell') {
        const cs = +(oat(k, 'table', 'number-columns-spanned') || 1), rs = +(oat(k, 'table', 'number-rows-spanned') || 1);
        if (cs > 1 || rs > 1) for (let i = 0; i < n; i++) SheetBook.span(sh, r + i, c, rs, cs);
      }
      if (k.hasAttributeNS(ONS.office, 'value-type') || k.hasAttributeNS(ONS.table, 'formula') || xkid(k, 'p')) {
        used += n * m;
        if (used > budget) throw new Error('too many cells for the editor here');
        const eff = s >= 0 ? s : run.s >= 0 ? run.s : (sh.colAt(c) || { s: 0 }).s;
        for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) this.readCell(sh, r + i, c + j, k, eff);
      }
      c += m;
    }
    if (run.s >= 0 || run.cells.length) sh.runs.push(run);
    return used;
  }

  readCell(sh, r, c, el, s) {
    const vt = oat(el, 'office', 'value-type');
    let v = null;
    if (oat(el, 'calcext', 'value-type') === 'error') v = new XErr(OdsBook.text(el) || E.value);
    else if (vt === 'float' || vt === 'percentage' || vt === 'currency') { const x = parseFloat(oat(el, 'office', 'value')); v = isNaN(x) ? null : x; }
    else if (vt === 'date') v = OdsBook.dateIn(oat(el, 'office', 'date-value'), this.d1904);
    else if (vt === 'time') v = OdsBook.timeIn(oat(el, 'office', 'time-value'));
    else if (vt === 'boolean') v = /^(true|1)$/i.test(oat(el, 'office', 'boolean-value') || '');
    else if (vt === 'string') { const sv = oat(el, 'office', 'string-value'); v = sv !== null ? sv : OdsBook.text(el); }
    else if (!vt) v = OdsBook.text(el) || null;
    if (v === null && vt) v = OdsBook.text(el) || null;   // a value that cannot be read (PT-2147483648H…): what it showed
    const cell = { s, v, f: null, keep: false };
    const fa = oat(el, 'table', 'formula');
    let raw;
    if (fa) {
      const x = OdsF.read(fa, el);
      raw = '=' + x.text;
      cell.f = raw;
      cell.keep = !x.ok || el.hasAttributeNS(ONS.table, 'number-matrix-columns-spanned');
    } else raw = this.rawOf(v, s);
    this.cell(sh, r, c, cell, raw);
  }

  /* the text of a cell: its paragraphs, one per line */
  static text(el) {
    const out = [];
    for (const p of el.children) if (p.namespaceURI === ONS.text && (p.localName === 'p' || p.localName === 'h')) out.push(OdsBook.inline(p));
    return out.join('\n');
  }
  static inline(n) {
    let s = '';
    for (const k of n.childNodes) {
      if (k.nodeType === 3 || k.nodeType === 4) s += k.nodeValue.replace(/[ \t\r\n]+/g, ' ');
      else if (k.nodeType !== 1) continue;
      else if (k.namespaceURI === ONS.text && k.localName === 's') s += ' '.repeat(+(oat(k, 'text', 'c') || 1));
      else if (k.namespaceURI === ONS.text && k.localName === 'tab') s += '\t';
      else if (k.namespaceURI === ONS.text && k.localName === 'line-break') s += '\n';
      else if (k.namespaceURI === ONS.office && k.localName === 'annotation') continue;
      else s += OdsBook.inline(k);
    }
    return s;
  }
  /* 2025-06-26T14:30:00 and PT14H30M00S to serial numbers, and back */
  static dateIn(s, d1904) {
    const m = /^(\d{4,})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?/.exec(s || '');
    return m ? XDate.serial(+m[1], +m[2], +m[3], +m[4] || 0, +m[5] || 0, +m[6] || 0, d1904) : null;
  }
  static timeIn(s) {
    const m = /^(-)?P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s || '');
    if (!m) return null;
    const v = (+m[2] || 0) + ((+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0)) / 86400;
    return m[1] ? -v : v;
  }
  static dateOut(v, d1904) {
    const p = XDate.parts(v, d1904, true);
    let s = String(p.y).padStart(4, '0') + '-' + pad2(p.mo) + '-' + pad2(p.d);
    if (p.H || p.Mi || p.S || p.ms) s += 'T' + pad2(p.H) + ':' + pad2(p.Mi) + ':' + pad2(p.S) + (p.ms ? '.' + String(p.ms).padStart(3, '0') : '');
    return s;
  }
  static timeOut(v) {
    const ms = Math.round(Math.abs(v) * 864e5), S = Math.floor(ms / 1000) % 60, Mi = Math.floor(ms / 6e4) % 60, H = Math.floor(ms / 36e5);
    return (v < 0 ? '-' : '') + 'PT' + pad2(H) + 'H' + pad2(Mi) + 'M' + pad2(S) + (ms % 1000 ? '.' + String(ms % 1000).padStart(3, '0') : '') + 'S';
  }

  styleAt(sh, r, c) {
    const k = r * MAXC + c;
    if (sh.pend.has(k)) return sh.pend.get(k);
    if (sh.fixed.has(k)) return sh.fixed.get(k);
    const runs = sh.runs;
    let lo = 0, hi = runs.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1, run = runs[m];
      if (run.r0 > r) hi = m - 1;
      else if (run.r1 < r) lo = m + 1;
      else {
        const cs = run.cells;
        let a = 0, b = cs.length - 1;
        while (a <= b) {
          const x = (a + b) >> 1;
          if (cs[x].a > c) b = x - 1; else if (cs[x].b < c) a = x + 1; else return cs[x].s;
        }
        if (run.s >= 0) return run.s;
        break;
      }
    }
    const col = sh.colAt(c);
    return col ? col.s : 0;
  }

  /* ---- saving ---- */
  /* a qualified name, with the prefix content.xml has for the namespace */
  q(ns, local) {
    let p = this.pfx.get(ns);
    if (p === undefined) {
      const root = this.cx.doc.documentElement;
      p = root.lookupPrefix(ONS[ns]);
      if (!p) { p = ns; root.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:' + ns, ONS[ns]); }
      this.pfx.set(ns, p);
    }
    return p + ':' + local;
  }
  set(el, ns, local, v) { el.setAttributeNS(ONS[ns], this.q(ns, local), String(v)); }
  make(ns, local) { return this.cx.doc.createElementNS(ONS[ns], this.q(ns, local)); }
  rep(el, local, n) { if (n > 1) this.set(el, 'table', local, n); else el.removeAttributeNS(ONS.table, local); }

  /* the element of row r, on its own: a repeated row is split around it, rows past the end are added */
  rowEl(sh, r) {
    const ix = sh.rowIx;
    let lo = 0, hi = ix.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1, e = ix[m];
      if (e.r0 > r) { hi = m - 1; continue; }
      if (e.r0 + e.n <= r) { lo = m + 1; continue; }
      if (e.n === 1) return e.el;
      const parts = [];
      if (r > e.r0) parts.push({ r0: e.r0, n: r - e.r0 });
      parts.push({ r0: r, n: 1 });
      if (r < e.r0 + e.n - 1) parts.push({ r0: r + 1, n: e.r0 + e.n - 1 - r });
      let at = e.el.nextSibling;
      parts.forEach((p, j) => {
        p.el = j === 0 ? e.el : e.el.cloneNode(true);
        this.rep(p.el, 'number-rows-repeated', p.n);
        if (j) e.el.parentNode.insertBefore(p.el, at);
      });
      ix.splice(m, 1, ...parts);
      return parts.find(p => p.r0 === r).el;
    }
    const last = ix[ix.length - 1], end = last ? last.r0 + last.n : 0;
    let parent = sh.t, at = Array.from(sh.t.children).find(k => /^(named-expressions|database-ranges|conditional-formats)$/.test(k.localName)) || null;
    if (last) {
      parent = last.el.parentNode;
      at = last.el.nextSibling;
      if (parent.localName === 'table-header-rows') { at = parent.nextSibling; parent = parent.parentNode; }   // not printed on every page
    }
    const add = n => {
      const row = this.make('table', 'table-row');
      this.rep(row, 'number-rows-repeated', n);
      row.appendChild(this.make('table', 'table-cell'));
      parent.insertBefore(row, at);
      ix.push({ r0: ix.length ? ix[ix.length - 1].r0 + ix[ix.length - 1].n : 0, n, el: row });
      return row;
    };
    if (r > end) add(r - end);
    return add(1);
  }

  /* the element of the cell, on its own, the same way */
  cellEl(sh, r, c) {
    const row = this.rowEl(sh, r);
    let x = 0;
    for (const k of Array.from(row.children)) {
      if (!isCellEl(k)) continue;
      const n = +(oat(k, 'table', 'number-columns-repeated') || 1);
      if (c >= x + n) { x += n; continue; }
      if (n > 1) {
        if (c > x) { const b = k.cloneNode(true); this.rep(b, 'number-columns-repeated', c - x); row.insertBefore(b, k); }
        if (c < x + n - 1) { const a = k.cloneNode(true); this.rep(a, 'number-columns-repeated', x + n - 1 - c); row.insertBefore(a, k.nextSibling); }
        this.rep(k, 'number-columns-repeated', 1);
      }
      return k;
    }
    if (c > x) { const f = this.make('table', 'table-cell'); this.rep(f, 'number-columns-repeated', c - x); row.appendChild(f); }
    const el = this.make('table', 'table-cell');
    row.appendChild(el);
    this.widen(sh, c + 1);
    return el;
  }
  /* the table declares at least n columns */
  widen(sh, n) {
    if (sh.ncolEl >= n) return;
    const el = this.make('table', 'table-column'), last = sh.colEls[sh.colEls.length - 1];
    this.rep(el, 'number-columns-repeated', n - sh.ncolEl);
    if (last) last.el.parentNode.insertBefore(el, last.el.nextSibling);
    else sh.t.insertBefore(el, Array.from(sh.t.children).find(k => /^table-(row|rows|header-rows|row-group)$/.test(k.localName)) || null);
    sh.colEls.push({ c0: sh.ncolEl, n: n - sh.ncolEl, el });
    sh.ncolEl = n;
  }

  /* one cell of content.xml to what raw says */
  patch(sh, r, c, raw, calc) {
    const k = r * MAXC + c, t = typed(raw, this.d1904);
    let cell = sh.cells.get(k);
    if (!cell && t.k === '' && !sh.pend.has(k)) return;
    const el = this.cellEl(sh, r, c);
    if (!cell) { cell = { s: 0, v: null, f: null, keep: false }; sh.cells.set(k, cell); }
    if (sh.pend.has(k)) {
      const s = sh.pend.get(k), name = this.xfNames[s];
      if (name) this.set(el, 'table', 'style-name', name); else el.removeAttributeNS(ONS.table, 'style-name');
      sh.fixed.set(k, s);
      sh.pend.delete(k);
    }
    cell.s = this.styleAt(sh, r, c);
    const cur = oat(el, 'office', 'currency');
    for (const [ns, a] of [['office', 'value-type'], ['office', 'value'], ['office', 'date-value'], ['office', 'time-value'], ['office', 'boolean-value'],
      ['office', 'string-value'], ['office', 'currency'], ['calcext', 'value-type'], ['table', 'formula'], ['table', 'number-matrix-columns-spanned'], ['table', 'number-matrix-rows-spanned']]) el.removeAttributeNS(ONS[ns], a);
    for (const ch of Array.from(el.children)) if (ch.namespaceURI === ONS.text) el.removeChild(ch);
    let v = t.k === 'f' ? calc.value(sh, r, c) : t.k === 'e' ? new XErr(t.v) : t.k === '' ? null : t.v;
    if (t.k === 'f') {
      this.set(el, 'table', 'formula', OdsF.write(t.v));
      if (sh.nofn.has(k) || (v instanceof XErr && v.e === E.circ)) v = undefined;   // left for the next program that opens it
    }
    cell.f = t.k === 'f' ? raw : null;
    cell.keep = false;
    cell.v = v === undefined ? null : v;
    const out = odsValue(v, this.show(v, cell.s), (this.xfs[cell.s] || {}).vt, t.k === 'f', cur, this.ext, this.d1904);
    if (out) {
      for (const [ns, a, val] of out.attrs) this.set(el, ns, a, val);
      const doc = el.ownerDocument;
      for (const line of out.text.split('\n')) {
        const p = this.make('text', 'p');
        for (const g of OdsF.segs(line)) {
          if (g.x !== undefined) p.appendChild(doc.createTextNode(g.x));
          else if (g.tab) p.appendChild(this.make('text', 'tab'));
          else { const sp = this.make('text', 's'); if (g.s > 1) this.set(sp, 'text', 'c', g.s); p.appendChild(sp); }
        }
        el.appendChild(p);
      }
    }
    if (t.k === '') sh.cells.delete(k);
  }

  /* the cell's style, with a data style that shows a date (or a percentage) the way it was typed */
  fmtStyle(sh, r, c, code) {
    const s = this.styleAt(sh, r, c), key = s + '/' + code;
    if (this.added.has(key)) return this.added.get(key);
    const doc = this.cx.doc, root = doc.documentElement;
    let auto = xkid(root, 'automatic-styles');
    if (!auto) { auto = this.make('office', 'automatic-styles'); root.insertBefore(auto, xkid(root, 'body')); }
    const unused = (p, m) => { let i = 1; while (m.has(p + i)) i++; return p + i; };
    let ds = null;
    for (const [n, el] of this.dataStyles) if (OdsFmt.code(el, this.dataStyles) === code) { ds = n; break; }
    if (!ds) {
      ds = unused('N', this.dataStyles);
      const frag = new DOMParser().parseFromString('<x xmlns:number="' + ONS.number + '" xmlns:style="' + ONS.style + '" xmlns:fo="' + ONS.fo + '">' + OdsFmt.xml(ds, code) + '</x>', 'application/xml');
      for (const el of Array.from(frag.documentElement.children)) {
        const x = doc.importNode(el, true);
        auto.insertBefore(x, auto.firstChild);
        this.dataStyles.set(oat(x, 'style', 'name'), x);
      }
    }
    const base = this.xfNames[s], st = base && this.cellStyles.get(base);
    let el;
    if (st && st.auto) el = st.el.cloneNode(true);
    else {
      el = this.make('style', 'style');
      this.set(el, 'style', 'family', 'table-cell');
      if (base) this.set(el, 'style', 'parent-style-name', base);
    }
    const name = unused('ce', this.cellStyles);
    this.set(el, 'style', 'name', name);
    this.set(el, 'style', 'data-style-name', ds);
    auto.appendChild(el);
    this.cellStyles.set(name, { el, auto: true });
    this.touch(this.cx);
    const i = this.styleIdx(name);
    this.added.set(key, i);
    return i;
  }

  /* the file with every changed cell, and every formula whose result moved, written into content.xml.
     Returns {bytes, done()}; done() after the upload made it. */
  async build(calc) {
    calc.reset();
    calc.all();
    const sets = [];
    for (const sh of this.sheets) {
      const keys = new Set([...sh.changed, ...sh.pend.keys()]);
      sh.rows.forEach((row, r) => row.forEach((raw, c) => {
        if (!raw || raw[0] !== '=') return;
        const k = r * MAXC + c, cell = sh.cells.get(k);
        if (!cell || !SheetBook.same(calc.value(sh, r, c), cell.v) || sh.nofn.has(k)) keys.add(k);
      }));
      for (const k of keys) {
        const r = Math.floor(k / MAXC), c = k % MAXC, raw = (sh.rows[r] && sh.rows[r][c]) || '';
        this.patch(sh, r, c, raw, calc);
        if (sh.changed.has(k)) sets.push([sh, k, raw]);
      }
      if (keys.size) this.touch(this.cx);
    }
    const files = [], vers = [];
    for (const f of this.files) {
      const x = this.xml.get(f.name);
      if (x && x.ver !== x.saved) {
        const s = new XMLSerializer().serializeToString(x.doc);
        vers.push([x, x.ver]);
        files.push(await ZIP.entry(f, new TextEncoder().encode(x.decl + s.replace(/^<\?xml[^>]*\?>\s*/, ''))));
      } else files.push(f);
    }
    return {
      bytes: ZIP.write(files),
      done: () => {
        this.files = files;
        this.byName = new Map(files.map(f => [f.name, f]));
        for (const [x, v] of vers) x.saved = v;
        for (const [sh, k, raw] of sets) {
          if (raw) sh.base.set(k, raw); else sh.base.delete(k);
          const r = Math.floor(k / MAXC), c = k % MAXC;
          if (((sh.rows[r] && sh.rows[r][c]) || '') === raw) sh.changed.delete(k);
        }
      },
    };
  }
}

/* ---- a new ods from any workbook: an xlsx to edit here, or an empty one ---- */
const OdsOut = {
  NS: ['office', 'style', 'text', 'table', 'fo', 'number', 'of', 'calcext'].map(p => ' xmlns:' + p + '="' + ONS[p] + '"').join(''),

  async write(book, calc) {
    const T = '<?xml version="1.0" encoding="UTF-8"?>\n';
    const dataXml = [], styleXml = [], colXml = [];
    const dataNames = new Map(), cellNames = new Map(), cellKeys = new Map(), colNames = new Map();
    const dataStyle = code => {
      let n = dataNames.get(code);
      if (!n) { n = 'N' + (dataNames.size + 1); dataNames.set(code, n); dataXml.push(OdsFmt.xml(n, code)); }
      return n;
    };
    const vts = new Map();   // book style -> value type
    const cellStyle = s => {
      let n = cellNames.get(s);
      if (n !== undefined) return n;
      const x = book.xfs[s] || {}, general = !x.fmt || /^general$/i.test(x.fmt);
      vts.set(s, general ? 'float' : OdsFmt.vtOf(x.fmt));
      const key = [general ? '' : x.fmt, !!x.b, !!x.i, !!x.u, !!x.s, x.fill || '', x.align || ''].join('|');
      if (key === '|false|false|false|false||') n = '';
      else if (cellKeys.has(key)) n = cellKeys.get(key);
      else {
        n = 'ce' + (cellKeys.size + 1);
        cellKeys.set(key, n);
        const al = { l: 'start', c: 'center', r: 'end' }[x.align];
        styleXml.push('<style:style style:name="' + n + '" style:family="table-cell" style:parent-style-name="Default"' + (general ? '' : ' style:data-style-name="' + dataStyle(x.fmt) + '"') + '>' +
          (x.fill || al ? '<style:table-cell-properties' + (x.fill ? ' fo:background-color="' + x.fill + '"' : '') + (al ? ' style:text-align-source="fix"' : '') + '/>' : '') +
          (al ? '<style:paragraph-properties fo:text-align="' + al + '"/>' : '') +
          (x.b || x.i || x.u || x.s ? '<style:text-properties' + (x.b ? ' fo:font-weight="bold"' : '') + (x.i ? ' fo:font-style="italic"' : '') +
            (x.u ? ' style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"' : '') + (x.s ? ' style:text-line-through-style="solid"' : '') + '/>' : '') +
          '</style:style>');
      }
      cellNames.set(s, n);
      return n;
    };
    const colStyle = px => {
      let n = colNames.get(px);
      if (!n) {
        n = 'co' + (colNames.size + 1);
        colNames.set(px, n);
        colXml.push('<style:style style:name="' + n + '" style:family="table-column"><style:table-column-properties fo:break-before="auto" style:column-width="' + (px / 96).toFixed(4) + 'in"/></style:style>');
      }
      return n;
    };
    const tables = book.sheets.map(sh => {
      const { rows, cols } = usedArea(sh), out = [];
      const covered = new Set();
      for (const [k, sp] of sh.spans) for (let i = 0; i < sp.rows; i++) for (let j = 0; j < sp.cols; j++) if (i || j) covered.add(k + i * MAXC + j);
      out.push('<table:table table:name="' + xmlEsc(sh.name) + '" table:style-name="ta1">');
      for (let c = 0; c < Math.max(cols, 1);) {
        const px = sh.px(c), col = sh.colAt(c), ds = col && col.s ? cellStyle(col.s) : '';
        let e = c;
        while (e + 1 < cols && sh.px(e + 1) === px && ((sh.colAt(e + 1) || {}).s || 0) === ((col || {}).s || 0)) e++;
        out.push('<table:table-column table:style-name="' + colStyle(px) + '"' + (e > c ? ' table:number-columns-repeated="' + (e - c + 1) + '"' : '') +
          (ds ? ' table:default-cell-style-name="' + ds + '"' : '') + '/>');
        c = e + 1;
      }
      let gap = 0;
      for (let r = 0; r < rows; r++) {
        const row = sh.rows[r] || [], cells = [];
        let empty = 0;
        const flush = () => { if (empty) cells.push('<table:table-cell' + (empty > 1 ? ' table:number-columns-repeated="' + empty + '"' : '') + '/>'); empty = 0; };
        for (let c = 0; c < cols; c++) {
          const k = r * MAXC + c, raw = row[c] || '', s = book.styleAt(sh, r, c), st = cellStyle(s), sp = sh.spans.get(k), cov = covered.has(k);
          if (!raw && !st && !sp && !cov) { empty++; continue; }
          flush();
          let a = st ? ' table:style-name="' + st + '"' : '', body = '';
          if (sp) a += ' table:number-columns-spanned="' + sp.cols + '" table:number-rows-spanned="' + sp.rows + '"';
          if (raw) {
            const o = cellOut(book, calc, sh, r, c, raw), text = o.text !== null ? o.text : o.arr ? raw.slice(1) : null;
            if (text !== null) {
              a += ' table:formula="' + xmlEsc(OdsF.write(text)) + '"';
              if (o.arr) a += ' table:number-matrix-columns-spanned="' + o.arr.cols + '" table:number-matrix-rows-spanned="' + o.arr.rows + '"';
            }
            const val = odsValue(o.v, book.show(o.v, s), vts.get(s), text !== null, null, true, book.d1904);
            if (val) { a += val.attrs.map(([ns, n, v]) => ' ' + ns + ':' + n + '="' + xmlEsc(v) + '"').join(''); body = OdsF.paras(val.text); }
          }
          const tag = cov ? 'table:covered-table-cell' : 'table:table-cell';
          cells.push('<' + tag + a + (body ? '>' + body + '</' + tag + '>' : '/>'));
        }
        if (!cells.length) { gap++; continue; }
        if (gap) out.push('<table:table-row' + (gap > 1 ? ' table:number-rows-repeated="' + gap + '"' : '') + '><table:table-cell/></table:table-row>');
        gap = 0;
        out.push('<table:table-row>' + cells.join('') + '</table:table-row>');
      }
      if (out[out.length - 1].startsWith('<table:table-column')) out.push('<table:table-row><table:table-cell/></table:table-row>');
      out.push('</table:table>');
      return out.join('');
    });
    const content = T + '<office:document-content' + OdsOut.NS + ' office:version="1.3"><office:automatic-styles>' +
      colXml.join('') + '<style:style style:name="ta1" style:family="table"><style:table-properties table:display="true" style:writing-mode="lr-tb"/></style:style>' +
      dataXml.join('') + styleXml.join('') + '</office:automatic-styles><office:body><office:spreadsheet>' +
      (book.d1904 ? '<table:calculation-settings><table:null-date table:date-value="1904-01-01"/></table:calculation-settings>' : '') +
      tables.join('') + '</office:spreadsheet></office:body></office:document-content>';
    const styles = T + '<office:document-styles' + OdsOut.NS + ' office:version="1.3"><office:styles>' +
      '<style:default-style style:family="table-cell"><style:paragraph-properties style:tab-stop-distance="0.5in"/></style:default-style>' +
      '<style:style style:name="Default" style:family="table-cell"/></office:styles></office:document-styles>';
    const meta = T + '<office:document-meta xmlns:office="' + ONS.office + '" xmlns:meta="' + ONS.meta + '" office:version="1.3"><office:meta><meta:generator>shelf</meta:generator></office:meta></office:document-meta>';
    const settings = T + '<office:document-settings xmlns:office="' + ONS.office + '" xmlns:config="' + ONS.config + '" office:version="1.3"><office:settings>' +
      '<config:config-item-set config:name="ooo:view-settings"><config:config-item-map-indexed config:name="Views"><config:config-item-map-entry>' +
      '<config:config-item config:name="ViewId" config:type="string">view1</config:config-item>' +
      '<config:config-item config:name="ActiveTable" config:type="string">' + xmlEsc(book.active.name) + '</config:config-item>' +
      '</config:config-item-map-entry></config:config-item-map-indexed></config:config-item-set></office:settings></office:document-settings>';
    const entry = (p, t) => '<manifest:file-entry manifest:full-path="' + p + '" manifest:media-type="' + t + '"/>';
    const manifest = T + '<manifest:manifest xmlns:manifest="' + ONS.manifest + '" manifest:version="1.3">' +
      '<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="' + ODS_MIME + '"/>' +
      entry('content.xml', 'text/xml') + entry('styles.xml', 'text/xml') + entry('meta.xml', 'text/xml') + entry('settings.xml', 'text/xml') + '</manifest:manifest>';
    const files = [await ZIP.add('mimetype', ODS_MIME, true)];
    for (const [name, text] of [['content.xml', content], ['styles.xml', styles], ['meta.xml', meta], ['settings.xml', settings], ['META-INF/manifest.xml', manifest]]) files.push(await ZIP.add(name, text));
    return ZIP.write(files);
  },

  /* an empty spreadsheet */
  blank() {
    const b = new SheetBook(), sh = SheetBook.sheet('Sheet1');
    sh.defPx = 85;
    Object.assign(b, { sheets: [sh], active: sh, xfs: [{ fmt: 'General' }], d1904: false, styleAt: () => 0 });
    return OdsOut.write(b, new Calc(b));
  },
};
