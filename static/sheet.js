/* The spreadsheet editor: the CSV grid with a workbook under it. ods files are edited,
   xlsx and xlsm only shown. Needs csv.js, xlsx.js and ods.js. */
'use strict';

/* an ods (it has a mimetype, or content.xml) or an xlsx */
async function openBook(bytes) {
  const names = new Set(ZIP.read(bytes).map(f => f.name));
  return names.has('mimetype') || names.has('content.xml') ? OdsBook.open(bytes) : XlsxBook.open(bytes);
}

class SheetGrid extends CsvGrid {
  static async open(host, bytes, opts) {
    const book = await openBook(bytes);
    return new SheetGrid(host, book, Object.assign({}, opts, { readonly: !!(opts && opts.readonly) || !book.editable }));
  }

  load(book) {
    this.book = book;
    this.calc = new Calc(book);
    this.clipKeep = null;
    this.setSheet(book.active);
  }

  setSheet(sh) {
    this.sh = sh;
    this.rows = sh.rows;
    let used = 0;
    for (const row of sh.rows) if (row.length > used) used = row.length;
    this.ncols = Math.max(used + 2, 26);
    const want = Math.max(sh.rows.length + 40, 100);
    while (sh.rows.length < want) sh.rows.push([]);
    this.widths = [];
    this.fillWidths();
    if (sh.header === undefined) sh.header = this.looksLikeHeader();
    this.header = sh.header;
    if (!sh.colf) sh.colf = new Map();
    this.colf = sh.colf;
    if (this.headerCb) this.headerCb.checked = this.header;
  }
  fillWidths() { while (this.widths.length < this.ncols) this.widths.push(this.sh.px(this.widths.length)); }
  /* column names: text on top, a number under it somewhere */
  looksLikeHeader() {
    const top = [], below = [];
    for (let c = 0; c < this.ncols; c++) { top.push(this.calc.value(this.sh, 0, c)); below.push(this.calc.value(this.sh, 1, c)); }
    const set = top.filter(v => v !== null && v !== '');
    return set.length > 0 && set.every(v => typeof v === 'string') && below.some(v => typeof v === 'number');
  }
  setHeader(on) { this.sh.header = on; super.setHeader(on); }

  showSheet(sh) {
    if (sh === this.sh) return;
    this.commit();
    this.setSheet(sh);
    this.cur = { r: 0, c: 0 };
    this.anc = { r: 0, c: 0 };
    if (this.sheetSel) this.sheetSel.value = String(this.book.sheets.indexOf(sh));
    this.refresh();
    this.scroll.scrollTop = 0;
    this.scroll.scrollLeft = 0;
  }

  toolbar(b) {
    this.bUndo = b(tx('undo'), tx('undo (ctrl+z)'), () => this.undo());
    this.bRedo = b(tx('redo'), tx('redo (ctrl+y)'), () => this.redo());
    this.refEl = h('span', { class: 'sheet-ref' });
    this.fx = h('input', { type: 'text', class: 'sheet-fx', spellcheck: false, readOnly: this.ro, placeholder: this.ro ? '' : tx('value or =formula'),
      title: tx('the cell as typed: enter stores it, esc goes back') });
    this.fx.addEventListener('focus', () => { this.commit(true); this.fxAt = { d: this.view[this.cur.r], c: this.cur.c }; });
    this.fx.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this.fxCommit(); this.scroll.focus(); this.move(this.cur.r + 1, this.cur.c); }
      else if (e.key === 'Escape') { e.preventDefault(); this.fxAt = null; this.scroll.focus(); this.render(); }
    });
    this.fx.addEventListener('blur', () => this.fxCommit());
    this.sheetSel = h('select', { title: tx('sheet') });
    this.sheetSel.addEventListener('change', () => { this.showSheet(this.book.sheets[+this.sheetSel.value]); this.scroll.focus(); });
    this.fillSheets();
    return h('div', { class: 'toolbar csv-bar sheet-bar' },
      this.ro ? null : [this.bUndo, this.bRedo, h('span', { class: 'sep' }),
        b(tx('sort a-z'), tx('sort by the current column: the selected rows, or the rows around the cursor up to an empty one'), () => this.sort(this.cur.c, false)), b(tx('sort z-a'), tx('sort descending by the current column: the selected rows, or the rows around the cursor up to an empty one'), () => this.sort(this.cur.c, true)), h('span', { class: 'sep' })],
      this.headerBox(), this.filterBox(), h('span', { class: 'sep' }), this.refEl, this.fx, this.sheetSel);
  }
  fillSheets() {
    this.sheetSel.replaceChildren(...this.book.sheets.map((s, i) => h('option', { value: String(i), text: s.name })));
    this.sheetSel.value = String(this.book.sheets.indexOf(this.sh));
    this.sheetSel.hidden = this.book.sheets.length < 2;
  }
  fxCommit() {
    const at = this.fxAt;
    this.fxAt = null;
    if (this.ro || !at || at.d === undefined) return;
    if (this.fx.value !== this.get(at.d, at.c)) this.setCells([[at.d, at.c, this.fx.value]]);
  }

  cellHtml(i, d, c, cls) {
    const sh = this.sh, k = d * MAXC + c, span = sh.merge.get(k);
    if (span === 0) return '';
    const s = this.book.styleAt(sh, d, c), xf = this.book.xfs[s] || {};
    const raw = this.rows[d][c];
    let text = '';
    if (raw) {
      const v = this.calc.value(sh, d, c);
      text = this.book.show(v, s);
      if (typeof v === 'number') cls += ' num';
      else if (typeof v === 'boolean') cls += ' ac';
      else if (v instanceof XErr) cls += ' ac err';
    }
    if (xf.align) cls += ' a' + xf.align;
    if (xf.b) cls += ' b';
    if (xf.i) cls += ' i';
    if (xf.u || xf.s) cls += xf.u ? ' u' : ' s';
    let st = span ? 'grid-column:span ' + span + ';' : '';
    if (xf.fill) { cls += ' fill'; st += '--fill:' + xf.fill; }
    return '<div class="' + cls + '" data-r="' + i + '" data-c="' + c + '"' + (st ? ' style="' + st + '"' : '') + '>' + escHtml(text.replace(/\r?\n/g, ' ⏎ ')) + '</div>';
  }
  numAt(d, c) { const v = this.calc.value(this.sh, d, c); return typeof v === 'number' ? v : NaN; }
  shown(d, c) { return this.book.show(this.calc.value(this.sh, d, c), this.book.styleAt(this.sh, d, c)); }
  cellText(d, c) { return this.shown(d, c); }
  headText(c) { return this.shown(0, c); }
  numIn(s) { const t = typed(s, this.book.d1904); return t.k === 'n' ? t.v : NaN; }   // dates and 5% too

  status() {
    super.status();
    const d = this.view[this.cur.r];
    this.refEl.textContent = CSV.colName(this.cur.c) + (d === undefined ? '' : d + 1);
    if (document.activeElement !== this.fx) this.fx.value = d === undefined ? '' : this.get(d, this.cur.c);
  }
  statusHead() { return this.sh.name + (this.filtered ? ' | ' + txn(this.view.length, '{n} row shown', '{n} rows shown') : ''); }

  /* edits land in the workbook; undo knows its sheet */
  setCells(list) {
    const sh = this.sh;
    const old = list.map(([d, c]) => [d, c, (sh.rows[d] && sh.rows[d][c]) || '']);
    const apply = l => {
      if (this.sh !== sh) this.showSheet(sh);
      for (const [d, c, v] of l) {
        this.book.put(sh, d, c, v);
        if (c >= this.ncols) { this.ncols = c + 1; this.fillWidths(); }
      }
      this.calc.reset();
    };
    this.exec({ redo: () => apply(list), undo: () => apply(old) });
  }
  get dirty() { return this.book.sheets.some(s => s.changed.size > 0); }
  markSaved() { this.changed(); }

  // rows and columns inside a sheet would need every reference moved: not here
  insertRows(at, n) { if (at >= this.rows.length) super.insertRows(at, n); }
  addRow() { toast(tx('inserting rows is not supported in spreadsheets here'), 'warn'); }
  deleteRows() {}
  insertCol() {}
  deleteCols() {}

  /* the selected rows (one column selected: whole rows), or the rows around the cursor up to empty ones, by column c.
     Only rows on show move: the header and rows the filter hides stay. Formulas move with their row, formats stay. */
  sort(c, desc) {
    if (this.ro) return;
    this.commit(true);
    const { r0, r1, c0, c1 } = this.range(), used = d => { const row = this.rows[d] || []; let n = row.length; while (n > 0 && !row[n - 1]) n--; return n; };
    let a = r0, b = r1;
    if (a === b) {
      if (!used(this.view[a])) { toast(tx('nothing to sort here'), 'warn'); return; }
      while (a > 0 && used(this.view[a - 1])) a--;
      while (b < this.view.length - 1 && used(this.view[b + 1])) b++;
    }
    const ds = this.view.slice(a, b + 1);
    if (ds.length < 2) return;
    let x0 = 0, x1 = Math.max(...ds.map(used)) - 1;
    if (r0 !== r1 && c0 !== c1) { x0 = c0; x1 = c1; }
    if (c < x0 || c > x1) x1 = Math.max(x1, c);
    const rank = v => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : typeof v === 'boolean' ? 2 : 3);
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const keys = new Map(ds.map(d => [d, this.calc.value(this.sh, d, c)]));
    const order = ds.slice().sort((p, q) => {
      const x = keys.get(p), y = keys.get(q), ex = x === null || x === '', ey = y === null || y === '';
      if (ex || ey) return ex === ey ? 0 : ex ? 1 : -1;   // empty last, both ways
      let r = rank(x) - rank(y);
      if (!r) r = typeof x === 'number' ? x - y : typeof x === 'string' ? coll.compare(x, y) : typeof x === 'boolean' ? x - y : coll.compare(x.e, y.e);
      return desc ? -r : r;
    });
    const l = [];
    order.forEach((src, i) => {
      const dst = ds[i];
      if (src === dst) return;
      for (let cc = x0; cc <= x1; cc++) {
        let v = this.get(src, cc);
        if (v[0] === '=') v = '=' + Formula.shift(v.slice(1), dst - src, 0);
        if (v !== this.get(dst, cc)) l.push([dst, cc, v]);
      }
    });
    if (!l.length) return;
    this.setCells(l);
    this.anc = { r: a, c: x0 };
    this.cur = { r: b, c: x1 };
    this.clamp();
    this.render();
  }

  key(e) {
    if (!this.edit && e.target === this.scroll && (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); this.fillDown(); return; }
    super.key(e);
  }
  /* ctrl+d: the top row of the selection (or the row above) down through it, formulas moving along */
  fillDown() {
    if (this.ro) return;
    let { r0, r1, c0, c1 } = this.range();
    if (r0 === r1) { if (r0 === 0) return; r0--; }
    const d0 = this.view[r0], l = [];
    for (let i = r0 + 1; i <= r1; i++) {
      const d = this.view[i];
      for (let c = c0; c <= c1; c++) {
        const v = this.get(d0, c);
        l.push([d, c, v[0] === '=' ? '=' + Formula.shift(v.slice(1), d - d0, 0) : v]);
      }
    }
    if (l.length) this.setCells(l);
  }

  /* copy gives what the cells show; pasting that back here takes the formulas, moved */
  clip(e, cut) {
    if (document.activeElement !== this.scroll || this.edit) return;
    const { r0, r1, c0, c1 } = this.range(), shown = [], raw = [];
    for (let i = r0; i <= r1; i++) {
      const s = [], w = [], d = this.view[i];
      for (let c = c0; c <= c1; c++) { s.push(this.shown(d, c)); w.push(this.get(d, c)); }
      shown.push(s);
      raw.push(w);
    }
    const text = CSV.stringify(shown, '\t', '\n');
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
    this.clipKeep = { text, raw, d: this.view[r0], c: c0 };
    if (cut && !this.ro) this.clearRange();
  }
  paste(e) {
    if (document.activeElement !== this.scroll || this.edit || this.ro) return;
    const t = e.clipboardData.getData('text/plain');
    if (!t) return;
    e.preventDefault();
    const k = this.clipKeep, norm = s => s.replace(/\r\n/g, '\n').replace(/\n$/, '');
    if (k && norm(t) === norm(k.text)) {
      this.pasteRows(k.raw, (v, i, j, d, c) => (v[0] === '=' ? '=' + Formula.shift(v.slice(1), d - (k.d + i), c - (k.c + j)) : v));
    } else this.pasteRows(CSV.parse(norm(t), '\t'));
  }

  /* ---- for the page ---- */
  pack() { this.commit(true); return this.book.build(this.calc); }
  stored(out) { out.done(); this.changed(); }
  /* the workbook as a new xlsx */
  xlsx() { this.commit(true); return XlsxOut.write(this.book, this.calc); }
  /* someone else saved: their file, with the cells changed here on top */
  async rebase(bytes) {
    const book = await this.book.constructor.open(bytes), lost = [];
    for (const sh of this.book.sheets) {
      if (!sh.changed.size) continue;
      const to = book.sheets.find(s => s.name === sh.name);
      if (!to) { lost.push(sh.name); continue; }
      for (const k of sh.changed) {
        const r = Math.floor(k / MAXC), c = k % MAXC;
        book.put(to, r, c, (sh.rows[r] && sh.rows[r][c]) || '');
      }
    }
    for (const sh of book.sheets) { const was = this.book.sheets.find(s => s.name === sh.name); if (was) { sh.header = was.header; sh.colf = was.colf; } }
    const name = this.sh.name, cur = this.cur, anc = this.anc, top = this.scroll.scrollTop, left = this.scroll.scrollLeft;
    this.book = book;
    this.calc = new Calc(book);
    this.undos = [];
    this.redos = [];
    this.setSheet(book.sheets.find(s => s.name === name) || book.sheets[0]);
    this.fillSheets();
    this.cur = cur;
    this.anc = anc;
    this.refresh();
    this.scroll.scrollTop = top;
    this.scroll.scrollLeft = left;
    this.changed();
    if (lost.length) toast(tx('sheet {name} is gone from the file: the changes there are lost', { name: lost.join(', ') }), 'err');
  }
}
