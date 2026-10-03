/* RTF: reading into HTML for the editor, writing the editor's HTML back, and
   the editor itself. What it keeps: paragraphs (alignment, indents, spacing),
   bold / italic / underline / strike / super- and subscript, fonts, sizes,
   colours, highlight, lists, tables, links, PNG and JPEG pictures. What it
   cannot keep (headers, footers, footnotes, drawings, WMF pictures) is
   counted, so the user can be told before saving. */
'use strict';

const RTF = (() => {
  const CHARSET = {
    2: 'symbol', 77: 'macintosh', 128: 'shift_jis', 129: 'euc-kr', 134: 'gbk', 136: 'big5',
    161: 'windows-1253', 162: 'windows-1254', 163: 'windows-1258', 177: 'windows-1255', 178: 'windows-1256',
    186: 'windows-1257', 204: 'windows-1251', 222: 'windows-874', 238: 'windows-1250',
  };
  function codepage(n) {
    const m = { 65001: 'utf-8', 10000: 'macintosh', 866: 'ibm866', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 874: 'windows-874' };
    return m[n] || (n >= 1250 && n <= 1258 ? 'windows-' + n : 'windows-1252');
  }
  // bullets as Symbol / Wingdings write them
  const SYMBOL = { 0xB7: '•', 0xA7: '▪', 0xD8: '➢', 0xFC: '✓', 0x6C: '●', 0x6E: '■', 0x76: '❖', 0x71: '❑' };
  const decoders = {};
  function decode(bytes, enc) {
    if (enc === 'symbol') return bytes.map(b => SYMBOL[b] || String.fromCharCode(b)).join('');
    try {
      const d = decoders[enc] || (decoders[enc] = new TextDecoder(enc));
      return d.decode(new Uint8Array(bytes));
    } catch (e) {
      return String.fromCharCode.apply(null, bytes);
    }
  }

  /* bytes as a string of char codes 0-255 (not TextDecoder('latin1'), which is windows-1252) */
  function bytesToString(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    return s;
  }

  const SKIP = new Set(('stylesheet info listtable listoverridetable rsidtbl generator xmlnstbl latentstyles datastore ' +
    'themedata colorschememapping nonshppict objdata objclass pgdsctbl revtbl bkmkstart bkmkend fldtype xe tc txe ' +
    'mmathPr wgrffmtfilter pnseclvl ftnsep ftnsepc aftnsep aftnsepc template userprops docvar filetbl ' +
    'protusertbl pntxta pntxtb nesttableprops listpicture blipuid panose falt fchars lchars ' +
    'passwordhash oldcprops oldpprops oldsprops oldtprops').split(/\s+/));
  const LOST = { header: 'headers', headerl: 'headers', headerr: 'headers', headerf: 'headers',
    footer: 'footers', footerl: 'footers', footerr: 'footers', footerf: 'footers',
    footnote: 'footnotes', annotation: 'comments', shp: 'drawings', shpgrp: 'drawings', do: 'drawings' };
  // starred destinations we do understand
  const KNOWN = new Set(['shppict', 'fldinst', 'pn', 'listtext', 'pntext']);

  function esc(s) { return s.replace(/[&<>"]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;')); }
  function hex2(n) { return (n < 16 ? '0' : '') + n.toString(16); }
  function safeUrl(u) { return /^(https?:|mailto:)/i.test(u) ? u : null; }
  function cssFont(n) { return "'" + n.replace(/['"<>;\\]/g, '') + "'"; }

  /* ---------------- reading ---------------- */
  function parse(src) {
    const n = src.length;
    const fonts = {}, colors = [];
    let defCp = 'windows-1252', deff = 0;
    const lost = {};
    const blocks = [];
    let para = { runs: [] };
    let pp = freshPara();
    let table = null, row = [], cell = [], cellx = [], rowx = [];
    let bytes = [], bytesEnc = null;
    let high = 0;          // pending high surrogate from \u
    let skipChars = 0;     // fallback chars to drop after \u
    let fontEntry = null, color = null;
    let st = {
      dest: 'body', own: false, star: false, f: null, fs: 24, b: false, i: false, u: false, s: false, sup: false, sub: false,
      cf: 0, hl: 0, uc: 1, hidden: false, href: null, field: null, col: null, pict: null,
    };
    const stack = [];

    function freshPara() { return { align: '', li: 0, fi: 0, sa: 0, sb: 0, intbl: false, ls: false, pn: null, level: 0, listText: '' }; }
    function lose(what) { lost[what] = (lost[what] || 0) + 1; }
    function fontEnc(f) {
      const e = f !== null && fonts[f] ? fonts[f].enc : '';
      return e || defCp;
    }

    function flushBytes() {
      if (!bytes.length) return;
      const s = decode(bytes, bytesEnc);
      bytes = [];
      text(s);
    }
    function byte(b) {
      if (skipChars > 0) { skipChars--; return; }
      const enc = st.dest === 'body' ? fontEnc(st.f) : (st.dest === 'fonttbl' && fontEntry ? fontEntry.enc || defCp : defCp);
      if (bytes.length && enc !== bytesEnc) flushBytes();
      bytesEnc = enc;
      bytes.push(b);
    }

    function fmt() {
      const f = st.f !== null && st.f !== deff && fonts[st.f] ? fonts[st.f].name : '';
      const color = colors[st.cf] || null, bg = st.hl ? colors[st.hl] || null : null;
      return { b: st.b, i: st.i, u: st.u, s: st.s, sup: st.sup, sub: st.sub, font: f, size: st.fs, color, bg, href: st.href };
    }
    function key(f) { return JSON.stringify(f); }

    function text(s) {
      if (!s) return;
      switch (st.dest) {
        case 'body': {
          if (st.hidden) return;
          const f = fmt(), k = key(f), last = para.runs[para.runs.length - 1];
          if (last && last.k === k && !last.img) last.t += s;
          else para.runs.push({ k, f, t: s });
          return;
        }
        case 'fonttbl':
          if (!fontEntry) return;
          for (const ch of s) {
            if (ch === ';') fontEntry.done = true;
            else if (!fontEntry.done) fontEntry.name += ch;
          }
          return;
        case 'colortbl':
          for (const ch of s) {
            if (ch !== ';') continue;
            colors.push(color && !(color.r === 0 && color.g === 0 && color.b === 0) ? '#' + hex2(color.r) + hex2(color.g) + hex2(color.b) : null);
            color = null;
          }
          return;
        case 'collect':
          st.col.t += s;
          return;
        case 'pict':
          st.pict.hex.push(s);
          return;
        default:
      }
    }

    function listType() {
      if (pp.pn) return pp.pn;
      if (!pp.ls) return null;
      return /^\s*(\d+|[ivxlcdm]+|[a-z])[.)]/i.test(pp.listText) ? 'ol' : 'ul';
    }

    function endPara(kind) {
      flushBytes();
      const list = listType();
      // legacy \pn bullets carry no level: the indent tells it (720 twips a level)
      const level = list && !pp.level && pp.li > 1080 ? Math.round(pp.li / 720) - 1 : pp.level;
      const p = { runs: para.runs, align: pp.align, li: pp.li, fi: pp.fi, sa: pp.sa, sb: pp.sb, list, level };
      para = { runs: [] };
      pp.listText = '';
      if (kind === 'cell') {
        if (p.runs.length || !cell.length) cell.push(p);
        row.push({ blocks: cell });
        cell = [];
        return;
      }
      if (pp.intbl) { cell.push(p); return; }
      closeTable();
      blocks.push(p);
    }
    function endRow() {
      flushBytes();
      if (para.runs.length) endPara('cell');
      if (row.length) {
        if (!table) table = { rows: [] };
        table.rows.push({ cells: row, x: rowx.length ? rowx.slice() : cellx.slice() });
      }
      row = [];
      rowx = [];
    }
    function closeTable() {
      if (row.length) endRow();
      if (table) { blocks.push(table); table = null; }
    }

    function endGroup() {
      flushBytes();
      if (st.own) {
        if (st.dest === 'fonttbl' && fontEntry) { /* entries end with ';' */ }
        if (st.destName === 'fldinst') {
          const m = /HYPERLINK\s+"([^"]*)"/i.exec(st.col.t) || /HYPERLINK\s+(\S+)/i.exec(st.col.t);
          if (m && st.field && !/\\l\b/.test(st.col.t.slice(0, m.index))) st.field.href = safeUrl(m[1]);
        } else if (st.destName === 'listtext') {
          pp.listText = st.col.t;
        } else if (st.dest === 'pict') {
          const p = st.pict;
          if (p.type === 'png' || p.type === 'jpeg') {
            const hex = p.hex.join('').replace(/[^0-9a-f]/gi, '');
            let bin = '';
            for (let i = 0; i + 1 < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
            const w = ((p.wg ? p.wg / 15 : p.w) || 100) * p.sx / 100;
            const h = ((p.hg ? p.hg / 15 : p.h) || 100) * p.sy / 100;
            const outer = stack[stack.length - 1];
            if (outer && outer.dest === 'body' && !outer.hidden) {
              para.runs.push({ img: 'data:image/' + p.type + ';base64,' + btoa(bin), w: Math.round(w), h: Math.round(h), href: outer.href });
            }
          } else lose('pictures in formats other than PNG / JPEG');
        }
      }
      st = stack.pop() || st;
    }

    function startDest(dest, name) {
      st.dest = dest;
      st.destName = name || dest;
      st.own = true;
      if (dest === 'collect') st.col = { t: '' };
    }

    function word(w, p, hasP) {
      if (st.star) {
        st.star = false;
        if (!KNOWN.has(w)) { startDest('skip'); return; }
      }
      if (st.dest === 'skip') return;
      if (SKIP.has(w)) { startDest('skip'); return; }
      if (LOST[w]) { lose(LOST[w]); startDest('skip'); return; }
      const on = !hasP || p !== 0;
      const d = st.dest;
      if (d === 'fonttbl') {
        if (w === 'f') { fontEntry = fonts[p] = { name: '', enc: '' }; }
        else if (w === 'fcharset' && fontEntry) fontEntry.enc = CHARSET[p] || '';
        else if (w === 'cpg' && fontEntry) fontEntry.enc = codepage(p);
        return;
      }
      if (d === 'colortbl') {
        if (w === 'red' || w === 'green' || w === 'blue') { color = color || { r: 0, g: 0, b: 0 }; color[w[0]] = p; }
        return;
      }
      if (d === 'pict') {
        const pi = st.pict;
        if (w === 'pngblip') pi.type = 'png';
        else if (w === 'jpegblip') pi.type = 'jpeg';
        else if (/^(wmetafile|emfblip|macpict|dibitmap|wbitmap|pmmetafile)$/.test(w)) pi.type = pi.type || 'other';
        else if (w === 'picwgoal') pi.wg = p;
        else if (w === 'pichgoal') pi.hg = p;
        else if (w === 'picscalex') pi.sx = p || 100;
        else if (w === 'picscaley') pi.sy = p || 100;
        else if (w === 'picw') pi.w = p;
        else if (w === 'pich') pi.h = p;
        return;
      }
      if (d === 'pn') {
        if (w === 'pnlvlblt') pp.pn = 'ul';
        else if (/^pn(lvlbody|dec|ucltr|lcltr|ucrm|lcrm|ord|ordt|card)$/.test(w)) pp.pn = 'ol';
        else if (w === 'pnlvl') pp.level = Math.max(0, p - 1);
        return;
      }
      if (d === 'collect') {
        if (w === 'u') unicode(p);
        else if (w === 'tab') text('\t');
        return;
      }
      // body
      switch (w) {
        case 'rtf': case 'ansi': return;
        case 'ansicpg': defCp = codepage(p); return;
        case 'mac': defCp = 'macintosh'; return;
        case 'deff': deff = p; if (st.f === null) st.f = p; return;
        case 'fonttbl': startDest('fonttbl'); return;
        case 'colortbl': startDest('colortbl'); return;
        case 'pict': startDest('pict'); st.pict = { type: null, hex: [], wg: 0, hg: 0, sx: 100, sy: 100, w: 0, h: 0 }; return;
        case 'fldinst': startDest('collect', 'fldinst'); return;
        case 'listtext': case 'pntext': startDest('collect', 'listtext'); return;
        case 'pn': startDest('pn'); return;
        case 'field': st.field = { href: null }; return;
        case 'fldrslt': st.href = st.field ? st.field.href : null; return;
        case 'object': lose('embedded objects (their picture is kept if there is one)'); return;
        case 'par': case 'sect': case 'page': case 'nestcell': endPara('par'); return;
        case 'cell': endPara('cell'); return;
        case 'row': endRow(); return;
        case 'trowd': rowx = []; cellx = rowx; return;
        case 'cellx': rowx.push(p); return;
        case 'pard': { const lt = pp.listText; pp = freshPara(); pp.listText = lt; return; }   // Word puts \listtext before \pard
        case 'intbl': pp.intbl = true; return;
        case 'itap': pp.intbl = p > 0; return;
        case 'ls': pp.ls = true; return;
        case 'ilvl': pp.level = p; return;
        case 'ql': pp.align = ''; return;
        case 'qc': pp.align = 'center'; return;
        case 'qr': pp.align = 'right'; return;
        case 'qj': pp.align = 'justify'; return;
        case 'li': pp.li = p; return;
        case 'fi': pp.fi = p; return;
        case 'sa': pp.sa = p; return;
        case 'sb': pp.sb = p; return;
        case 'plain':
          Object.assign(st, { f: deff, fs: 24, b: false, i: false, u: false, s: false, sup: false, sub: false, cf: 0, hl: 0, hidden: false });
          return;
        case 'b': st.b = on; return;
        case 'i': st.i = on; return;
        case 'ul': case 'uld': case 'uldb': case 'ulw': case 'uldash': case 'uldashd': case 'uldashdd': case 'ulth':
        case 'ulwave': case 'ulhwave': case 'ululdbwave': case 'ulthd': case 'ulthdash': case 'ulldash':
          st.u = on; return;
        case 'ulnone': st.u = false; return;
        case 'strike': case 'striked': st.s = on; return;
        case 'super': st.sup = on; if (on) st.sub = false; return;
        case 'sub': st.sub = on; if (on) st.sup = false; return;
        case 'nosupersub': st.sup = st.sub = false; return;
        case 'v': st.hidden = on; return;
        case 'fs': st.fs = p || 24; return;
        case 'f': st.f = p; return;
        case 'cf': st.cf = p; return;
        case 'highlight': case 'cb': case 'chcbpat': st.hl = p; return;
        case 'uc': st.uc = p; return;
        case 'u': unicode(p); return;
        case 'line': text('\n'); return;
        case 'tab': text('\t'); return;
        case 'emdash': text('—'); return;
        case 'endash': text('–'); return;
        case 'bullet': text('•'); return;
        case 'lquote': text('‘'); return;
        case 'rquote': text('’'); return;
        case 'ldblquote': text('“'); return;
        case 'rdblquote': text('”'); return;
        case 'emspace': case 'enspace': case 'qmspace': text(' '); return;
        default:
      }
    }

    function unicode(p) {
      flushBytes();
      let c = p < 0 ? p + 65536 : p;
      skipChars = st.uc;
      if (c >= 0xD800 && c < 0xDC00) { high = c; return; }
      if (c >= 0xDC00 && c < 0xE000 && high) { text(String.fromCharCode(high, c)); high = 0; return; }
      high = 0;
      // Symbol-font private-use bullets (U+F0B7) come out as plain bullets
      if (c >= 0xF020 && c <= 0xF0FF && fontEnc(st.f) === 'symbol') { text(SYMBOL[c - 0xF000] || String.fromCharCode(c - 0xF000)); return; }
      text(String.fromCharCode(c));
    }

    let i = 0;
    while (i < n) {
      const ch = src[i];
      if (ch === '{') { flushBytes(); stack.push(st); st = Object.assign({}, st, { own: false, star: false }); skipChars = 0; i++; continue; }
      if (ch === '}') { endGroup(); skipChars = 0; i++; continue; }
      if (ch === '\\') {
        const nx = src[i + 1];
        if (nx === undefined) break;
        if (/[a-zA-Z]/.test(nx)) {
          let j = i + 1;
          while (j < n && /[a-zA-Z]/.test(src[j])) j++;
          const w = src.slice(i + 1, j);
          let k = j;
          if (src[k] === '-' || /[0-9]/.test(src[k] || '')) { k++; while (k < n && /[0-9]/.test(src[k])) k++; }
          const hasP = k > j;
          const p = hasP ? parseInt(src.slice(j, k), 10) : 0;
          if (src[k] === ' ') k++;
          i = k;
          if (w === 'bin') {   // raw binary data: skip it
            if (st.dest === 'pict') st.pict.type = 'other';
            i += Math.max(0, p);
            continue;
          }
          if (w !== 'u' && skipChars > 0) { skipChars--; continue; }   // a control word can be the \u fallback
          if (w !== 'u') flushBytes();
          word(w, p, hasP);
          continue;
        }
        if (nx === "'") {
          const b = parseInt(src.substr(i + 2, 2), 16);
          i += 4;
          if (!isNaN(b) && st.dest !== 'skip') byte(b);
          continue;
        }
        i += 2;
        if (st.dest === 'skip') continue;
        if (nx === '*') { st.star = true; continue; }
        if (skipChars > 0) { skipChars--; continue; }
        flushBytes();
        if (nx === '\\' || nx === '{' || nx === '}') text(nx);
        else if (nx === '~') text(' ');
        else if (nx === '_') text('‑');
        else if (nx === '\n' || nx === '\r') word('par', 0, false);
        else if (nx === '\t') text('\t');
        // \- (optional hyphen), \: and the rest: nothing to show
        continue;
      }
      if (ch === '\r' || ch === '\n') { i++; continue; }
      // a run of plain text
      let j = i;
      while (j < n) { const c = src[j]; if (c === '\\' || c === '{' || c === '}' || c === '\r' || c === '\n') break; j++; }
      if (st.dest !== 'skip') {
        const s = src.slice(i, j);
        for (let q = 0; q < s.length; q++) {
          const c = s.charCodeAt(q);
          if (c >= 0x80) { byte(c); continue; }
          if (skipChars > 0) { skipChars--; continue; }
          // plain ASCII: gather the stretch
          let e = q;
          while (e < s.length && s.charCodeAt(e) < 0x80) e++;
          flushBytes();
          text(s.slice(q, e));
          q = e - 1;
        }
      }
      i = j;
    }
    flushBytes();
    if (para.runs.length) endPara(pp.intbl ? 'cell' : 'par');
    closeTable();
    const font = fonts[deff] && fonts[deff].name.trim() ? fonts[deff].name.trim() : 'Arial';
    return { html: toHtml(blocks), font, lost };
  }

  function runHtml(r) {
    if (r.img) {
      let x = '<img src="' + r.img + '" style="width:' + r.w + 'px;height:' + r.h + 'px" alt="">';
      if (r.href) x = '<a href="' + esc(r.href) + '">' + x + '</a>';
      return x;
    }
    const f = r.f;
    let x = esc(r.t).replace(/\n/g, '<br>');
    if (f.b) x = '<b>' + x + '</b>';
    if (f.i) x = '<i>' + x + '</i>';
    if (f.u) x = '<u>' + x + '</u>';
    if (f.s) x = '<s>' + x + '</s>';
    if (f.sup) x = '<sup>' + x + '</sup>';
    if (f.sub) x = '<sub>' + x + '</sub>';
    let s = '';
    if (f.font) s += 'font-family:' + cssFont(f.font.trim()) + ';';
    if (f.size && f.size !== 24) s += 'font-size:' + f.size / 2 + 'pt;';
    if (f.color) s += 'color:' + f.color + ';';
    if (f.bg) s += 'background-color:' + f.bg + ';';
    if (s) x = '<span style="' + esc(s) + '">' + x + '</span>';
    if (f.href) x = '<a href="' + esc(f.href) + '">' + x + '</a>';
    return x;
  }

  function paraStyle(b, list) {
    let s = '';
    if (b.align) s += 'text-align:' + b.align + ';';
    if (!list && b.li) s += 'margin-left:' + Math.round(b.li / 15) + 'px;';
    if (!list && b.fi) s += 'text-indent:' + Math.round(b.fi / 15) + 'px;';
    if (b.sb) s += 'margin-top:' + Math.round(b.sb / 15) + 'px;';
    if (b.sa) s += 'margin-bottom:' + Math.round(b.sa / 15) + 'px;';
    return s ? ' style="' + s + '"' : '';
  }

  function toHtml(blocks) {
    let out = '';
    const lists = [];
    const closeLists = () => { while (lists.length) out += '</li></' + lists.pop() + '>'; };
    for (const b of blocks) {
      if (b.rows) {
        closeLists();
        out += '<table class="rtf-table"><tbody>';
        for (const r of b.rows) {
          out += '<tr>';
          r.cells.forEach((c, ci) => {
            const x0 = ci ? r.x[ci - 1] : 0, x1 = r.x[ci];
            const w = x1 !== undefined && x1 > x0 ? ' style="width:' + Math.round((x1 - x0) / 15) + 'px"' : '';
            out += '<td' + w + '>' + toHtml(c.blocks) + '</td>';
          });
          out += '</tr>';
        }
        out += '</tbody></table>';
        continue;
      }
      const inner = b.runs.map(runHtml).join('');
      if (b.list) {
        const target = (b.level || 0) + 1;
        if (lists.length > target) { while (lists.length > target) out += '</li></' + lists.pop() + '>'; out += '</li>'; }
        else if (lists.length === target) out += '</li>';
        if (lists.length === target && lists[target - 1] !== b.list) out += '</' + lists.pop() + '>';
        while (lists.length < target) { out += '<' + b.list + '>'; lists.push(b.list); }
        out += '<li' + paraStyle(b, true) + '>' + (inner || '<br>');
        continue;
      }
      closeLists();
      out += '<p' + paraStyle(b, false) + '>' + (inner || '<br>') + '</p>';
    }
    closeLists();
    return out;
  }

  /* ---------------- writing ---------------- */
  const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table',
    'hr', 'section', 'article', 'header', 'footer', 'figure', 'center', 'address', 'dl', 'dt', 'dd', 'tr', 'td', 'th', 'tbody', 'thead', 'tfoot']);
  const HSIZE = { h1: 24, h2: 18, h3: 14, h4: 12, h5: 12, h6: 12 };
  const FONT_SIZE = { 1: 8, 2: 10, 3: 12, 4: 14, 5: 18, 6: 24, 7: 36 };
  const NAMED = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
    gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000', navy: '#000080', purple: '#800080',
    teal: '#008080', olive: '#808000', orange: '#ffa500', lime: '#00ff00', aqua: '#00ffff', fuchsia: '#ff00ff' };

  function toRgb(c) {
    if (!c) return null;
    c = c.trim().toLowerCase();
    if (NAMED[c]) return NAMED[c];
    let m = /^#([0-9a-f]{6})$/.exec(c);
    if (m) return '#' + m[1];
    m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(c);
    if (m) return '#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
    m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+))?\s*\)$/.exec(c);
    if (m) {
      if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
      return '#' + [m[1], m[2], m[3]].map(v => hex2(Math.min(255, +v))).join('');
    }
    return null;
  }
  function toPt(v, base) {
    if (!v) return null;
    const m = /^([\d.]+)(pt|px|em|rem|%)?$/.exec(v.trim());
    if (!m) {
      const kw = { 'xx-small': 7, 'x-small': 7.5, small: 10, medium: 12, large: 13.5, 'x-large': 18, 'xx-large': 24, 'xxx-large': 36 }[v.trim()];
      return kw || null;
    }
    const x = parseFloat(m[1]);
    switch (m[2]) {
      case 'pt': return x;
      case 'em': case 'rem': return x * base;
      case '%': return x * base / 100;
      default: return x * 0.75;
    }
  }
  function firstFamily(v) {
    const f = (v || '').split(',')[0].trim().replace(/^['"]|['"]$/g, '');
    return f && !/^(serif|sans-serif|monospace|inherit|initial|cursive|fantasy|system-ui)$/i.test(f) ? f : null;
  }
  function escText(s) {
    let o = '';
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (ch === '\\' || ch === '{' || ch === '}') o += '\\' + ch;
      else if (ch === '\t') o += '\\tab ';
      else if (ch === '\n') o += '\\line ';
      else if (c === 0xA0) o += '\\~';
      else if (c === 0xAD) o += '\\-';
      else if (c === 0x2011) o += '\\_';
      else if (c < 0x20) continue;
      else if (c < 0x80) o += ch;
      else if (c < 0x10000) o += '\\u' + (c > 32767 ? c - 65536 : c) + '?';
      else {
        const hi = 0xD800 + ((c - 0x10000) >> 10), lo = 0xDC00 + ((c - 0x10000) & 0x3FF);
        o += '\\u' + (hi - 65536) + '?\\u' + (lo - 65536) + '?';
      }
    }
    return o;
  }

  /* root: the editor element; base: {font, size (pt)} */
  function write(root, base) {
    base = Object.assign({ font: 'Arial', size: 12 }, base || {});
    const fonts = [base.font, 'Symbol'];
    const colors = [];
    const fontIdx = name => {
      let i = fonts.findIndex(f => f.toLowerCase() === name.toLowerCase());
      if (i < 0) { fonts.push(name); i = fonts.length - 1; }
      return i;
    };
    const colorIdx = rgb => {
      let i = colors.indexOf(rgb);
      if (i < 0) { colors.push(rgb); i = colors.length - 1; }
      return i + 1;
    };
    let sink = [];
    let para = null;
    const out = s => sink.push(s);

    function ensure(ctx) {
      if (!para) para = { pp: ctx.pp, body: '' };
      return para;
    }
    function flush() {
      if (!para) return;
      const p = para;
      para = null;
      const pp = p.pp;
      let head = '\\pard';
      if (pp.intbl) head += '\\intbl';
      head += { center: '\\qc', right: '\\qr', justify: '\\qj' }[pp.align] || '';
      let li = pp.li || 0, fi = pp.fi || 0;
      let marker = '';
      if (pp.list) {
        li += 720 * (pp.list.level + 1);
        fi = -360;
        if (!pp.list.cont) {
          if (pp.list.type === 'ul') {
            marker = "{\\pntext\\f1\\'b7\\tab}{\\*\\pn\\pnlvlblt\\pnf1\\pnindent360{\\pntxtb\\'b7}}";
          } else {
            marker = '{\\pntext ' + pp.list.n + '.\\tab}{\\*\\pn\\pnlvlbody\\pnf0\\pnindent360\\pnstart1\\pndec{\\pntxta.}}';
          }
          pp.list.cont = true;   // further paragraphs of the same item: indented, no marker
        } else fi = 0;
      }
      if (li) head += '\\li' + li;
      if (fi) head += '\\fi' + fi;
      if (pp.sb) head += '\\sb' + pp.sb;
      if (pp.sa) head += '\\sa' + pp.sa;
      if (pp.border) head += '\\brdrb\\brdrs\\brdrw10\\brsp20';
      const body = p.body.replace(/(\\line )+$/, m => m.slice(7));   // a trailing <br> is the browser's placeholder
      out(head + ' ' + marker + body + '\\par\n');
    }

    function fmtOf(el, f) {
      f = Object.assign({}, f);
      const t = el.tagName.toLowerCase();
      if (t === 'b' || t === 'strong') f.b = true;
      else if (t === 'i' || t === 'em' || t === 'cite') f.i = true;
      else if (t === 'u' || t === 'ins') f.u = true;
      else if (t === 's' || t === 'strike' || t === 'del') f.s = true;
      else if (t === 'sup') { f.sup = true; f.sub = false; }
      else if (t === 'sub') { f.sub = true; f.sup = false; }
      else if (t === 'code' || t === 'tt' || t === 'kbd' || t === 'samp') f.font = 'Courier New';
      else if (t === 'font') {
        const face = firstFamily(el.getAttribute('face'));
        if (face) f.font = face;
        const c = toRgb(el.getAttribute('color'));
        if (c) f.color = c;
        const sz = FONT_SIZE[el.getAttribute('size')];
        if (sz) f.size = sz;
      }
      const s = el.style;
      if (s) {
        const fw = s.fontWeight;
        if (fw === 'bold' || fw === 'bolder' || +fw >= 600) f.b = true;
        else if (fw === 'normal' || (+fw && +fw < 600)) f.b = false;
        if (s.fontStyle === 'italic' || s.fontStyle === 'oblique') f.i = true;
        else if (s.fontStyle === 'normal') f.i = false;
        const td = s.textDecorationLine || s.textDecoration || '';
        if (td.includes('underline')) f.u = true;
        if (td.includes('line-through')) f.s = true;
        const pt = toPt(s.fontSize, f.size);
        if (pt) f.size = pt;
        const fam = firstFamily(s.fontFamily);
        if (fam) f.font = fam;
        if (s.color) { const c = toRgb(s.color); if (c) f.color = c; }
        if (s.backgroundColor) { const c = toRgb(s.backgroundColor); if (c) f.bg = c; }
        if (s.verticalAlign === 'super') { f.sup = true; f.sub = false; }
        if (s.verticalAlign === 'sub') { f.sub = true; f.sup = false; }
      }
      return f;
    }

    function run(text, f) {
      let pre = '';
      if (f.b) pre += '\\b';
      if (f.i) pre += '\\i';
      if (f.u) pre += '\\ul';
      if (f.s) pre += '\\strike';
      if (f.sup) pre += '\\super';
      else if (f.sub) pre += '\\sub';
      if (f.font && f.font.toLowerCase() !== base.font.toLowerCase()) pre += '\\f' + fontIdx(f.font);
      if (f.size && Math.abs(f.size - base.size) > 0.01) pre += '\\fs' + Math.round(f.size * 2);
      if (f.color && f.color !== '#000000') pre += '\\cf' + colorIdx(f.color);
      if (f.bg && f.bg !== '#ffffff') pre += '\\highlight' + colorIdx(f.bg);
      const body = escText(text);
      return pre ? '{' + pre + ' ' + body + '}' : body;
    }

    function image(el) {
      const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i.exec(el.getAttribute('src') || '');
      if (!m) return '';
      const bin = atob(m[2].replace(/\s+/g, ''));
      let hex = '';
      for (let i = 0; i < bin.length; i++) {
        hex += hex2(bin.charCodeAt(i));
        if (i % 64 === 63) hex += '\n';
      }
      const nw = el.naturalWidth || 0, nh = el.naturalHeight || 0;
      const w = parseFloat(el.style.width) || +el.getAttribute('width') || el.width || nw || 100;
      const h = parseFloat(el.style.height) || +el.getAttribute('height') || el.height || (nw ? w * nh / nw : 0) || w;
      const type = /png/i.test(m[1]) ? 'pngblip' : 'jpegblip';
      return '{\\pict\\' + type + '\\picw' + Math.round(nw || w) + '\\pich' + Math.round(nh || h) +
        '\\picwgoal' + Math.round(w * 15) + '\\pichgoal' + Math.round(h * 15) + '\n' + hex + '}';
    }

    function inline(node, ctx) {
      if (node.nodeType === 3) {
        const t = node.nodeValue;
        if (!t) return;
        // whitespace-only text between blocks is formatting, not content
        if (!para && !/\S/.test(t)) return;
        ensure(ctx).body += run(t, ctx.f);
        return;
      }
      if (node.nodeType !== 1) return;
      const t = node.tagName.toLowerCase();
      if (t === 'br') { ensure(ctx).body += '\\line '; return; }
      if (t === 'img') { ensure(ctx).body += image(node); return; }
      if (t === 'script' || t === 'style' || t === 'template') return;
      if (BLOCK.has(t)) { flush(); block(node, t, ctx); flush(); return; }
      const f = fmtOf(node, ctx.f);
      const sub = Object.assign({}, ctx, { f });
      const href = t === 'a' ? safeUrl(node.getAttribute('href') || '') : null;
      if (href) {
        const p = ensure(ctx);
        p.body += '{\\field{\\*\\fldinst{HYPERLINK "' + escText(href).replace(/"/g, '%22') + '"}}{\\fldrslt{';
        for (const c of Array.from(node.childNodes)) inline(c, sub);
        ensure(ctx).body += '}}}';
        return;
      }
      for (const c of Array.from(node.childNodes)) inline(c, sub);
    }

    function children(el, ctx) {
      for (const c of Array.from(el.childNodes)) inline(c, ctx);
    }

    function blockPP(el, ctx) {
      const pp = Object.assign({}, ctx.pp, { border: false });
      const s = el.style || {};
      const al = (s.textAlign || el.getAttribute('align') || '').toLowerCase();
      if (al === 'center' || al === 'right' || al === 'justify') pp.align = al;
      else if (al === 'left' || al === 'start') pp.align = '';
      const ml = parseFloat(s.marginLeft || s.paddingLeft);
      if (ml > 0 && /px$/.test(s.marginLeft || s.paddingLeft)) pp.li = (pp.li || 0) + Math.round(ml * 15);
      const ti = parseFloat(s.textIndent);
      if (ti && /px$/.test(s.textIndent)) pp.fi = Math.round(ti * 15);
      const mt = parseFloat(s.marginTop), mb = parseFloat(s.marginBottom);
      pp.sb = mt > 0 && /px$/.test(s.marginTop) ? Math.round(mt * 15) : 0;
      pp.sa = mb > 0 && /px$/.test(s.marginBottom) ? Math.round(mb * 15) : 0;
      return pp;
    }

    function block(el, t, ctx) {
      const before = sink.length;
      let c = Object.assign({}, ctx, { f: fmtOf(el, ctx.f), pp: blockPP(el, ctx) });
      if (t === 'ul' || t === 'ol') {
        const level = ctx.pp.list ? ctx.pp.list.level + 1 : 0;
        let nItem = +(el.getAttribute('start') || 1);
        for (const ch of Array.from(el.childNodes)) {
          if (ch.nodeType === 1 && ch.tagName.toLowerCase() === 'li') {
            const pp = Object.assign(blockPP(ch, c), { list: { type: t, level, n: nItem++, cont: false } });
            const li = Object.assign({}, c, { f: fmtOf(ch, c.f), pp });
            const b0 = sink.length;
            children(ch, li);
            flush();
            if (sink.length === b0) { para = { pp, body: '' }; flush(); }
          } else inline(ch, c);
        }
        flush();
        return;
      }
      if (t === 'table' && !ctx.pp.intbl) { table(el, c); return; }
      if (/^h[1-6]$/.test(t)) c.f = Object.assign({}, c.f, { b: true, size: HSIZE[t] });
      if (t === 'blockquote') c.pp.li = (c.pp.li || 0) + 720;
      if (t === 'pre') c.f = Object.assign({}, c.f, { font: 'Courier New' });
      if (t === 'hr') { para = { pp: Object.assign({}, c.pp, { border: true }), body: '' }; flush(); return; }
      children(el, c);
      flush();
      const leaf = !['div', 'section', 'article', 'header', 'footer', 'figure', 'center', 'tbody', 'thead', 'tfoot', 'tr', 'dl'].includes(t);
      if (sink.length === before && leaf) { para = { pp: c.pp, body: '' }; flush(); }
    }

    function table(el, ctx) {
      const rows = Array.from(el.querySelectorAll(':scope > tr, :scope > tbody > tr, :scope > thead > tr, :scope > tfoot > tr'));
      for (const tr of rows) {
        const cells = Array.from(tr.children).filter(x => /^t[dh]$/i.test(x.tagName));
        if (!cells.length) continue;
        const pxs = cells.map(td => parseFloat(td.style.width) || td.offsetWidth || 0);
        const known = pxs.filter(Boolean).reduce((a, b) => a + b, 0);
        const unknown = pxs.filter(x => !x).length;
        const fill = unknown ? Math.max(40, (640 - known) / unknown) : 0;
        let def = '\\trowd\\trgaph108\\trleft0', x = 0;
        for (const w of pxs) {
          x += Math.round((w || fill) * 15);
          def += '\\clbrdrt\\brdrs\\brdrw10\\clbrdrl\\brdrs\\brdrw10\\clbrdrb\\brdrs\\brdrw10\\clbrdrr\\brdrs\\brdrw10\\cellx' + x;
        }
        out(def + '\n');
        for (const td of cells) {
          const saved = sink;
          sink = [];
          const pp = Object.assign({}, ctx.pp, { intbl: true, list: null, li: 0, fi: 0 });
          const c = { f: fmtOf(td, ctx.f), pp };
          const b0 = sink.length;
          children(td, c);
          flush();
          if (sink.length === b0) { para = { pp, body: '' }; flush(); }
          const cellRtf = sink.join('').replace(/\\par\n$/, '\\cell\n');
          sink = saved;
          out(cellRtf);
        }
        out('\\row\n');
      }
      // the next paragraph starts with \pard, which leaves the table
    }

    const ctx = { f: { size: base.size, font: base.font }, pp: { align: '', li: 0, fi: 0, intbl: false, list: null } };
    children(root, ctx);
    flush();

    const fonttbl = '{\\fonttbl' + fonts.map((f, i) => '{\\f' + i + (i === 1 ? '\\ftech\\fcharset2 ' : '\\fnil\\fcharset0 ') + escText(f) + ';}').join('') + '}';
    const colortbl = '{\\colortbl;' + colors.map(c => '\\red' + parseInt(c.substr(1, 2), 16) + '\\green' + parseInt(c.substr(3, 2), 16) + '\\blue' + parseInt(c.substr(5, 2), 16) + ';').join('') + '}';
    return '{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1\n' + fonttbl + '\n' + colortbl + '\n{\\*\\generator shelf;}' +
      '\\paperw11906\\paperh16838\\margl1134\\margr1134\\margt1134\\margb1134\\viewkind4\n' +
      '\\pard\\plain\\f0\\fs' + Math.round(base.size * 2) + '\n' + sink.join('') + '}\n';
  }

  const EMPTY = '{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl{\\f0\\fnil\\fcharset0 Arial;}}\\pard\\plain\\f0\\fs24\\par}\n';
  return { parse, write, bytesToString, toRgb, EMPTY };
})();

/* The editor: toolbar + a contenteditable "paper". opts = {readonly, onChange(dirty)} */
class RtfEditor {
  constructor(host, bytes, opts) {
    this.opts = opts || {};
    const doc = RTF.parse(RTF.bytesToString(bytes));
    this.font = doc.font;
    this.lost = doc.lost;
    this.dirty = false;
    const ro = !!this.opts.readonly;
    const cmd = (c, v) => () => { this.page.focus(); document.execCommand(c, false, v); this.touch(); this.states(); };
    const b = (label, title, fn, cls) => {
      const el = h('button', { text: label, title, class: cls || null });
      el.addEventListener('mousedown', e => e.preventDefault());   // keep the selection in the page
      el.addEventListener('click', fn);
      return el;
    };
    this.bb = b('b', 'bold (ctrl+b)', cmd('bold'), 'fmt-b');
    this.bi = b('i', 'italic (ctrl+i)', cmd('italic'), 'fmt-i');
    this.bu = b('u', 'underline (ctrl+u)', cmd('underline'), 'fmt-u');
    this.bs = b('s', 'strike through', cmd('strikeThrough'), 'fmt-s');
    const fontSel = h('select', { title: 'font' },
      h('option', { value: '', text: 'font' }),
      [this.font, 'Arial', 'Calibri', 'Cambria', 'Courier New', 'Georgia', 'Liberation Serif', 'Times New Roman', 'Verdana']
        .filter((f, i, a) => a.indexOf(f) === i).map(f => h('option', { value: f, text: f })));
    fontSel.addEventListener('change', () => { if (fontSel.value) { cmd('fontName', fontSel.value)(); } fontSel.value = ''; });
    const sizeSel = h('select', { title: 'size (pt)' }, h('option', { value: '', text: 'size' }),
      [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48].map(s => h('option', { value: s, text: s + 'pt' })));
    sizeSel.addEventListener('change', () => { if (sizeSel.value) this.fontSize(+sizeSel.value); sizeSel.value = ''; });
    const color = h('input', { type: 'color', value: '#c0473b', title: 'text colour' });
    color.addEventListener('input', () => cmd('foreColor', color.value)());
    const mark = h('input', { type: 'color', value: '#ffff00', title: 'highlight' });
    mark.addEventListener('input', () => cmd('hiliteColor', mark.value)());
    this.paper = h('input', { type: 'checkbox', checked: localStorage.getItem('shelf.paper') !== '0' });
    this.paper.addEventListener('change', () => {
      localStorage.setItem('shelf.paper', this.paper.checked ? '1' : '0');
      this.wrap.classList.toggle('paper', this.paper.checked);
    });
    const bar = h('div', { class: 'toolbar rtf-bar' },
      ro ? null : [
        b('undo', 'undo (ctrl+z)', cmd('undo')), b('redo', 'redo (ctrl+y)', cmd('redo')), h('span', { class: 'sep' }),
        this.bb, this.bi, this.bu, this.bs,
        b('x²', 'superscript', cmd('superscript')), b('x₂', 'subscript', cmd('subscript')), h('span', { class: 'sep' }),
        fontSel, sizeSel, color, b('auto', 'automatic text colour', () => this.autoColor()), mark,
        b('clear', 'remove formatting', cmd('removeFormat')), h('span', { class: 'sep' }),
        b('left', 'align left', cmd('justifyLeft')), b('center', 'center', cmd('justifyCenter')),
        b('right', 'align right', cmd('justifyRight')), b('justify', 'justify', cmd('justifyFull')), h('span', { class: 'sep' }),
        b('• list', 'bullet list', cmd('insertUnorderedList')), b('1. list', 'numbered list', cmd('insertOrderedList')),
        b('>>', 'indent', cmd('indent')), b('<<', 'outdent', cmd('outdent')), h('span', { class: 'sep' }),
        b('link', 'link (ctrl+k)', () => this.link()), b('image', 'insert a picture (PNG / JPEG)', () => this.image()),
        b('table', 'insert a table', () => this.table()), b('rule', 'horizontal line', cmd('insertHorizontalRule')),
      ],
      h('span', { class: 'spacer' }),
      h('label', { class: 'chk', title: 'black on white, like print' }, this.paper, ' paper'));
    this.page = h('div', { class: 'rtf-page', contenteditable: ro ? 'false' : 'true', spellcheck: true });
    this.page.style.fontFamily = "'" + this.font.replace(/['"]/g, '') + "', sans-serif";
    this.page.innerHTML = doc.html || '<p><br></p>';
    this.wrap = h('div', { class: 'rtf-wrap' + (this.paper.checked ? ' paper' : '') }, this.page);
    clear(host).append(bar, this.wrap);
    host.classList.add('rtf-host');
    try {
      document.execCommand('defaultParagraphSeparator', false, 'p');
      document.execCommand('styleWithCSS', false, false);
    } catch (e) { /* old browser */ }
    this.page.addEventListener('input', () => this.touch());
    this.page.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); this.link(); }
    });
    this.page.addEventListener('paste', e => this.paste(e));
    // links: ctrl+click opens, a plain click edits
    this.page.addEventListener('click', e => {
      const a = e.target.closest('a');
      if (a && (e.ctrlKey || e.metaKey)) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); }
    });
    this.onSel = () => this.states();
    document.addEventListener('selectionchange', this.onSel);
  }

  destroy() { document.removeEventListener('selectionchange', this.onSel); }

  touch() {
    if (this.dirty) return;
    this.dirty = true;
    if (this.opts.onChange) this.opts.onChange(true);
  }
  markSaved() { this.dirty = false; if (this.opts.onChange) this.opts.onChange(false); }

  states() {
    if (!this.page.contains(document.getSelection().anchorNode)) return;
    const q = c => { try { return document.queryCommandState(c); } catch (e) { return false; } };
    this.bb.classList.toggle('on', q('bold'));
    this.bi.classList.toggle('on', q('italic'));
    this.bu.classList.toggle('on', q('underline'));
    this.bs.classList.toggle('on', q('strikeThrough'));
  }

  text() { return RTF.write(this.page, { font: this.font, size: 12 }); }

  /* execCommand only knows sizes 1-7; mark with 7, then set the real size */
  fontSize(pt) {
    this.page.focus();
    document.execCommand('fontSize', false, '7');
    for (const f of this.page.querySelectorAll('font[size="7"]')) {
      f.removeAttribute('size');
      f.style.fontSize = pt + 'pt';
    }
    this.touch();
  }

  /* black is written as "automatic"; drop it from the page too, or it is unreadable when dark */
  autoColor() {
    this.page.focus();
    document.execCommand('foreColor', false, '#000000');
    for (const f of this.page.querySelectorAll('font[color]')) {
      if (RTF.toRgb(f.getAttribute('color')) !== '#000000') continue;
      f.removeAttribute('color');
      if (!f.attributes.length) f.replaceWith(...f.childNodes);
    }
    for (const el of this.page.querySelectorAll('[style*="color"]')) {
      if (RTF.toRgb(el.style.color) === '#000000') el.style.color = '';
    }
    this.touch();
  }

  async link() {
    const sel = document.getSelection();
    const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const a = sel.anchorNode && sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest('a');
    const url = await ask('link', 'address (empty removes the link)', a ? a.getAttribute('href') : 'https://', 'set');
    if (url === null) return;
    this.page.focus();
    if (range) { sel.removeAllRanges(); sel.addRange(range); }
    if (!url.trim()) { document.execCommand('unlink'); this.touch(); return; }
    if (!/^(https?:|mailto:)/i.test(url.trim())) { toast('links must start with http://, https:// or mailto:', 'err'); return; }
    if (range && range.collapsed) document.execCommand('insertHTML', false, '<a href="' + url.trim().replace(/"/g, '%22') + '">' + escHtml(url.trim()) + '</a>');
    else document.execCommand('createLink', false, url.trim());
    this.touch();
  }

  image() {
    const inp = h('input', { type: 'file', accept: 'image/png,image/jpeg' });
    inp.addEventListener('change', () => { if (inp.files[0]) this.insertImage(inp.files[0]); });
    inp.click();
  }

  insertImage(file) {
    if (!/^image\/(png|jpeg)$/.test(file.type)) { toast('only PNG and JPEG pictures go into RTF', 'err'); return; }
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        // no wider than the page
        const w = Math.min(img.naturalWidth, 640), hgt = Math.round(img.naturalHeight * w / img.naturalWidth);
        this.page.focus();
        document.execCommand('insertHTML', false, '<img src="' + r.result + '" style="width:' + w + 'px;height:' + hgt + 'px" alt="">');
        this.touch();
      };
      img.src = r.result;
    };
    r.readAsDataURL(file);
  }

  paste(e) {
    const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
    const img = items.find(i => i.kind === 'file' && /^image\/(png|jpeg)$/.test(i.type));
    if (img && !e.clipboardData.getData('text/html')) { e.preventDefault(); this.insertImage(img.getAsFile()); }
  }

  async table() {
    const v = await ask('table', 'columns x rows', '3x3', 'insert');
    if (!v) return;
    const m = /^\s*(\d+)\s*[x×*, ]\s*(\d+)\s*$/.exec(v);
    if (!m || +m[1] < 1 || +m[2] < 1 || +m[1] > 30 || +m[2] > 500) { toast('say it like 3x4 (columns x rows)', 'err'); return; }
    const w = Math.floor(640 / +m[1]);
    let s = '<table class="rtf-table"><tbody>';
    for (let r = 0; r < +m[2]; r++) {
      s += '<tr>';
      for (let c = 0; c < +m[1]; c++) s += '<td style="width:' + w + 'px"><br></td>';
      s += '</tr>';
    }
    s += '</tbody></table><p><br></p>';
    this.page.focus();
    document.execCommand('insertHTML', false, s);
    this.touch();
  }
}
