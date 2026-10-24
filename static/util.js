/* shelf: small helpers shared by the app and the public page. Plain
   scripts, no build step; everything is a global. */
'use strict';

function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

/* h('div', {class: 'x', onclick: fn, title: 't'}, 'text', child, [more]) */
function h(tag, attrs) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false || k === 'value') continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (let i = 2; i < arguments.length; i++) add(el, arguments[i]);
  // after the children, so a <select> has its options
  if (attrs && attrs.value !== undefined && attrs.value !== null) el.value = attrs.value;
  return el;
}
function add(el, c) {
  if (c === null || c === undefined || c === false) return;
  if (Array.isArray(c)) c.forEach(x => add(el, x));
  else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
}
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

/* ---- paths ---- */
function splitPath(p) { return (p || '').split('/').filter(Boolean); }
function encPath(p) { return splitPath(p).map(encodeURIComponent).join('/'); }
function joinPath(a, b) { return '/' + splitPath(a).concat(splitPath(b)).join('/'); }
function parentPath(p) { const s = splitPath(p); s.pop(); return '/' + s.join('/'); }
function baseName(p) { const s = splitPath(p); return s.length ? s[s.length - 1] : ''; }
function extOf(name) { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; }
function stem(name) { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(0, i) : name; }

const KINDS = {
  video: 'mp4 m4v webm mkv mov ogv',
  audio: 'mp3 m4a aac ogg oga opus flac wav',
  image: 'png jpg jpeg gif webp svg bmp avif ico',
  pdf: 'pdf',
  md: 'md markdown',
  csv: 'csv tsv',
  sheet: 'ods xlsx xlsm',
  rtf: 'rtf',
  text: 'txt log json xml yaml yml toml ini conf cfg sh bash py rs js mjs ts css html htm c h cpp hpp go java kt ' +
        'srt vtt sql diff patch env service gitignore dockerfile makefile',
};
const KIND_OF = {};
for (const k in KINDS) KINDS[k].split(' ').forEach(e => { KIND_OF[e] = k; });
function kindOf(name) { return KIND_OF[extOf(name)] || (extOf(name) === '' && /^(readme|license|makefile|dockerfile)$/i.test(name) ? 'text' : 'other'); }
/* what the in-browser editors handle; of the spreadsheets, only ods (xlsx is shown, and exported to) */
function editorOf(name) { const k = kindOf(name); return k === 'md' || k === 'csv' || k === 'rtf' || k === 'text' || (k === 'sheet' && extOf(name) === 'ods') ? k : null; }

/* ---- formatting ---- */
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  const u = ['KiB', 'MiB', 'GiB', 'TiB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
}
/* at most two digits and a letter: 75G, 2.9T; three with top 999.5: 150G */
function fmtShort(n, top) {
  const u = ['B', 'K', 'M', 'G', 'T', 'P'];
  let i = 0;
  while (n >= (top || 99.5) && i < u.length - 1) { n /= 1024; i++; }
  return (i > 0 && n < 9.95 ? n.toFixed(1) : Math.round(n)) + u[i];
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }
/* ISO 8601 in local time, minutes: 2026-09-27 13:40 */
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/* ---- server ---- */
class ApiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}
/* JSON API call; state-changing calls carry X-Shelf (the server insists) */
async function api(method, url, body) {
  const o = { method, headers: { 'x-shelf': '1' }, credentials: 'same-origin' };
  if (body !== undefined) { o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(body); }
  let r;
  try { r = await fetch(url, o); } catch (e) { throw new ApiError(tx('server unreachable'), 0); }
  let data = null;
  try { data = await r.json(); } catch (e) { /* not JSON */ }
  if (!r.ok) {
    if (r.status === 401 && window.onUnauthorized) window.onUnauthorized();
    throw new ApiError(txErr((data && data.error) || (r.status + ' ' + r.statusText)), r.status);
  }
  return data;
}

/* ---- toast: on, then off; no fade ---- */
let toastTimer = null;
function toast(msg, kind) {
  let el = $('#toast');
  if (!el) {
    el = h('div', { id: 'toast', class: 'win toast' }, h('div', { class: 'titlebar' }), h('div', { class: 'body' }));
    document.body.appendChild(el);
  }
  el.querySelector('.titlebar').textContent = kind === 'err' ? tx('error') : kind === 'warn' ? tx('note') : tx('ok');
  el.querySelector('.titlebar').className = 'titlebar' + (kind === 'err' ? ' bad' : '');
  el.querySelector('.body').textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'err' ? 6000 : 2500);
}
function fail(e) { toast(txErr(e && e.message ? e.message : String(e)), 'err'); }

/* ---- dialogs: a .win over a dimmed page, instant ---- */
let dlgOpen = 0;
function dialog(opts) {
  return new Promise(resolve => {
    const prev = document.activeElement;
    const btns = h('div', { class: 'dlg-buttons' });
    const body = h('div', { class: 'body' }, opts.body || null);
    const win = h('div', { class: 'win dlg' + (opts.wide ? ' wide' : ''), role: 'dialog' },
      h('div', { class: 'titlebar' }, h('span', { class: 'grip', text: '::' }), opts.title || '', h('span', { class: 'spacer' }),
        h('button', { class: 'dlg-x', text: 'x', title: tx('close (esc)'), onclick: () => done(null) })),
      body, btns);
    const back = h('div', { class: 'dlg-back' }, win);
    let finished = false, checking = false;
    /* check(v) may be async (a server call): the dialog stays open on an error */
    async function done(v) {
      if (finished || checking) return;
      if (v !== null && opts.check) {
        checking = true;
        win.classList.add('busy');
        let err;
        try { err = await opts.check(v); } catch (e) { err = e.message || String(e); }
        checking = false;
        win.classList.remove('busy');
        if (err) { toast(err, 'err'); return; }
      }
      finished = true;
      back.remove();
      dlgOpen--;
      document.removeEventListener('keydown', key, true);
      if (prev && prev.focus) prev.focus();
      resolve(v);
    }
    (opts.buttons || [{ label: tx('ok'), value: true, primary: true }]).forEach(b => {
      btns.appendChild(h('button', { class: (b.primary ? 'primary' : '') + (b.danger ? ' danger' : ''), text: b.label,
        onclick: () => done(typeof b.value === 'function' ? b.value() : b.value) }));
    });
    function key(e) {
      if (!back.isConnected) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
      else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
        const p = (opts.buttons || []).find(b => b.primary);
        if (p || !opts.buttons) { e.preventDefault(); done(p ? (typeof p.value === 'function' ? p.value() : p.value) : true); }
      }
    }
    document.addEventListener('keydown', key, true);
    back.addEventListener('pointerdown', e => { if (e.target === back) done(null); });
    document.body.appendChild(back);
    dlgOpen++;
    const f = win.querySelector('[autofocus]') || win.querySelector('input, select, textarea') || btns.querySelector('.primary');
    if (f) { f.focus(); if (opts.select) opts.select(f); }
    if (opts.opened) opts.opened(win, done);
  });
}

/* a .win at x, y (a menu, a filter), gone on esc or a click elsewhere; on narrow screens a sheet at the bottom.
   Gives close(). */
function popup(x, y, win, onclose) {
  const back = h('div', { class: 'pop-back' }, win);
  win.classList.add('pop');
  function close() {
    if (!back.isConnected) return;
    back.remove();
    dlgOpen--;
    document.removeEventListener('keydown', key, true);
    if (onclose) onclose();
  }
  function key(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }
  document.addEventListener('keydown', key, true);
  back.addEventListener('pointerdown', e => { if (e.target === back) close(); });
  back.addEventListener('contextmenu', e => { if (e.target === back) { e.preventDefault(); close(); } });
  document.body.appendChild(back);
  dlgOpen++;
  if (innerWidth <= 760) win.classList.add('pop-sheet');
  else {
    const r = win.getBoundingClientRect();
    win.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
    win.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  }
  return close;
}

function ask(title, label, value, okLabel) {
  const inp = h('input', { type: 'text', value: value || '', spellcheck: false, class: 'wide' });
  return dialog({
    title, body: [h('label', { class: 'lbl', text: label }), inp],
    buttons: [{ label: tx('cancel'), value: null }, { label: okLabel || tx('ok'), primary: true, value: () => inp.value }],
    // select the name without its extension, like a file manager
    select: el => { const v = el.value, i = v.lastIndexOf('.'); el.setSelectionRange(0, i > 0 ? i : v.length); },
  });
}

function confirmBox(title, text, okLabel, danger) {
  return dialog({
    title, body: h('div', { class: 'dlg-text', text }),
    buttons: [{ label: tx('cancel'), value: false }, { label: okLabel || tx('ok'), primary: true, danger, value: true }],
  }).then(v => !!v);
}

/* copy text; works on plain http too */
function copyText(t) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t).then(() => true, () => false);
  const ta = h('textarea', { style: { position: 'fixed', top: '-100px' } });
  ta.value = t;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { /* no */ }
  ta.remove();
  return Promise.resolve(ok);
}

/* .srt subtitles to WebVTT, which is what <track> takes */
function srtToVtt(s) {
  return 'WEBVTT\n\n' + s.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
    .replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2')
    .replace(/^\d+\n(?=\d\d:\d\d)/gm, '');
}

/* stepped busy marker for the status bar */
let busyN = 0;
function busy(on) {
  busyN = Math.max(0, busyN + (on ? 1 : -1));
  const el = $('#busy');
  if (el) el.hidden = busyN === 0;
}
