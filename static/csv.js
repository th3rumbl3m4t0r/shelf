/* CSV: reading, writing, and the grid editor. */
'use strict';

const CSV = {
  /* RFC 4180, forgiving: quotes only count at the start of a field */
  parse(text, d, max) {
    const rows = [], n = text.length;
    let row = [], i = 0;
    const scan = from => {
      let e = from;
      while (e < n) { const ch = text[e]; if (ch === d || ch === '\n' || ch === '\r') break; e++; }
      return e;
    };
    while (i < n) {
      if (text.charCodeAt(i) === 34) {
        let j = i + 1, s = '';
        for (;;) {
          const k = text.indexOf('"', j);
          if (k < 0) { s += text.slice(j); i = n; break; }
          s += text.slice(j, k);
          if (text.charCodeAt(k + 1) === 34) { s += '"'; j = k + 2; continue; }
          i = k + 1;
          break;
        }
        const e = scan(i);
        row.push(s + text.slice(i, e));
        i = e;
      } else {
        const e = scan(i);
        row.push(text.slice(i, e));
        i = e;
      }
      if (i >= n) { rows.push(row); row = null; break; }
      if (text[i] === d) {
        i++;
        if (i >= n) { row.push(''); rows.push(row); row = null; }
        continue;
      }
      if (text[i] === '\r' && text[i + 1] === '\n') i++;
      i++;
      rows.push(row);
      row = [];
      if (max && rows.length >= max) return rows;
    }
    if (row && row.length) rows.push(row);
    return rows;
  },

  stringify(rows, d, eol) {
    const special = new RegExp('["\\r\\n' + (d === '\t' ? '\\t' : d.replace(/[|\\^$.*+?()[\]{}]/g, '\\$&')) + ']');
    const f = v => (special.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
    return rows.map(r => r.map(f).join(d)).join(eol) + (rows.length ? eol : '');
  },

  /* the delimiter that splits the first lines into the most equal, >1 fields */
  detect(text) {
    const sample = text.slice(0, 32768);
    let best = ',', bestScore = -1;
    for (const d of [',', ';', '\t', '|']) {
      const rows = CSV.parse(sample, d, 60);
      if (rows.length > 1 && sample.length < text.length) rows.pop();
      const n = rows.length ? rows[0].length : 0;
      if (n < 2) continue;
      const same = rows.filter(r => r.length === n).length / rows.length;
      const score = same * 100 + Math.min(n, 50);
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  },

  colName(c) {
    let s = '';
    c++;
    while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
    return s;
  },

  /* "1 234,5" and "1,234.5" are numbers; anything else is not */
  num(v) {
    if (v === undefined || v === null) return NaN;
    let s = String(v).trim().replace(/\s/g, '');
    if (!s || !/^[+-]?[\d.,]+(e[+-]?\d+)?%?$/i.test(s)) return NaN;
    if (s.endsWith('%')) s = s.slice(0, -1);
    const c = s.lastIndexOf(','), p = s.lastIndexOf('.');
    if (c > p) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
    const x = Number(s);
    return Number.isFinite(x) ? x : NaN;
  },
};

const RH = 22;   // row height, px
const NW = 56;   // row number column, px

function escHtml(s) {
  return s.replace(/[&<>"]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

/* The grid. host gets a toolbar and the table; opts = {readonly, name,
   onChange(dirty), onStatus(text)}. text() gives the CSV to save. */
class CsvGrid {
  constructor(host, text, opts) {
    this.opts = opts || {};
    this.ro = !!this.opts.readonly;
    this.filter = '';
    this.colf = new Map();   // column filters, by column: see colTest
    this.undos = [];
    this.redos = [];
    this.saved = 0;      // undo depth at the last save
    this.cur = { r: 0, c: 0 };
    this.anc = { r: 0, c: 0 };
    this.edit = null;
    this.load(text);
    this.build(host);
    this.refresh();
  }

  /* rows, ncols, widths and header from the file */
  load(text) {
    this.bom = text.startsWith('\uFEFF');
    if (this.bom) text = text.slice(1);
    this.eol = text.includes('\r\n') ? '\r\n' : '\n';
    this.delim = extOf(this.opts.name || '') === 'tsv' ? '\t' : CSV.detect(text);
    this.rows = CSV.parse(text, this.delim);
    this.ncols = Math.max(1, ...this.rows.slice(0, 5000).map(r => r.length), this.rows.length ? 0 : 6);
    for (const r of this.rows) if (r.length > this.ncols) this.ncols = r.length;
    if (!this.rows.length) for (let i = 0; i < 30; i++) this.rows.push([]);
    this.header = this.rows.length > 1 && this.looksLikeHeader();
    this.widths = [];
    this.autoWidths();
  }

  looksLikeHeader() {
    const a = this.rows[0], b = this.rows[1];
    if (!a || !b) return false;
    // no numbers on top, but some below; or every top cell filled with a short label
    const numTop = a.some(v => !isNaN(CSV.num(v)));
    const numBelow = b.some(v => !isNaN(CSV.num(v)));
    return (!numTop && numBelow) || (!numTop && a.length > 1 && a.every(v => v && v.length < 40));
  }

  autoWidths() {
    const sample = this.rows.slice(0, 300);
    for (let c = 0; c < this.ncols; c++) {
      let m = 3;
      for (const r of sample) { const v = r[c]; if (v && v.length > m) m = v.length; }
      this.widths[c] = Math.max(48, Math.min(320, Math.round(m * 7.4 + 14)));
    }
  }

  /* ---- data ---- */
  get(d, c) { const r = this.rows[d]; return (r && r[c]) || ''; }

  text() {
    let rows = this.rows.map(r => { const o = r.slice(0, this.ncols); while (o.length < this.ncols) o.push(''); return o; });
    // trailing empty rows and columns are the grid's, not the file's
    while (rows.length && rows[rows.length - 1].every(v => v === '')) rows.pop();
    let w = this.ncols;
    while (w > 1 && rows.every(r => r[w - 1] === '')) w--;
    if (w < this.ncols) rows = rows.map(r => r.slice(0, w));
    return (this.bom ? '\uFEFF' : '') + CSV.stringify(rows, this.delim, this.eol);
  }

  markSaved() { this.saved = this.undos.length; this.delimChanged = false; this.changed(); }
  get dirty() { return this.undos.length !== this.saved || this.delimChanged; }

  exec(cmd) {
    if (this.ro) return;
    cmd.redo();
    this.undos.push(cmd);
    if (this.undos.length > 300) { this.undos.shift(); this.saved--; }
    this.redos = [];
    this.refresh();
    this.changed();
  }
  undo() { const c = this.undos.pop(); if (!c) return; c.undo(); this.redos.push(c); this.refresh(); this.changed(); }
  redo() { const c = this.redos.pop(); if (!c) return; c.redo(); this.undos.push(c); this.refresh(); this.changed(); }
  changed() {
    if (this.opts.onChange) this.opts.onChange(this.dirty);
    this.bUndo.disabled = !this.undos.length;
    this.bRedo.disabled = !this.redos.length;
  }

  /* [[dataRow, col, value], …] */
  setCells(list) {
    const old = list.map(([d, c]) => [d, c, this.get(d, c)]);
    const oldN = this.ncols;
    const apply = l => l.forEach(([d, c, v]) => {
      const r = this.rows[d];
      while (r.length <= c) r.push('');
      r[c] = v;
      if (c >= this.ncols) { this.ncols = c + 1; this.fillWidths(); }
    });
    this.exec({ redo: () => apply(list), undo: () => { apply(old); this.ncols = oldN; } });
  }
  fillWidths() { while (this.widths.length < this.ncols) this.widths.push(90); }

  insertRows(at, n) {
    this.exec({
      redo: () => { const add = []; for (let i = 0; i < n; i++) add.push([]); this.rows.splice(at, 0, ...add); },
      undo: () => { this.rows.splice(at, n); },
    });
  }
  deleteRows(ds) {
    ds = ds.slice().sort((a, b) => a - b);
    const saved = ds.map(d => this.rows[d]);
    this.exec({
      redo: () => { for (let i = ds.length - 1; i >= 0; i--) this.rows.splice(ds[i], 1); },
      undo: () => { ds.forEach((d, i) => this.rows.splice(d, 0, saved[i])); },
    });
  }
  insertCol(at) {
    this.exec({
      redo: () => { for (const r of this.rows) if (r.length > at) r.splice(at, 0, ''); this.ncols++; this.widths.splice(at, 0, 90); },
      undo: () => { for (const r of this.rows) if (r.length > at) r.splice(at, 1); this.ncols--; this.widths.splice(at, 1); },
    });
  }
  deleteCols(at, n) {
    if (n >= this.ncols) n = this.ncols - 1;
    if (n <= 0) return;
    const saved = this.rows.map(r => r.slice(at, at + n));
    const sw = this.widths.slice(at, at + n);
    this.exec({
      redo: () => { for (const r of this.rows) r.splice(at, n); this.ncols -= n; this.widths.splice(at, n); },
      undo: () => {
        this.rows.forEach((r, i) => { while (r.length < at) r.push(''); r.splice(at, 0, ...saved[i]); });
        this.ncols += n;
        this.widths.splice(at, 0, ...sw);
      },
    });
  }
  sort(c, desc) {
    const before = this.rows.slice();
    const head = this.header ? this.rows.slice(0, 1) : [];
    const body = this.rows.slice(head.length);
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const key = r => r[c] || '';
    body.sort((a, b) => {
      const x = key(a), y = key(b);
      if (x === '' || y === '') return x === y ? 0 : x === '' ? 1 : -1;   // empty last, both ways
      const nx = CSV.num(x), ny = CSV.num(y);
      const r = !isNaN(nx) && !isNaN(ny) ? nx - ny : coll.compare(x, y);
      return desc ? -r : r;
    });
    const after = head.concat(body);
    this.exec({ redo: () => { this.rows = after.slice(); }, undo: () => { this.rows = before.slice(); } });
  }

  /* ---- view: which data rows show, in which order ---- */
  refresh() {
    const start = this.header ? 1 : 0, test = this.rowTest();
    const v = [];
    for (let d = start; d < this.rows.length; d++) {
      if (test && (!this.rows[d].some(Boolean) || !test(d))) continue;   // filtering hides empty rows too
      v.push(d);
    }
    this.view = v;
    this.clamp();
    this.layout();
    this.render();
  }
  get filtered() { return !!this.filter || this.colf.size > 0; }
  /* the filter box and the column filters as one test on data rows, but for column skip; null for none */
  rowTest(skip) {
    const ts = [], t = this.filter ? this.parseFilter(this.filter) : null;
    if (t) ts.push(t);
    for (const [c, f] of this.colf) if (c !== skip) ts.push(this.colTest(c, f));
    return ts.length ? d => ts.every(t => t(d)) : null;
  }
  /* what a cell shows, the name of a column, a number typed into the filter; the sheet editor has its own */
  cellText(d, c) { return this.get(d, c); }
  headText(c) { return this.get(0, c); }
  numIn(s) { return CSV.num(s); }

  /* the filter as a test on data rows, null for none: text anywhere in the row; or for one column,
     by header name or letters: col:text (contains) col!:text col=x col<>x col<x col>=x…; several with ; between */
  parseFilter(q) {
    const tests = [], coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    for (let part of q.split(';')) {
      part = part.trim();
      if (!part) continue;
      const re = /<=|>=|<>|!=|!:|=|<|>|:/g;
      let t = null, m;
      while (!t && (m = re.exec(part))) {
        const c = this.colIn(part.slice(0, m.index).trim());
        if (c >= 0) t = this.test(c, m[0], part.slice(m.index + m[0].length).trim(), coll);
      }
      if (!t) {
        const low = part.toLowerCase();
        t = d => this.rows[d].some((x, c) => x && this.cellText(d, c).toLowerCase().includes(low));
      }
      tests.push(t);
    }
    return tests.length ? d => tests.every(t => t(d)) : null;
  }
  /* a column named in the filter, -1 for none */
  colIn(s) {
    if (!s) return -1;
    const low = s.toLowerCase();
    if (this.header) for (let c = 0; c < this.ncols; c++) if (this.headText(c).trim().toLowerCase() === low) return c;
    if (!/^[a-z]{1,3}$/i.test(s)) return -1;
    let c = 0;
    for (const ch of s.toUpperCase()) c = c * 26 + ch.charCodeAt(0) - 64;
    return c - 1 < this.ncols ? c - 1 : -1;
  }
  /* numbers compare as numbers (and then text that is not one never matches, but for <>), anything else as text */
  test(c, op, x, coll) {
    const n = x === '' ? NaN : this.numIn(x), low = x.toLowerCase();
    const same = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
    const eq = d => {
      const v = isNaN(n) ? NaN : this.numAt(d, c);
      return isNaN(v) ? coll.compare(this.cellText(d, c), x) === 0 : same(v, n);
    };
    const has = f => d => f(this.cellText(d, c).toLowerCase());
    if (op === ':' || op === '!:') return has(t => t.includes(low) === (op === ':'));
    if (op === '^' || op === '!^') return has(t => t.startsWith(low) === (op === '^'));
    if (op === '$' || op === '!$') return has(t => t.endsWith(low) === (op === '$'));
    if (op === '=') return eq;
    if (op === '<>' || op === '!=') return d => !eq(d);
    const ok = { '<': r => r < 0, '>': r => r > 0, '<=': r => r <= 0, '>=': r => r >= 0 }[op];
    if (!isNaN(n)) return d => { const v = this.numAt(d, c); return !isNaN(v) && (same(v, n) ? ok(0) : ok(v - n)); };
    return d => { const t = this.cellText(d, c); return t !== '' && ok(coll.compare(t, x)); };
  }

  clamp() {
    const maxR = Math.max(0, this.view.length - 1), maxC = this.ncols - 1;
    for (const p of [this.cur, this.anc]) { p.r = Math.max(0, Math.min(maxR, p.r)); p.c = Math.max(0, Math.min(maxC, p.c)); }
  }
  range() {
    return {
      r0: Math.min(this.cur.r, this.anc.r), r1: Math.max(this.cur.r, this.anc.r),
      c0: Math.min(this.cur.c, this.anc.c), c1: Math.max(this.cur.c, this.anc.c),
    };
  }

  /* ---- DOM ---- */
  /* the toolbar; b(label, title, fn, cls) makes a button that gives the focus back */
  toolbar(b) {
    const ro = this.ro;
    this.bUndo = b('undo', 'undo (ctrl+z)', () => this.undo());
    this.bRedo = b('redo', 'redo (ctrl+y)', () => this.redo());
    this.delimSel = h('select', { title: 'delimiter used when saving', disabled: ro },
      [[',', 'comma'], [';', 'semicolon'], ['\t', 'tab'], ['|', 'pipe']].map(([v, l]) => h('option', { value: v, text: l })));
    this.delimSel.value = this.delim;
    this.delimSel.addEventListener('change', () => { this.delim = this.delimSel.value; this.delimChanged = true; this.changed(); });
    return h('div', { class: 'toolbar csv-bar' },
      ro ? null : [this.bUndo, this.bRedo, h('span', { class: 'sep' }),
        h('span', { class: 'lbl', text: 'row' }),
        b('+above', 'insert a row above', () => this.addRow(0)), b('+below', 'insert a row below (ctrl+enter)', () => this.addRow(1)),
        b('delete', 'delete the selected rows', () => this.delRows(), 'danger'), h('span', { class: 'sep' }),
        h('span', { class: 'lbl', text: 'col' }),
        b('+left', 'insert a column left', () => this.addCol(0)), b('+right', 'insert a column right', () => this.addCol(1)),
        b('delete', 'delete the selected columns', () => this.delCols(), 'danger'), h('span', { class: 'sep' })],
      b('sort a-z', 'sort by the current column', () => this.sort(this.cur.c, false)),
      b('sort z-a', 'sort by the current column, descending', () => this.sort(this.cur.c, true)),
      this.headerBox(), this.filterBox(),
      h('span', { class: 'lbl', text: 'delimiter' }), this.delimSel);
  }
  filterBox() {
    this.filterIn = h('input', { type: 'search', placeholder: 'filter rows', class: 'csv-filter', spellcheck: false,
      title: 'text anywhere in the row; or for one column, by letter or header name:\nprice>100  B:abc  B!:abc  status=done  city<>Brno  date>=2025-01-01\nseveral with ; between\n(right click a column, or its ▾, for its values)' });
    let ft = null;
    this.filterIn.addEventListener('input', () => {
      clearTimeout(ft);
      ft = setTimeout(() => { this.filter = this.filterIn.value.trim(); this.refresh(); }, 120);
    });
    return this.filterIn;
  }
  headerBox() {
    this.headerCb = h('input', { type: 'checkbox', checked: this.header });
    this.headerCb.addEventListener('change', () => this.setHeader(this.headerCb.checked));
    return h('label', { class: 'chk', title: 'the first row holds column names' }, this.headerCb, ' header');
  }
  setHeader(on) { this.header = on; this.refresh(); }

  build(host) {
    const b = (label, title, fn, cls) => h('button', { text: label, title, class: cls || null, onclick: () => { fn(); this.scroll.focus(); } });
    const bar = this.toolbar(b);
    this.scroll = h('div', { class: 'csv-scroll', tabindex: '0' });
    this.head = h('div', { class: 'csv-head' });
    this.body = h('div', { class: 'csv-body' });
    this.scroll.append(this.head, this.body);
    clear(host).append(bar, this.scroll);
    host.classList.add('csv-host');

    let raf = 0;
    this.scroll.addEventListener('scroll', () => {
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; this.render(); });
    });
    this.scroll.addEventListener('keydown', e => this.key(e));
    this.body.addEventListener('pointerdown', e => this.down(e));
    this.head.addEventListener('pointerdown', e => this.headDown(e));
    this.body.addEventListener('dblclick', e => { if (e.target.closest('.c')) this.startEdit(); });
    this.head.addEventListener('dblclick', e => {
      const hc = e.target.closest('.hc');
      if (hc && !e.target.closest('.af')) this.startEdit(null, +hc.dataset.c);
    });
    this.head.addEventListener('click', e => {
      const af = e.target.closest('.af');
      if (af) { const r = af.getBoundingClientRect(); this.filterMenu(+af.dataset.c, r.left, r.bottom); }
    });
    this.scroll.addEventListener('contextmenu', e => this.context(e));
    this.scroll.addEventListener('pointerdown', e => this.hold(e));
    this.onCopy = e => this.clip(e, false);
    this.onCut = e => this.clip(e, true);
    this.onPaste = e => this.paste(e);
    document.addEventListener('copy', this.onCopy);
    document.addEventListener('cut', this.onCut);
    document.addEventListener('paste', this.onPaste);
    this.ro0 = new ResizeObserver(() => this.render());
    this.ro0.observe(this.scroll);
    this.changed();
  }

  destroy() {
    document.removeEventListener('copy', this.onCopy);
    document.removeEventListener('cut', this.onCut);
    document.removeEventListener('paste', this.onPaste);
    this.ro0.disconnect();
  }

  layout() {
    this.fillWidths();
    this.offs = [];
    let x = NW;
    for (let c = 0; c < this.ncols; c++) { this.offs.push(x); x += this.widths[c]; }
    this.total = x;
    const cols = NW + 'px ' + this.widths.slice(0, this.ncols).map(w => w + 'px').join(' ');
    this.scroll.style.setProperty('--cols', cols);
    this.scroll.style.setProperty('--total', x + 'px');
    this.body.style.height = (this.view.length * RH) + 'px';
    // column letters, and the header row; the ▾ (sort and filter) on the names of columns with something in them, or on the letters
    const names = this.header && this.rows.length, f = c => (this.colf.has(c) ? ' f' : '');
    let used = 0;
    if (names) for (const row of this.rows) { let n = row.length; while (n > used && !row[n - 1]) n--; if (n > used) used = n; }
    const af = c => '<i class="af' + f(c) + '" data-c="' + c + '" title="sort and filter (alt+down)">▾</i>';
    let s = '<div class="r hr"><div class="n corner" title="select all"></div>';
    for (let c = 0; c < this.ncols; c++) s += '<div class="l' + f(c) + '" data-c="' + c + '">' + CSV.colName(c) + (names ? '' : af(c)) + '<i class="rz" data-c="' + c + '"></i></div>';
    s += '</div>';
    if (names) {
      s += '<div class="r hr names"><div class="n">1</div>';
      for (let c = 0; c < this.ncols; c++) {
        const t = this.headText(c), on = c < used || this.colf.has(c);
        s += '<div class="hc' + f(c) + (on ? ' haf' : '') + '" data-c="' + c + '">' + escHtml(t) + (on ? af(c) : '') + '</div>';
      }
      s += '</div>';
    }
    this.head.innerHTML = s;
    this.headH = this.head.offsetHeight || RH;
  }

  render() {
    const s = this.scroll;
    const first = Math.max(0, Math.floor(s.scrollTop / RH) - 4);
    const last = Math.min(this.view.length, first + Math.ceil(s.clientHeight / RH) + 8);
    const { r0, r1, c0, c1 } = this.range();
    const nc = this.ncols;
    let out = '';
    for (let i = first; i < last; i++) {
      const d = this.view[i];
      const rs = i >= r0 && i <= r1;
      out += '<div class="r" style="top:' + (i * RH) + 'px"><div class="n' + (rs ? ' on' : '') + '" data-r="' + i + '">' + (d + 1) + '</div>';
      for (let c = 0; c < nc; c++) {
        let cls = 'c';
        if (rs && c >= c0 && c <= c1) cls += ' sel';
        if (i === this.cur.r && c === this.cur.c) cls += ' cur';
        out += this.cellHtml(i, d, c, cls);
      }
      out += '</div>';
    }
    this.body.innerHTML = out;
    if (this.edit) this.body.appendChild(this.edit.el);
    for (const l of this.head.querySelectorAll('.l')) l.classList.toggle('on', +l.dataset.c >= c0 && +l.dataset.c <= c1);
    this.status();
  }

  cellHtml(i, d, c, cls) {
    const v = this.rows[d][c];
    if (v && !isNaN(CSV.num(v))) cls += ' num';
    return '<div class="' + cls + '" data-r="' + i + '" data-c="' + c + '">' + (v ? escHtml(v.replace(/\r?\n/g, ' ⏎ ')) : '') + '</div>';
  }
  numAt(d, c) { return CSV.num(this.get(d, c)); }
  statusHead() { return this.view.length + ' rows' + (this.filtered ? ' (filtered)' : '') + ' x ' + this.ncols + ' cols'; }

  status() {
    if (!this.opts.onStatus) return;
    const { r0, r1, c0, c1 } = this.range();
    const d = this.view[this.cur.r];
    let t = this.statusHead() + ' | ' + CSV.colName(this.cur.c) + (d === undefined ? '' : d + 1);
    const cells = (r1 - r0 + 1) * (c1 - c0 + 1);
    if (cells > 1 && cells <= 200000) {
      let n = 0, sum = 0;
      for (let i = r0; i <= r1; i++) for (let c = c0; c <= c1; c++) { const x = this.numAt(this.view[i], c); if (!isNaN(x)) { n++; sum += x; } }
      t += ' | ' + cells + ' cells';
      if (n) t += ', sum ' + +sum.toFixed(10) + ', avg ' + +(sum / n).toFixed(6);
    }
    this.opts.onStatus(t);
  }

  /* bring the cursor into view */
  reveal() {
    const s = this.scroll, y = this.cur.r * RH, x = this.offs[this.cur.c], w = this.widths[this.cur.c];
    const vh = s.clientHeight - this.headH;
    if (y < s.scrollTop) s.scrollTop = y;
    else if (y + RH > s.scrollTop + vh) s.scrollTop = y + RH - vh;
    if (x - NW < s.scrollLeft) s.scrollLeft = x - NW;
    else if (x + w > s.scrollLeft + s.clientWidth) s.scrollLeft = x + w - s.clientWidth;
  }

  move(r, c, extend) {
    this.cur = { r, c };
    if (!extend) this.anc = { r, c };
    this.clamp();
    this.reveal();
    this.render();
  }

  cellAt(e) {
    const t = e.target.closest ? e.target.closest('.c, .n') : null;
    if (!t || t.dataset.r === undefined) return null;
    return { r: +t.dataset.r, c: t.classList.contains('n') ? -1 : +t.dataset.c };
  }

  down(e) {
    if (e.button !== 0) return;
    if (this.edit && this.edit.el.contains(e.target)) return;
    const p = this.cellAt(e);
    if (!p) return;
    e.preventDefault();
    this.commit();
    this.scroll.focus();
    if (p.c < 0) {   // row number: whole rows
      if (!e.shiftKey) this.anc = { r: p.r, c: 0 };
      this.cur = { r: p.r, c: this.ncols - 1 };
      this.anc.c = 0;
      this.render();
      return;
    }
    this.move(p.r, p.c, e.shiftKey);
    const mv = ev => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const q = el && this.cellAt({ target: el });
      if (q && q.c >= 0 && (q.r !== this.cur.r || q.c !== this.cur.c)) { this.cur = q; this.render(); }
    };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
  }

  headDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest('.af')) { e.preventDefault(); return; }   // the click opens the menu
    const rz = e.target.closest('.rz');
    if (rz) {   // resize a column
      e.preventDefault();
      const c = +rz.dataset.c, x0 = e.clientX, w0 = this.widths[c];
      const mv = ev => { this.widths[c] = Math.max(30, w0 + ev.clientX - x0); this.layout(); this.render(); };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
      addEventListener('pointermove', mv);
      addEventListener('pointerup', up);
      return;
    }
    const l = e.target.closest('.l');
    if (l) {   // whole column
      e.preventDefault();
      this.commit();
      const c = +l.dataset.c;
      if (!e.shiftKey) this.anc = { r: 0, c };
      this.anc.r = 0;
      this.cur = { r: Math.max(0, this.view.length - 1), c };
      this.render();
      this.scroll.focus();
    } else if (e.target.closest('.corner')) {
      e.preventDefault();
      this.selectAll();
      this.scroll.focus();
    }
  }

  selectAll() {
    this.anc = { r: 0, c: 0 };
    this.cur = { r: Math.max(0, this.view.length - 1), c: this.ncols - 1 };
    this.render();
  }

  key(e) {
    if (this.edit || e.target !== this.scroll) return;   // keys the cell editor already handled bubble up to here
    const k = e.key, ctrl = e.ctrlKey || e.metaKey, sh = e.shiftKey;
    const { r, c } = this.cur;
    const page = Math.max(1, Math.floor((this.scroll.clientHeight - this.headH) / RH) - 1);
    const lastR = Math.max(0, this.view.length - 1), lastC = this.ncols - 1;
    if (e.altKey && k === 'ArrowDown') {   // the column's sort and filter menu, as in a spreadsheet
      e.preventDefault();
      const el = this.body.querySelector('.c.cur'), b = (el || this.scroll).getBoundingClientRect();
      this.filterMenu(c, b.left, el ? b.bottom : b.top + this.headH, this.view[r]);
      return;
    }
    let to = null;
    if (k === 'ArrowDown') to = [ctrl ? lastR : r + 1, c];
    else if (k === 'ArrowUp') to = [ctrl ? 0 : r - 1, c];
    else if (k === 'ArrowRight') to = [r, ctrl ? lastC : c + 1];
    else if (k === 'ArrowLeft') to = [r, ctrl ? 0 : c - 1];
    else if (k === 'PageDown') to = [r + page, c];
    else if (k === 'PageUp') to = [r - page, c];
    else if (k === 'Home') to = ctrl ? [0, 0] : [r, 0];
    else if (k === 'End') to = ctrl ? [lastR, lastC] : [r, lastC];
    else if (k === 'Tab') { e.preventDefault(); this.move(r, sh ? c - 1 : c + 1); return; }
    if (to) { e.preventDefault(); this.move(to[0], to[1], sh); return; }
    if (ctrl && (k === 'z' || k === 'Z')) { e.preventDefault(); if (sh) this.redo(); else this.undo(); return; }
    if (ctrl && (k === 'y' || k === 'Y')) { e.preventDefault(); this.redo(); return; }
    if (ctrl && (k === 'a' || k === 'A')) { e.preventDefault(); this.selectAll(); return; }
    if (ctrl && k === 'Enter') { e.preventDefault(); this.addRow(1); return; }
    if (ctrl || e.altKey) return;
    if (k === 'Enter' || k === 'F2') { e.preventDefault(); this.startEdit(); return; }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); this.clearRange(); return; }
    if (k.length === 1) { e.preventDefault(); this.startEdit(k); }
  }

  /* edit the current cell; hc: a header cell instead */
  startEdit(initial, hc) {
    if (this.ro) return;
    if (hc === undefined && !this.view.length) { this.insertRows(this.rows.length, 1); }
    const d = hc !== undefined ? 0 : this.view[this.cur.r];
    const c = hc !== undefined ? hc : this.cur.c;
    const ta = h('textarea', { class: 'csv-edit', spellcheck: false, rows: 1 });
    ta.value = initial !== undefined && initial !== null ? initial : this.get(d, c);
    if (hc !== undefined) {
      Object.assign(ta.style, { position: 'fixed' });
      const r = this.head.querySelector('.hc[data-c="' + c + '"]').getBoundingClientRect();
      Object.assign(ta.style, { left: r.left + 'px', top: r.top + 'px', width: Math.max(r.width, 120) + 'px' });
      document.body.appendChild(ta);
    } else {
      Object.assign(ta.style, { left: this.offs[c] + 'px', top: (this.cur.r * RH) + 'px', width: Math.max(this.widths[c], 120) + 'px' });
      this.body.appendChild(ta);
    }
    this.edit = { el: ta, d, c, orig: this.get(d, c) };
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); this.cancel(); }
      else if (e.key === 'Enter' && e.altKey) {   // newline in a cell
        e.preventDefault();
        const p = ta.selectionStart;
        ta.value = ta.value.slice(0, p) + '\n' + ta.value.slice(ta.selectionEnd);
        ta.setSelectionRange(p + 1, p + 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const last = this.cur.r >= this.view.length - 1 && !this.filtered && hc === undefined;
        this.commit();
        if (hc !== undefined) return;
        if (last && !e.shiftKey) this.insertRows(this.rows.length, 1);
        this.move(this.cur.r + (e.shiftKey ? -1 : 1), this.cur.c);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        this.commit();
        if (hc === undefined) this.move(this.cur.r, this.cur.c + (e.shiftKey ? -1 : 1));
      }
    });
    ta.addEventListener('blur', () => this.commit(true));
  }

  commit(fromBlur) {
    const ed = this.edit;
    if (!ed) return;
    this.edit = null;
    ed.el.remove();
    if (ed.el.value !== ed.orig) this.setCells([[ed.d, ed.c, ed.el.value]]);
    if (ed.d === 0 && this.header) this.layout();
    if (!fromBlur) this.scroll.focus();
    this.render();
  }
  cancel() {
    const ed = this.edit;
    if (!ed) return;
    this.edit = null;
    ed.el.remove();
    this.scroll.focus();
    this.render();
  }

  clearRange() {
    const { r0, r1, c0, c1 } = this.range(), l = [];
    for (let i = r0; i <= r1; i++) for (let c = c0; c <= c1; c++) if (this.get(this.view[i], c) !== '') l.push([this.view[i], c, '']);
    if (l.length) this.setCells(l);
  }

  addRow(below) {
    if (this.filtered) this.clearFilters();
    const d = this.view.length ? this.view[this.cur.r] + (below ? 1 : 0) : this.rows.length;
    this.insertRows(d, 1);
    this.move(this.view.indexOf(d), this.cur.c);
  }
  delRows() {
    const { r0, r1 } = this.range();
    if (!this.view.length) return;
    this.deleteRows(this.view.slice(r0, r1 + 1));
    this.move(r0, this.cur.c);
  }
  // column filters go with an inserted or deleted column: they would be on the wrong one
  addCol(right) { this.colf.clear(); this.insertCol(this.cur.c + (right ? 1 : 0)); this.layout(); this.move(this.cur.r, this.cur.c + (right ? 1 : 0)); }
  delCols() {
    const { c0, c1 } = this.range();
    this.colf.clear();
    this.deleteCols(c0, c1 - c0 + 1);
    this.layout();
    this.move(this.cur.r, c0);
  }

  /* clipboard: tab separated, like every spreadsheet */
  clip(e, cut) {
    if (document.activeElement !== this.scroll || this.edit) return;
    const { r0, r1, c0, c1 } = this.range(), rows = [];
    for (let i = r0; i <= r1; i++) { const row = []; for (let c = c0; c <= c1; c++) row.push(this.get(this.view[i], c)); rows.push(row); }
    e.clipboardData.setData('text/plain', CSV.stringify(rows, '\t', '\n'));
    e.preventDefault();
    if (cut && !this.ro) this.clearRange();
  }
  paste(e) {
    if (document.activeElement !== this.scroll || this.edit || this.ro) return;
    const t = e.clipboardData.getData('text/plain');
    if (!t) return;
    e.preventDefault();
    this.pasteRows(CSV.parse(t.replace(/\r?\n$/, ''), '\t'));
  }
  /* fix(value, row in data, col in data, dataRow, col): what lands in the cell */
  pasteRows(data, fix) {
    const { r0, r1, c0, c1 } = this.range(), l = [];
    fix = fix || (v => v);
    if (data.length === 1 && data[0].length === 1 && (r1 > r0 || c1 > c0)) {   // one value into a range
      for (let i = r0; i <= r1; i++) for (let c = c0; c <= c1; c++) l.push([this.view[i], c, fix(data[0][0], 0, 0, this.view[i], c)]);
    } else {
      let need = r0 + data.length - this.view.length;
      if (need > 0) {
        if (this.filtered) { toast('clear the filters to paste past the last row', 'warn'); return; }
        const add = [];
        for (let i = 0; i < need; i++) add.push([]);
        this.rows.push(...add);   // part of the same undo step: undoing leaves empty rows, which are not saved
        this.refresh();
      }
      data.forEach((row, i) => row.forEach((v, j) => l.push([this.view[r0 + i], c0 + j, fix(v, i, j, this.view[r0 + i], c0 + j)])));
    }
    this.setCells(l);
    this.layout();
    this.anc = { r: r0, c: c0 };
    this.cur = { r: Math.min(r0 + data.length - 1, this.view.length - 1), c: c0 + Math.max(...data.map(r => r.length)) - 1 };
    this.clamp();
    this.render();
  }

  /* ---- column filters: the ▾ on a column, a right click or a long touch on it, alt+down ---- */
  /* a filter is {show} or {hide}, a Set of what cells show; or {cond: [{op, x}], or} */
  colTest(c, f) {
    if (f.show) return d => f.show.has(this.cellText(d, c));
    if (f.hide) return d => !f.hide.has(this.cellText(d, c));
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const ts = f.cond.map(k => this.condTest(c, k.op, k.x, coll));
    return f.or ? d => ts.some(t => t(d)) : d => ts.every(t => t(d));
  }
  condTest(c, op, x, coll) {
    if (op === 'empty' || op === 'full') return d => (this.cellText(d, c) === '') === (op === 'empty');
    if (op === 'top' || op === 'bottom') {   // the n largest or smallest numbers
      const ns = [];
      for (let d = this.header ? 1 : 0; d < this.rows.length; d++) { const v = this.numAt(d, c); if (!isNaN(v)) ns.push(v); }
      ns.sort((a, b) => (op === 'top' ? b - a : a - b));
      const lim = ns[Math.min(Math.max(1, Math.floor(+x) || 10), ns.length) - 1];
      if (lim === undefined) return () => false;
      return op === 'top' ? d => this.numAt(d, c) >= lim : d => this.numAt(d, c) <= lim;
    }
    return this.test(c, op, x, coll);
  }
  setColf(c, f) { if (f) this.colf.set(c, f); else this.colf.delete(c); this.refresh(); }
  clearFilters() { this.filter = ''; this.filterIn.value = ''; this.colf.clear(); this.refresh(); }
  colTitle(c) { const t = this.header ? this.headText(c) : ''; return CSV.colName(c) + (t ? ' ' + t : ''); }

  /* column c's values (what cells show) on the rows that are not empty. all: value → shown by the column's
     filter now; list: [{v, n rows, num, on}] of the rows the other filters leave, sorted as a sort would */
  colValues(c) {
    const other = this.rowTest(c), f = this.colf.get(c), mine = f ? this.colTest(c, f) : null;
    const all = new Map(), vis = new Map();
    for (let d = this.header ? 1 : 0; d < this.rows.length; d++) {
      if (!this.rows[d].some(Boolean)) continue;
      const v = this.cellText(d, c);
      all.set(v, all.get(v) || !mine || mine(d));
      if (other && !other(d)) continue;
      const e = vis.get(v);
      if (e) e.n++; else vis.set(v, { v, n: 1, num: this.numAt(d, c) });
    }
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const list = Array.from(vis.values()).sort((a, b) => (a.v === '') - (b.v === '') || isNaN(a.num) - isNaN(b.num) ||
      (isNaN(a.num) ? coll.compare(a.v, b.v) : a.num - b.num));
    for (const e of list) e.on = all.get(e.v);
    return { all, list };
  }
  /* column c's filter from each value's fate: keep(value, shown now) */
  keepValues(c, all, keep) {
    const show = new Set(), hide = new Set();
    for (const [v, on] of all) (keep(v, on) ? show : hide).add(v);
    this.setColf(c, !hide.size ? null : hide.size <= show.size ? { hide } : { show });
  }
  /* sort by column c from its menu: the rows around data row d, or the first on show */
  sortBy(c, desc, d) {
    const r = d === undefined ? 0 : Math.max(0, this.view.indexOf(d));
    this.cur = { r, c };
    this.anc = { r, c };
    this.sort(c, desc);
  }

  /* column c's menu at x, y, like a spreadsheet's autofilter: sort, only or not the value of data row d (if
     given), conditions, and the values to tick: the ones hidden now, then the first 50 of those on show, and one
     box for all the others; a search narrows them all (and what is not found is hidden) */
  filterMenu(c, x, y, d) {
    if (this.pop) return;
    this.commit(true);
    const { all, list } = this.colValues(c), f = this.colf.get(c), MAX = 50;
    const st = new Map(list.map(e => [e.v, e.on]));   // ticked, by value
    const label = v => (v === '' ? '(empty)' : v);
    let close = null, hits = list, groups = [];
    const done = fn => () => { close(); fn(); };
    const mi = (text, fn, off) => h('button', { class: 'mi', text, disabled: !!off, onclick: done(fn) });
    const items = [];
    if (!this.ro) items.push(mi('sort ascending', () => this.sortBy(c, false, d)), mi('sort descending', () => this.sortBy(c, true, d)));
    if (d !== undefined) {
      const v = this.cellText(d, c), q = v === '' ? '(empty)' : '"' + (v.length > 24 ? v.slice(0, 23) + '…' : v) + '"';
      items.push(mi('only ' + q, () => this.keepValues(c, all, w => w === v)), mi('not ' + q, () => this.keepValues(c, all, (w, on) => on && w !== v)));
    }
    items.push(mi('by condition…', () => this.condDialog(c)), mi('clear this filter', () => this.setColf(c, null), !f));
    if (this.filter || this.colf.size > (f ? 1 : 0)) items.push(mi('clear all filters', () => this.clearFilters()));

    const search = h('input', { type: 'search', placeholder: 'search values', spellcheck: false });
    const box = h('div', { class: 'af-list' });
    const okB = h('button', { class: 'primary', text: 'ok' });
    const sync = () => {
      for (const [cb, es] of groups) {
        const n = es.reduce((a, e) => a + (st.get(e.v) ? 1 : 0), 0);
        cb.checked = n > 0 && n === es.length;
        cb.indeterminate = n > 0 && n < es.length;
      }
      okB.disabled = !hits.some(e => st.get(e.v));   // nothing would show
    };
    const row = (es, text, cls) => {
      const cb = h('input', { type: 'checkbox' });
      cb.addEventListener('change', () => { for (const e of es) st.set(e.v, cb.checked); sync(); });
      groups.push([cb, es]);
      return h('label', { class: cls || null, title: text }, cb, h('span', { class: 'v', text }), h('span', { class: 'k', text: String(es.reduce((a, e) => a + e.n, 0)) }));
    };
    const draw = () => {
      const s = search.value.trim().toLowerCase();
      hits = s ? list.filter(e => label(e.v).toLowerCase().includes(s)) : list;
      const was = hits.filter(e => !e.on).slice(0, MAX), now = hits.filter(e => e.on).slice(0, MAX);
      const listed = new Set(was.concat(now)), others = hits.filter(e => !listed.has(e));
      groups = [];
      add(clear(box), [
        hits.length ? row(hits, '(select all)', 'grp') : h('div', { class: 'sub', text: 'nothing found' }),
        was.length ? h('div', { class: 'sub', text: 'hidden now' }) : null,
        was.map(e => row([e], label(e.v))),
        others.length ? row(others, 'all ' + others.length + ' others' + (s ? ' found' : ''), 'grp') : null,
        was.length && now.length ? h('div', { class: 'sub', text: 'on show' }) : null,
        now.map(e => row([e], label(e.v)))]);
      box.scrollTop = 0;
      sync();
    };
    const apply = () => {
      const s = search.value.trim().toLowerCase(), listed = new Set(list.map(e => e.v));
      this.keepValues(c, all, (v, on) => (listed.has(v) ? st.get(v) && (!s || label(v).toLowerCase().includes(s)) : on));
    };
    okB.addEventListener('click', done(apply));
    search.addEventListener('input', draw);
    search.addEventListener('keydown', e => { if (e.key === 'Enter' && !okB.disabled) { e.preventDefault(); done(apply)(); } });
    const win = h('div', { class: 'win af-pop' },
      h('div', { class: 'titlebar' }, h('span', { class: 'grip', text: '::' }), h('span', { class: 'af-t', text: this.colTitle(c) }), h('span', { class: 'spacer' }),
        h('button', { class: 'dlg-x', text: 'x', title: 'close (esc)', onclick: () => close() })),
      h('div', { class: 'body' }, h('div', { class: 'af-menu' }, items), search, box),
      h('div', { class: 'dlg-buttons' }, h('button', { text: 'cancel', onclick: () => close() }), okB));
    draw();
    this.pop = win;
    close = popup(x, y, win, () => { this.pop = null; this.scroll.focus(); });
    if (!matchMedia('(pointer: coarse)').matches) search.focus();   // not on a phone: the keyboard would cover the list
  }

  /* column c by one or two conditions */
  async condDialog(c) {
    const f = this.colf.get(c), was = (f && f.cond) || [{ op: '=', x: '' }];
    const OPS = [['=', 'equals'], ['<>', 'does not equal'], ['>', 'greater than'], ['>=', 'greater or equal'], ['<', 'less than'], ['<=', 'less or equal'],
      [':', 'contains'], ['!:', 'does not contain'], ['^', 'begins with'], ['!^', 'does not begin with'], ['$', 'ends with'], ['!$', 'does not end with'],
      ['empty', 'is empty'], ['full', 'is not empty'], ['top', 'largest (how many)'], ['bottom', 'smallest (how many)']];
    const line = (k, none) => {
      const op = h('select', {}, none ? h('option', { value: '', text: '(none)' }) : null, OPS.map(([v, t]) => h('option', { value: v, text: t })));
      const x = h('input', { type: 'text', list: 'af-values', spellcheck: false, value: k ? k.x : '' });
      op.value = k ? k.op : '';
      const upd = () => { x.hidden = ['', 'empty', 'full'].includes(op.value); x.placeholder = op.value === 'top' || op.value === 'bottom' ? '10' : 'value'; };
      op.addEventListener('change', upd);
      upd();
      return { op, x, el: h('div', { class: 'af-cond' }, op, x) };
    };
    const a = line(was[0]), b = line(was[1], true);
    const join = h('select', { class: 'af-join' }, h('option', { value: 'and', text: 'and' }), h('option', { value: 'or', text: 'or' }));
    join.value = f && f.or ? 'or' : 'and';
    const dl = h('datalist', { id: 'af-values' }, this.colValues(c).list.slice(0, 500).map(e => h('option', { value: e.v })));
    const ok = await dialog({
      title: 'filter ' + this.colTitle(c), body: [h('span', { class: 'lbl', text: 'rows where the column' }), a.el, join, b.el, dl],
      buttons: [{ label: 'cancel', value: null }, { label: 'ok', primary: true, value: true }],
    });
    if (!ok) return;
    this.setColf(c, { cond: [a, b].filter(l => l.op.value).map(l => ({ op: l.op.value, x: l.x.value.trim() })), or: join.value === 'or' });
  }

  /* a right click (or a long touch) on a column: its menu, there */
  context(e) {
    if (this.edit && this.edit.el.contains(e.target)) return;
    const t = e.target.closest('.c, .hc, .l');
    if (!t) return;
    e.preventDefault();
    const c = +t.dataset.c;
    let d;
    if (t.classList.contains('c')) {
      const r = +t.dataset.r, { r0, r1, c0, c1 } = this.range();
      if (r < r0 || r > r1 || c < c0 || c > c1) this.move(r, c);   // inside the selection, it stays
      d = this.view[r];
    }
    this.filterMenu(c, e.clientX, e.clientY, d);
  }
  /* not every webview sends contextmenu for a long touch */
  hold(e) {
    if (e.pointerType !== 'touch') return;
    const x = e.clientX, y = e.clientY, target = e.target;
    const stop = () => { clearTimeout(tm); removeEventListener('pointermove', mv); removeEventListener('pointerup', stop); removeEventListener('pointercancel', stop); };
    const mv = ev => { if (Math.abs(ev.clientX - x) + Math.abs(ev.clientY - y) > 12) stop(); };
    const tm = setTimeout(() => {
      stop();
      // the finger lifts over the menu that just opened: not a click on it
      const eat = ev => { ev.preventDefault(); ev.stopPropagation(); };
      const lift = () => { removeEventListener('pointerup', lift, true); removeEventListener('pointercancel', lift, true); setTimeout(() => removeEventListener('click', eat, true), 400); };
      addEventListener('click', eat, true);
      addEventListener('pointerup', lift, true);
      addEventListener('pointercancel', lift, true);
      this.context({ target, clientX: x, clientY: y, preventDefault() {} });
    }, 600);
    addEventListener('pointermove', mv);
    addEventListener('pointerup', stop);
    addEventListener('pointercancel', stop);
  }
}
