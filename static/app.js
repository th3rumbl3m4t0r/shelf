/* shelf web app: router, pages, dialogs. A plain script after util.js,
   viewer.js, csv.js and rtf.js. Pages are {el, title, key(e), save(),
   dirty(), destroy()}; the router swaps them in #app. */
'use strict';

const S = { me: null, page: null, url: '', seq: 0 };

/* ---- urls: /files/<loc>/<path>, /view/…, /edit/…; paths are /a/b ---- */
function encP(p) { const e = encPath(p); return e ? '/' + e : ''; }
const U = {
  files: (loc, p) => '/files/' + loc + '/' + encPath(p),
  view: (loc, p) => '/view/' + loc + encP(p),
  edit: (loc, p) => '/edit/' + loc + encP(p),
  raw: (loc, p) => '/api/raw/' + loc + encP(p),
  ls: (loc, p) => '/api/ls/' + loc + encP(p),
  du: (loc, p) => '/api/du/' + loc + encP(p),
};
function itemUrl(loc, p, dir) { return dir ? U.files(loc, p) : U.view(loc, p); }
function absUrl(u) { return /^https?:\/\//.test(u) ? u : location.origin + u; }
function decodeSegs(rest) {
  return '/' + (rest || '').split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch (e) { return s; } }).join('/');
}
function checkName(n) {
  if (!n || !n.trim()) return 'a name is needed';
  if (n.includes('/')) return 'no slashes in names';
  if (n === '.' || n === '..') return 'not a usable name';
  return null;
}

/* PUT a body; JSON back, or an ApiError */
async function putRaw(url, body, headers) {
  let r;
  try {
    r = await fetch(url, { method: 'PUT', credentials: 'same-origin', headers: Object.assign({ 'x-shelf': '1' }, headers || {}), body });
  } catch (e) { throw new ApiError('server unreachable', 0); }
  let data = null;
  try { data = await r.json(); } catch (e) { /* not JSON */ }
  if (!r.ok) {
    if (r.status === 401 && window.onUnauthorized) window.onUnauthorized();
    throw new ApiError((data && data.error) || (r.status + ' ' + r.statusText), r.status);
  }
  return data;
}

function setStatus(t) { const el = $('#status'); if (el) el.textContent = t || ''; }
function isTyping(e) {
  const t = e.target;
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t && t.isContentEditable);
}
function field(label, input, cls) { return h('div', { class: 'field' + (cls ? ' ' + cls : '') }, h('label', { class: 'lbl', text: label }), input); }
function win(title, body, cls) {
  return h('section', { class: 'win' + (cls ? ' ' + cls : '') },
    h('div', { class: 'titlebar' }, h('span', { class: 'grip', text: '::' }), title), h('div', { class: 'body' }, body));
}
function btn(text, title, onclick, cls) { return h('button', { text, title: title || null, class: cls || null, onclick }); }
function genPassword() {
  const a = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint32Array(16)), x => a[x % a.length]).join('');
}
function fmtDate(ts) { return ts ? fmtTime(ts).slice(0, 10) : ''; }

/* ---- router ---- */
const NAV = [['files', '/files/home/'], ['shared', '/shared'], ['links', '/links'], ['settings', '/settings'], ['admin', '/admin']];
const ROUTES = [
  [/^\/login$/, () => loginPage()],
  [/^\/files\/([^/]+)(\/.*)?$/, m => filesPage(m[1], decodeSegs(m[2]))],
  [/^\/view\/([^/]+)(\/.*)?$/, m => viewPage(m[1], decodeSegs(m[2]))],
  [/^\/edit\/([^/]+)(\/.*)?$/, m => editPage(m[1], decodeSegs(m[2]))],
  [/^\/pictures$/, () => picturesPage()],
  [/^\/shared$/, () => sharedPage()],
  [/^\/links$/, () => linksPage()],
  [/^\/settings$/, () => settingsPage()],
  [/^\/admin$/, () => adminPage()],
];

function navigate(url, replace) {
  if (url !== location.pathname + location.search) history[replace ? 'replaceState' : 'pushState'](null, '', url);
  return route();
}

async function loadMe() {
  try { S.me = await api('GET', '/api/me'); } catch (e) { if (e.status === 401) S.me = null; else throw e; }
  paintTop();
}

async function route() {
  const url = location.pathname + location.search;
  if (S.page && url !== S.url && S.page.dirty && S.page.dirty()) {
    if (!(await confirmBox('unsaved changes', 'leave this page? the changes are lost.', 'leave', true))) {
      if (location.pathname + location.search !== S.url) history.pushState(null, '', S.url);
      return;
    }
  }
  const seq = ++S.seq;
  if (S.page && S.page.destroy) S.page.destroy();
  S.page = null;
  S.url = url;
  const path = location.pathname;
  if (!S.me && path !== '/login') {
    try { await loadMe(); } catch (e) { showPage(errorPage(e)); return; }
    if (seq !== S.seq) return;
    if (!S.me) { history.replaceState(null, '', '/login?next=' + encodeURIComponent(url)); S.url = location.pathname + location.search; }
  }
  if (location.pathname === '/login' && S.me) { history.replaceState(null, '', '/files/home/'); S.url = '/files/home/'; }
  if (location.pathname === '/') return navigate('/files/home/', true);
  markNav();
  let fn = null, m = null;
  for (const [re, f] of ROUTES) { m = re.exec(location.pathname); if (m) { fn = f; break; } }
  let page;
  busy(true);
  try { page = fn ? await fn(m) : errorPage(new Error('no such page')); } catch (e) { page = errorPage(e); } finally { busy(false); }
  if (seq !== S.seq) { if (page && page.destroy) page.destroy(); return; }
  if (page.redirect) return navigate(page.redirect, true);
  showPage(page);
}

function showPage(page) {
  const main = clear($('#app'));
  main.className = page.cls || '';
  main.appendChild(page.el);
  S.page = page;
  document.title = (page.title ? page.title + ' · ' : '') + 'shelf';
  setStatus(page.status || '');
  if (page.shown) page.shown();
}

function errorPage(e) {
  const back = S.me ? h('a', { class: 'btn-link', href: '/files/home/', text: 'home' }) : null;
  return { el: win('error', [h('p', { class: 'bad', text: e.message || String(e) }), back], 'narrow'), title: 'error' };
}

function paintTop() {
  const nav = clear($('#nav')), who = clear($('#who'));
  document.body.classList.toggle('anon', !S.me);
  if (!S.me) return;
  for (const [name, href] of NAV) {
    if (name !== 'admin' || S.me.admin) nav.appendChild(h('a', { href, text: name, 'data-sec': name }));
  }
  who.append(h('span', { class: 'dim', text: S.me.username }), btn('log out', null, logout));
  markNav();
}
function markNav() {
  const seg = location.pathname.split('/')[1];
  const sec = seg === 'view' || seg === 'edit' || seg === 'pictures' ? 'files' : seg;
  for (const a of $$('#nav a')) a.classList.toggle('on', a.dataset.sec === sec);
}

async function logout() {
  if (S.page && S.page.dirty && S.page.dirty() && !(await confirmBox('unsaved changes', 'log out and lose the changes?', 'log out', true))) return;
  try { await api('POST', '/api/logout'); } catch (e) { /* gone anyway */ }
  S.me = null;
  if (S.page && S.page.destroy) S.page.destroy();
  S.page = null;
  paintTop();
  navigate('/login', true);
}

window.onUnauthorized = () => {
  if (!S.me) return;
  // an editor with changes stays open: the user can log in elsewhere and save again
  if (S.page && S.page.dirty && S.page.dirty()) { toast('logged out: log in again in another tab, then save', 'err'); return; }
  S.me = null;
  paintTop();
  navigate('/login?next=' + encodeURIComponent(S.url), true);
};

/* ---- login ---- */
function loginPage() {
  const next = new URLSearchParams(location.search).get('next') || '/files/home/';
  const user = h('input', { type: 'text', autocomplete: 'username', spellcheck: false, autocapitalize: 'off' });
  const pass = h('input', { type: 'password', autocomplete: 'current-password' });
  const msg = h('div', { class: 'bad login-msg' });
  const go = h('button', { class: 'primary', type: 'submit', text: 'log in' });
  const form = h('form', { class: 'win login' },
    h('div', { class: 'titlebar' }, h('span', { class: 'grip', text: '::' }), 'log in'),
    h('div', { class: 'body' }, field('user', user), field('password', pass), msg, h('div', { class: 'row-end' }, go)));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    go.disabled = true;
    msg.textContent = '';
    try {
      await api('POST', '/api/login', { username: user.value.trim(), password: pass.value });
      await loadMe();
      navigate(next.startsWith('/') && !next.startsWith('//') ? next : '/files/home/', true);
    } catch (err) {
      msg.textContent = err.message;
      pass.select();
    } finally { go.disabled = false; }
  });
  return { el: h('div', { class: 'login-page' }, form), title: 'log in', shown: () => user.focus() };
}

/* ---- places: home, sftp storage, things shared with me ---- */
async function loadPlaces() {
  const [mounts, shares] = await Promise.all([api('GET', '/api/mounts'), api('GET', '/api/shares')]);
  return {
    mounts: mounts.map(m => ({ loc: m.loc, name: m.name, title: 'sftp: ' + m.username + '@' + m.host + (m.root ? ':' + m.root : '') })),
    shares: shares.with_me.map(s => ({ loc: s.loc, name: s.name, dir: s.dir, title: 'from ' + s.user + (s.write ? ', can edit' : ', read only') })),
  };
}

/* room on the storage behind a location, asked at most once a minute: {size, used, free} or null */
const SPACE = new Map();
function spaceOf(loc) {
  const c = SPACE.get(loc);
  if (c && Date.now() - c.t < 60000) return c.p;
  const p = api('GET', '/api/space/' + encodeURIComponent(loc)).catch(() => null);
  SPACE.set(loc, { t: Date.now(), p });
  return p;
}
/* used/size in small print, grey until 80% full */
function spaceTag(loc) {
  const el = h('span', { class: 'space' });
  spaceOf(loc).then(s => {
    if (!s || !s.size) return;
    const full = s.used / (s.used + s.free || 1);
    el.textContent = fmtShort(s.used) + '/' + fmtShort(s.size);
    el.classList.toggle('full', full >= 0.8);
    el.title = fmtSize(s.used) + ' used, ' + fmtSize(s.free) + ' free of ' + fmtSize(s.size) + ' (' + Math.round(full * 100) + '% full)';
  });
  return el;
}

/* the places window; a click on its titlebar folds it away (remembered),
   metaplaces and all */
function placesBox(places, loc) {
  let here = loc === 'pictures' ? 'pictures' : 'home', hereLoc = loc === 'pictures' ? null : 'home';
  const a = (p, href) => {
    if (p.loc === loc) { here = p.name; hereLoc = p.loc === 'pictures' ? null : p.loc; }
    return h('a', { href, class: 'place' + (p.loc === loc ? ' on' : ''), title: p.title || null },
      h('span', { class: 'pn', text: p.name + (p.dir === false ? '' : '/') }),
      p.loc === 'pictures' ? null : spaceTag(p.loc));
  };
  const kids = [a({ loc: 'home', name: 'home' }, U.files('home', '/'))];
  if (places && places.mounts.length) {
    kids.push(h('div', { class: 'lbl', text: 'storage' }));
    places.mounts.forEach(p => kids.push(a(p, U.files(p.loc, '/'))));
  }
  if (places && places.shares.length) {
    kids.push(h('div', { class: 'lbl', text: 'shared with me' }));
    places.shares.forEach(p => kids.push(a(p, p.dir ? U.files(p.loc, '/') : U.view(p.loc, '/'))));
  }
  kids.push(h('div', { class: 'lbl', text: 'metaplaces' }));
  kids.push(a({ loc: 'pictures', name: 'pictures', dir: false, title: 'every picture here and shared with you, newest first' }, '/pictures'));
  const fold = h('span', { class: 'fold' });
  const box = win(['places', h('span', { class: 'crumbs place-here' }, here, hereLoc && ' ', hereLoc && spaceTag(hereLoc)), h('span', { class: 'spacer' }), fold], kids, 'places');
  const set = shaded => {
    box.classList.toggle('shaded', shaded);
    fold.textContent = shaded ? '[+]' : '[-]';
  };
  set(localStorage.getItem('shelf.places') === '0');
  const bar = box.querySelector('.titlebar');
  bar.title = 'fold / unfold the places';
  bar.addEventListener('click', () => {
    const shaded = !box.classList.contains('shaded');
    set(shaded);
    localStorage.setItem('shelf.places', shaded ? '0' : '1');
  });
  return box;
}

function crumbs(loc, rootName, path, last) {
  const segs = splitPath(path);
  const out = [h('a', { href: U.files(loc, '/'), text: rootName })];
  let p = '';
  segs.forEach((s, i) => {
    p += '/' + s;
    out.push(h('span', { class: 'dim', text: ' / ' }));
    out.push(i === segs.length - 1 && !last ? h('span', { class: 'here', text: s }) : h('a', { href: U.files(loc, p), text: s }));
  });
  return h('span', { class: 'crumbs' }, out);
}

/* ---- sorting ---- */
function sortEntries(list, s) {
  const d = s.d ? -1 : 1;
  return list.slice().sort((a, b) => (b.dir - a.dir) ||
    d * ((s.k === 'size' ? a.size - b.size : s.k === 'mtime' ? a.mtime - b.mtime : 0) || nameCmp(a.name, b.name)));
}

/* ---- the file list ---- */
async function filesPage(loc, path) {
  const [ls, places] = await Promise.all([api('GET', U.ls(loc, path)), loadPlaces().catch(() => null)]);
  if (ls.file) return { redirect: U.view(loc, path) };
  return new FilesView(loc, path, ls, places).page();
}

class FilesView {
  constructor(loc, path, ls, places) {
    this.loc = loc;
    this.path = path;
    this.ls = ls;
    this.write = ls.write;
    this.owner = ls.owner;
    try { this.sort = JSON.parse(localStorage.getItem('shelf.sort')) || { k: 'name', d: false }; } catch (e) { this.sort = { k: 'name', d: false }; }
    this.sel = new Set();
    this.cur = -1;
    this.anchor = -1;
    this.filter = '';
    this.typed = '';
    this.view = [];
    this.rows = [];
    this.build(places);
    this.setEntries(ls.entries);
  }

  page() {
    return {
      el: this.el, cls: 'fill', title: this.ls.root_name + (this.path === '/' ? '' : this.path),
      key: e => this.key(e),
      onUploaded: (loc, p) => { if (loc === this.loc && p.startsWith(this.path === '/' ? '/' : this.path + '/')) this.soon(); },
      destroy: () => clearTimeout(this.timer),
      shown: () => { this.upd(); this.wrap.focus(); },
    };
  }

  build(places) {
    const w = !this.write;
    this.bUp = btn('upload', 'upload files (or drop them on the list)', () => this.pick(false));
    this.bUpDir = btn('upload folder', 'upload a folder with everything in it', () => this.pick(true));
    this.newSel = h('select', { title: 'create something here' },
      h('option', { value: '', text: 'new…' }), h('option', { value: 'dir', text: 'folder' }),
      h('option', { value: 'md', text: 'markdown (.md)' }), h('option', { value: 'txt', text: 'text (.txt)' }),
      h('option', { value: 'csv', text: 'table (.csv)' }), h('option', { value: 'ods', text: 'spreadsheet (.ods)' }),
      h('option', { value: 'rtf', text: 'document (.rtf)' }));
    this.newSel.addEventListener('change', () => { const v = this.newSel.value; this.newSel.value = ''; if (v) this.create(v).catch(fail); });
    [this.bUp, this.bUpDir, this.newSel].forEach(b => { b.disabled = w; });
    this.bOpen = btn('open', 'open (enter)', () => this.openSel());
    this.bEdit = btn('edit', 'edit in the browser', () => this.editSel());
    this.bDl = btn('download', 'download', () => this.download());
    this.bRen = btn('rename', 'rename (f2)', () => this.rename().catch(fail));
    this.bMove = btn('move', 'move to another folder', () => this.move().catch(fail));
    this.bDel = btn('delete', 'delete (del)', () => this.remove().catch(fail), 'danger');
    this.bShare = btn('share', 'share with users or by link', () => this.share());
    this.filterIn = h('input', { type: 'search', class: 'filter', placeholder: 'filter (/)', spellcheck: false });
    this.filterIn.addEventListener('input', () => { this.filter = this.filterIn.value; this.render(); this.paint(); });
    this.filterIn.addEventListener('keydown', e => {
      if (e.key === 'Escape') { this.filterIn.value = ''; this.filter = ''; this.render(); this.paint(); this.wrap.focus(); }
      else if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); this.wrap.focus(); if (this.view.length && this.cur < 0) this.moveTo(0); }
    });
    const bar = h('div', { class: 'toolbar' }, this.bUp, this.bUpDir, this.newSel, h('span', { class: 'sep' }),
      this.bOpen, this.bEdit, this.bDl, this.bRen, this.bMove, this.bShare, this.bDel, h('span', { class: 'spacer' }), this.filterIn);

    const th = (k, label, cls) => {
      const el = h('th', { class: cls || null, text: label, title: 'sort' });
      el.addEventListener('click', () => {
        this.sort = { k, d: this.sort.k === k ? !this.sort.d : k !== 'name' };
        localStorage.setItem('shelf.sort', JSON.stringify(this.sort));
        this.render();
        this.paint();
      });
      el.dataset.k = k;
      return el;
    };
    this.thead = h('thead', {}, h('tr', {}, th('name', 'name', 'nm'), th('size', 'size', 'sz'), th('mtime', 'modified', 'tm')));
    this.tbody = h('tbody');
    this.empty = h('div', { class: 'empty dim' });
    this.wrap = h('div', { class: 'listwrap', tabindex: '0' }, h('table', { class: 'x11 files' }, this.thead, this.tbody), this.empty);
    this.drop = h('div', { class: 'dropnote', hidden: true }, h('span', { text: 'drop to upload here' }));

    this.tbody.addEventListener('mousedown', e => { if ((e.shiftKey || e.ctrlKey || e.metaKey) && !e.target.closest('a')) e.preventDefault(); });
    this.tbody.addEventListener('click', e => {
      if (e.target.closest('a')) return;
      const tr = e.target.closest('tr[data-i]');
      if (!tr) return;
      const i = +tr.dataset.i;
      if (i < 0) return;
      if (e.shiftKey && this.anchor >= 0) this.range(this.anchor, i, e.ctrlKey || e.metaKey);
      else if (e.ctrlKey || e.metaKey) { this.toggle(i); this.anchor = i; }
      else { this.sel = new Set([this.view[i].name]); this.anchor = i; }
      this.cur = i;
      this.paint();
    });
    this.tbody.addEventListener('dblclick', e => {
      if (e.target.closest('a')) return;
      const tr = e.target.closest('tr[data-i]');
      if (!tr) return;
      const i = +tr.dataset.i;
      if (i < 0) navigate(U.files(this.loc, parentPath(this.path)));
      else this.open(this.view[i]);
    });
    this.wrap.addEventListener('click', e => {
      if (e.target === this.wrap || e.target === this.empty) { this.sel.clear(); this.paint(); }
    });

    const fw = h('section', { class: 'win filewin' },
      h('div', { class: 'titlebar' }, h('span', { class: 'grip', text: '::' }), crumbs(this.loc, this.ls.root_name, this.path),
        this.write ? null : h('span', { class: 'tag', text: 'read only' })),
      bar, this.wrap, this.drop);
    fw.addEventListener('dragover', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = this.write ? 'copy' : 'none';
      if (this.write) this.drop.hidden = false;
    });
    this.drop.addEventListener('dragleave', () => { this.drop.hidden = true; });
    fw.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.drop.hidden = true;
      if (!this.write) { toast('this folder is read only', 'err'); return; }
      droppedFiles(e.dataTransfer).then(list => upload(this.loc, this.path, list), fail);
    });
    this.el = h('div', { class: 'files-layout' }, placesBox(places, this.loc), fw);
  }

  setEntries(entries, focus) {
    const curName = focus || (this.cur >= 0 && this.view[this.cur] ? this.view[this.cur].name : null);
    // folder sizes from before stand in until the new ones come
    const had = new Map((this.entries || []).filter(e => e.du).map(e => [e.name, e.size]));
    entries.forEach(e => { if (e.dir && had.has(e.name)) { e.size = had.get(e.name); e.du = true; } });
    this.entries = entries;
    this.render();
    const names = new Set(this.view.map(e => e.name));
    this.sel = focus ? new Set([focus]) : new Set([...this.sel].filter(n => names.has(n)));
    this.cur = curName ? this.view.findIndex(e => e.name === curName) : -1;
    this.anchor = this.cur;
    this.paint();
    if (focus && this.rows[this.cur]) this.rows[this.cur].scrollIntoView({ block: 'nearest' });
    this.sizes();
  }

  /* folder sizes come after the list: adding them up can take a moment */
  sizes() {
    if (!this.entries.some(e => e.dir)) return;
    const ask = this.duAsk = (this.duAsk || 0) + 1;
    api('GET', U.du(this.loc, this.path)).then(r => {
      if (ask !== this.duAsk) return;
      for (const e of this.entries) {
        if (e.dir && r.sizes[e.name] !== undefined) { e.size = r.sizes[e.name]; e.du = true; }
      }
      this.render();
      this.paint();
    }, () => {});
  }

  render() {
    const f = this.filter.toLowerCase();
    const curName = this.cur >= 0 && this.view[this.cur] ? this.view[this.cur].name : null;
    this.view = sortEntries(this.entries.filter(e => !f || e.name.toLowerCase().includes(f)), this.sort);
    this.rows = this.view.map((e, i) => {
      const p = joinPath(this.path, e.name);
      return h('tr', { 'data-i': i, class: e.dir ? 'd' : 'f' },
        h('td', { class: 'nm' }, h('a', { href: itemUrl(this.loc, p, e.dir), text: e.name + (e.dir ? '/' : ''), draggable: 'false' }),
          e.shared ? h('span', { class: 'tag', text: 'shared', title: 'shared with users' }) : null,
          e.linked ? h('span', { class: 'tag', text: 'link', title: 'has a public link' }) : null),
        h('td', { class: 'sz', text: e.dir && !e.du ? '' : fmtSize(e.size) }),
        h('td', { class: 'tm', text: fmtTime(e.mtime) }));
    });
    const up = splitPath(this.path).length
      ? [h('tr', { 'data-i': -1, class: 'up' }, h('td', { class: 'nm' }, h('a', { href: U.files(this.loc, parentPath(this.path)), text: '../', title: 'up (backspace)' })), h('td'), h('td'))]
      : [];
    this.tbody.replaceChildren(...up, ...this.rows);
    this.cur = curName ? this.view.findIndex(e => e.name === curName) : -1;
    for (const t of this.thead.querySelectorAll('th')) {
      t.classList.toggle('sorted', t.dataset.k === this.sort.k);
      t.classList.toggle('desc', t.dataset.k === this.sort.k && this.sort.d);
    }
    this.empty.textContent = this.view.length ? '' : this.entries.length ? 'nothing matches the filter' :
      this.write ? 'empty folder: drop files here or use upload' : 'empty folder';
  }

  paint() {
    this.rows.forEach((tr, i) => {
      tr.classList.toggle('sel', this.sel.has(this.view[i].name));
      tr.classList.toggle('cur', i === this.cur);
    });
    this.upd();
  }

  selected() { return this.view.filter(e => this.sel.has(e.name)); }

  upd() {
    const s = this.selected(), one = s.length === 1 ? s[0] : null, w = this.write;
    this.bOpen.disabled = !one;
    this.bEdit.disabled = !(one && !one.dir && editorOf(one.name) && w);
    this.bDl.disabled = !s.length || s.some(e => e.dir);
    this.bDl.title = s.some(e => e.dir) ? 'folders cannot be downloaded yet' : 'download';
    this.bRen.disabled = !(one && w);
    this.bMove.disabled = !(s.length && w);
    this.bDel.disabled = !(s.length && w);
    this.bShare.disabled = !(one && this.owner);
    const dirs = this.view.filter(e => e.dir).length, files = this.view.length - dirs;
    // folders count once their size is in
    const size = list => fmtSize(list.reduce((a, e) => a + (e.dir && !e.du ? 0 : e.size), 0));
    let t = dirs + (dirs === 1 ? ' folder, ' : ' folders, ') + files + (files === 1 ? ' file, ' : ' files, ') + size(this.view);
    if (s.length) t += '  |  ' + s.length + ' selected' + (s.some(e => !e.dir || e.du) ? ', ' + size(s) : '');
    setStatus(t);
  }

  toggle(i) {
    const n = this.view[i].name;
    if (this.sel.has(n)) this.sel.delete(n); else this.sel.add(n);
  }
  range(a, b, add) {
    if (!add) this.sel.clear();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.sel.add(this.view[i].name);
  }
  moveTo(i, shift, keep) {
    this.cur = i;
    if (shift && this.anchor >= 0) this.range(this.anchor, i, false);
    else if (!keep) { this.sel = new Set([this.view[i].name]); this.anchor = i; }
    this.paint();
    this.rows[i].scrollIntoView({ block: 'nearest' });
  }

  key(e) {
    if (isTyping(e)) return false;
    if (e.target instanceof HTMLButtonElement && (e.key === 'Enter' || e.key === ' ')) return false;
    const n = this.view.length, k = e.key, mod = e.ctrlKey || e.metaKey;
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 'pd', PageUp: 'pu', Home: 'h', End: 'e' }[k];
    if (step !== undefined && !e.altKey) {
      if (!n) return true;
      const pg = Math.max(1, Math.floor(this.wrap.clientHeight / 25) - 1);
      let c = this.cur;
      if (step === 1) c = c < 0 ? 0 : c + 1;
      else if (step === -1) c = c < 0 ? n - 1 : c - 1;
      else if (step === 'pd') c = Math.max(c, 0) + pg;
      else if (step === 'pu') c = Math.max(c, 0) - pg;
      else c = step === 'h' ? 0 : n - 1;
      this.moveTo(Math.max(0, Math.min(n - 1, c)), e.shiftKey, mod);
      return true;
    }
    if (k === 'Enter') {
      const s = this.selected();
      if (s.length === 1) this.open(s[0]);
      else if (this.cur >= 0) this.open(this.view[this.cur]);
      return true;
    }
    if (k === 'Backspace' || (k === 'ArrowUp' && e.altKey)) {
      if (splitPath(this.path).length) navigate(U.files(this.loc, parentPath(this.path)));
      return true;
    }
    if (k === 'Delete' && this.write && this.selected().length) { this.remove().catch(fail); return true; }
    if (k === 'F2' && this.write && this.selected().length === 1) { this.rename().catch(fail); return true; }
    if (mod && (k === 'a' || k === 'A')) { this.sel = new Set(this.view.map(x => x.name)); this.paint(); return true; }
    if (k === ' ' && this.cur >= 0) { this.toggle(this.cur); this.anchor = this.cur; this.paint(); return true; }
    if (k === 'Escape') { this.sel.clear(); this.paint(); return true; }
    if (k === '/') { this.filterIn.focus(); this.filterIn.select(); return true; }
    if (k.length === 1 && !mod && !e.altKey && n) {
      // type-ahead: jump to the first name starting with what was typed
      clearTimeout(this.typeTimer);
      this.typed += k.toLowerCase();
      this.typeTimer = setTimeout(() => { this.typed = ''; }, 800);
      const i = this.view.findIndex(x => x.name.toLowerCase().startsWith(this.typed));
      if (i >= 0) this.moveTo(i);
      return true;
    }
    return false;
  }

  soon() { clearTimeout(this.timer); this.timer = setTimeout(() => this.refresh(), 300); }

  async refresh(focus) {
    try {
      const ls = await api('GET', U.ls(this.loc, this.path));
      if (ls.entries) this.setEntries(ls.entries, focus);
    } catch (e) { fail(e); }
  }

  open(e) { navigate(itemUrl(this.loc, joinPath(this.path, e.name), e.dir)); }
  openSel() { const s = this.selected(); if (s.length === 1) this.open(s[0]); }
  editSel() { const s = this.selected(); if (s.length === 1) navigate(U.edit(this.loc, joinPath(this.path, s[0].name))); }

  pick(dir) {
    const inp = h('input', { type: 'file', multiple: true });
    if (dir) inp.webkitdirectory = true;
    inp.addEventListener('change', () => {
      upload(this.loc, this.path, Array.from(inp.files).map(f => ({ file: f, rel: dir && f.webkitRelativePath ? f.webkitRelativePath : f.name })));
    });
    inp.click();
  }

  download() {
    this.selected().filter(e => !e.dir).forEach((e, i) => setTimeout(() => {
      const a = h('a', { href: U.raw(this.loc, joinPath(this.path, e.name)) + '?dl=1', download: '' });
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, i * 400));
  }

  async rename() {
    const e = this.selected()[0];
    const nn = await dialogAsk('rename', 'new name', e.name, 'rename', async v => {
      const bad = checkName(v);
      if (bad) return bad;
      if (v === e.name) return null;
      await api('POST', '/api/mv', { loc: this.loc, moves: [{ from: joinPath(this.path, e.name), to: joinPath(this.path, v) }] });
    });
    if (nn && nn !== e.name) await this.refresh(nn);
  }

  async move() {
    const s = this.selected();
    const dest = await pickFolder(this.loc, this.path, 'move ' + (s.length === 1 ? s[0].name : s.length + ' items'),
      s.filter(e => e.dir).map(e => joinPath(this.path, e.name)));
    if (dest === null || dest === this.path) return;
    await api('POST', '/api/mv', { loc: this.loc, moves: s.map(e => ({ from: joinPath(this.path, e.name), to: joinPath(dest, e.name) })) });
    toast('moved to ' + dest);
    this.sel.clear();
    await this.refresh();
  }

  async remove() {
    const s = this.selected();
    const what = s.length === 1 ? s[0].name + (s[0].dir ? ' and everything in it' : '') : s.length + ' items';
    if (!(await confirmBox('delete', 'delete ' + what + '? this cannot be undone.', 'delete', true))) return;
    await api('POST', '/api/rm', { loc: this.loc, paths: s.map(e => joinPath(this.path, e.name)) });
    this.sel.clear();
    await this.refresh();
  }

  async create(kind) {
    if (kind === 'dir') {
      const n = await dialogAsk('new folder', 'name', 'new folder', 'create', async v => {
        const bad = checkName(v);
        if (bad) return bad;
        await api('POST', '/api/mkdir', { loc: this.loc, path: joinPath(this.path, v) });
      });
      if (n) await this.refresh(n);
      return;
    }
    const n = await dialogAsk('new file', 'name', 'untitled.' + kind, 'create', async v => {
      const bad = checkName(v);
      if (bad) return bad;
      const name = extOf(v) ? v : v + '.' + kind;
      const body = kind === 'ods' ? await OdsOut.blank() : { md: '# ' + stem(name) + '\n\n', txt: '', csv: '', rtf: RTF.EMPTY }[kind];
      await putRaw(U.raw(this.loc, joinPath(this.path, name)) + '?mode=new', body);
    });
    if (n) navigate(U.edit(this.loc, joinPath(this.path, extOf(n) ? n : n + '.' + kind)));
  }

  share() {
    const e = this.selected()[0];
    shareDialog(this.loc, joinPath(this.path, e.name), e.name).then(() => this.refresh());
  }
}

/* ask() whose check runs on the server before the dialog closes */
function dialogAsk(title, label, value, okLabel, check) {
  const inp = h('input', { type: 'text', value: value || '', spellcheck: false, class: 'wide' });
  return dialog({
    title, body: [h('label', { class: 'lbl', text: label }), inp],
    buttons: [{ label: 'cancel', value: null }, { label: okLabel, primary: true, value: () => inp.value.trim() }],
    select: el => { const v = el.value, i = v.lastIndexOf('.'); el.setSelectionRange(0, i > 0 ? i : v.length); },
    check,
  });
}

/* ---- folder picker for moves ---- */
function pickFolder(loc, start, title, exclude) {
  let cur = start;
  const where = h('div', { class: 'pick-path' });
  const list = h('div', { class: 'pick-list' });
  async function load(p) {
    list.replaceChildren(h('div', { class: 'dim', text: 'loading…' }));
    try {
      const ls = await api('GET', U.ls(loc, p));
      cur = p;
      where.textContent = ls.root_name + (p === '/' ? '/' : p + '/');
      const rows = [];
      if (splitPath(p).length) rows.push(btn('../', 'up', () => load(parentPath(p)), 'pick-item'));
      (ls.entries || []).filter(e => e.dir).map(e => e.name).sort(nameCmp).forEach(d => {
        const full = joinPath(p, d);
        const inside = exclude.some(x => full === x || full.startsWith(x + '/'));
        rows.push(h('button', { class: 'pick-item', text: d + '/', disabled: inside, title: inside ? 'cannot move a folder into itself' : null, onclick: () => load(full) }));
      });
      if (rows.length === (splitPath(p).length ? 1 : 0)) rows.push(h('div', { class: 'dim', text: '(no folders in here)' }));
      list.replaceChildren(...rows);
    } catch (e) { list.replaceChildren(h('div', { class: 'bad', text: e.message })); }
  }
  return dialog({
    title, body: [h('label', { class: 'lbl', text: 'to' }), where, list],
    buttons: [{ label: 'cancel', value: null }, { label: 'move here', primary: true, value: () => cur }],
    opened: () => load(start),
  });
}

/* ---- API keys: a program gets one folder (docs/API.md) ---- */
function keyRows(keys, again, withFolder) {
  return keys.map(k => {
    const expired = k.expires && k.expires * 1000 < Date.now();
    return h('tr', {},
      h('td', { text: k.name }),
      withFolder ? h('td', {}, h('a', { href: U.files(k.loc, k.path), text: k.loc_name + ':' + k.path })) : null,
      h('td', { class: k.write ? 'ok' : 'dim', text: k.write ? 'can edit' : 'read only' }),
      h('td', { class: expired ? 'bad' : 'dim', text: k.expires ? (expired ? 'expired ' : 'until ') + fmtDate(k.expires) : 'no expiry' }),
      h('td', { class: 'dim', text: k.last_used ? 'used ' + fmtTime(k.last_used) : 'never used' }),
      h('td', { class: 'act' }, btn('remove', 'the key stops working', async () => {
        if (await confirmBox('remove API key', 'remove ' + k.name + '? whatever uses it loses access.', 'remove', true)) api('DELETE', '/api/keys/' + k.id).then(again, fail);
      }, 'danger')));
  });
}

/* the key is shown once, here */
function keyShown(r) {
  const key = h('input', { type: 'text', value: r.key, readonly: true, spellcheck: false, class: 'wide mono' });
  const base = absUrl('/api/v1');
  return dialog({
    title: 'API key ' + r.name, wide: true,
    body: [h('p', { text: 'copy the key now: shelf keeps only a hash of it and cannot show it again.' }),
      h('div', { class: 'row' }, key, btn('copy', null, () => copyText(r.key).then(ok => toast(ok ? 'copied' : 'copy failed', ok ? '' : 'err')))),
      h('p', { class: 'dim', text: 'the program sends it as "Authorization: Bearer <key>" to ' + base + ' (' + (r.write ? 'read and write' : 'read only') + '). for example:' }),
      h('pre', { class: 'mono', text: 'curl -H "Authorization: Bearer ' + r.key + '" ' + base + '/list' }),
      h('p', { class: 'dim', text: 'the API is described in docs/API.md in the shelf repository.' })],
    buttons: [{ label: 'done', primary: true, value: true }],
    opened: () => key.select(),
  });
}

/* ---- share one item: users, public links and, for folders, API keys ---- */
function shareDialog(loc, path, name) {
  const box = h('div', { class: 'share' });
  let names = null;
  const q = '?loc=' + encodeURIComponent(loc) + '&path=' + encodeURIComponent(path);
  async function load() {
    const [it, us, allKeys] = await Promise.all([api('GET', '/api/shares/item' + q), names || api('GET', '/api/usernames'), api('GET', '/api/keys')]);
    names = us;
    const taken = new Set(it.shares.map(s => s.user));
    const others = names.map(n => (typeof n === 'string' ? n : n.username)).filter(n => n !== S.me.username && !taken.has(n));

    const urows = it.shares.map(s => {
      const w = h('input', { type: 'checkbox', checked: s.write, title: 'can change, add and delete' });
      w.addEventListener('change', () => api('POST', '/api/shares', { loc, path, user: s.user, write: w.checked }).then(load, fail));
      return h('tr', {}, h('td', { text: s.user }), h('td', {}, h('label', { class: 'chk' }, w, ' can edit')), h('td', { class: 'dim', text: fmtDate(s.created) }),
        h('td', { class: 'act' }, btn('remove', 'stop sharing with ' + s.user, () => api('DELETE', '/api/shares/' + s.id).then(load, fail))));
    });
    const who = h('select', {}, others.length ? others.map(n => h('option', { value: n, text: n })) : h('option', { value: '', text: '(nobody left)' }));
    const canEdit = h('input', { type: 'checkbox' });
    const add = btn('share', null, () => {
      if (!who.value) return;
      api('POST', '/api/shares', { loc, path, user: who.value, write: canEdit.checked }).then(load, fail);
    }, 'primary');
    add.disabled = !others.length;

    const lrows = it.links.map(l => {
      const url = absUrl(l.url);
      const expired = l.expires && l.expires * 1000 < Date.now();
      return h('tr', {}, h('td', { class: 'url' }, h('a', { href: url, target: '_blank', rel: 'noopener', text: url })),
        h('td', { class: expired ? 'bad' : 'dim', text: l.expires ? (expired ? 'expired ' : 'until ') + fmtDate(l.expires) : 'no expiry' }),
        h('td', { class: 'dim', text: l.hits + ' opened' }),
        h('td', { class: 'act' }, btn('copy', null, () => copyText(url).then(ok => toast(ok ? 'copied' : 'copy failed', ok ? '' : 'err'))),
          btn('remove', 'the link stops working', () => api('DELETE', '/api/links/' + l.id).then(load, fail))));
    });
    const days = h('input', { type: 'number', min: 1, max: 3650, placeholder: 'never', class: 'num' });
    const mk = btn('create link', null, async () => {
      try {
        const r = await api('POST', '/api/links', { loc, path, days: days.value ? +days.value : null });
        const ok = await copyText(absUrl(r.url));
        toast(ok ? 'link created and copied' : 'link created');
        load();
      } catch (e) { fail(e); }
    }, 'primary');

    box.replaceChildren(
      h('div', { class: 'lbl', text: 'users of this server' }),
      urows.length ? h('table', { class: 'x11' }, h('tbody', {}, urows)) : h('div', { class: 'dim', text: 'not shared with anyone' }),
      h('div', { class: 'row' }, who, h('label', { class: 'chk' }, canEdit, ' can edit'), add),
      h('div', { class: 'lbl gap', text: 'links: anyone with the link can open it, no login' }),
      lrows.length ? h('table', { class: 'x11' }, h('tbody', {}, lrows)) : h('div', { class: 'dim', text: 'no links' }),
      h('div', { class: 'row' }, h('span', { class: 'dim', text: 'expires after' }), days, h('span', { class: 'dim', text: 'days' }), mk));
    if (!it.dir) return;

    const krows = keyRows(allKeys.filter(k => k.loc === loc && k.path === it.path), load, false);
    const kname = h('input', { type: 'text', placeholder: 'what uses it, e.g. backup script', maxlength: 60 });
    const kwrite = h('input', { type: 'checkbox' });
    const kdays = h('input', { type: 'number', min: 1, max: 3650, placeholder: 'never', class: 'num' });
    const mkKey = btn('create key', null, async () => {
      try {
        const r = await api('POST', '/api/keys', { loc, path, name: kname.value, write: kwrite.checked, days: kdays.value ? +kdays.value : null });
        kname.value = kdays.value = '';
        await keyShown(r);
        load();
      } catch (e) { fail(e); }
    }, 'primary');
    box.append(
      h('div', { class: 'lbl gap', text: 'API keys: a program with the key can use this folder and what is in it, nothing else' }),
      krows.length ? h('table', { class: 'x11' }, h('tbody', {}, krows)) : h('div', { class: 'dim', text: 'no keys' }),
      h('div', { class: 'row' }, kname, h('label', { class: 'chk' }, kwrite, ' can edit'),
        h('span', { class: 'dim', text: 'expires after' }), kdays, h('span', { class: 'dim', text: 'days' }), mkKey));
  }
  return dialog({
    title: 'share ' + name, wide: true, body: box,
    buttons: [{ label: 'close', value: true, primary: true }],
    opened: () => load().catch(e => box.replaceChildren(h('div', { class: 'bad', text: e.message }))),
  });
}

/* ---- uploads: a queue that outlives page changes ---- */
const UP = { items: [], running: 0, win: null, list: null, ask: Promise.resolve() };

function hasFiles(e) { return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'); }

/* files and folders from a drop, as [{file, rel}] */
async function droppedFiles(dt) {
  // entries have to be taken before the first await
  const entries = Array.from(dt.items || []).filter(i => i.kind === 'file').map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return Array.from(dt.files).map(f => ({ file: f, rel: f.name }));
  const out = [];
  async function walk(en, prefix) {
    if (en.isFile) {
      out.push({ file: await new Promise((res, rej) => en.file(res, rej)), rel: prefix + en.name });
    } else if (en.isDirectory) {
      const rd = en.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => rd.readEntries(res, rej));
        if (!batch.length) break;
        for (const c of batch) await walk(c, prefix + en.name + '/');
      }
    }
  }
  for (const en of entries) await walk(en, '');
  return out;
}

function upload(loc, dir, files) {
  if (!files.length) return;
  if (!UP.win) {
    UP.list = h('div', { class: 'up-list' });
    UP.title = h('span');
    UP.win = h('div', { class: 'win uploads' },
      h('div', { class: 'titlebar' }, h('span', { class: 'grip', text: '::' }), UP.title, h('span', { class: 'spacer' }),
        btn('clear', 'remove finished', () => { UP.items = UP.items.filter(i => { if (i.state === 'done' || i.state === 'skip' || i.state === 'err') { i.row.remove(); return false; } return true; }); upTitle(); }),
        btn('x', 'hide (uploads go on)', () => { UP.win.hidden = true; })),
      UP.list);
    document.body.appendChild(UP.win);
  }
  UP.win.hidden = false;
  const batch = { policy: null };
  for (const f of files) {
    const it = { loc, path: joinPath(dir, f.rel), file: f.file, mk: f.rel.includes('/'), batch, state: 'wait' };
    it.bar = h('i');
    it.st = h('span', { class: 'up-st dim', text: 'waiting' });
    it.x = btn('x', 'cancel', () => cancelUp(it));
    it.row = h('div', { class: 'up-row' }, h('span', { class: 'up-name', text: f.rel, title: it.path }), h('span', { class: 'up-bar' }, it.bar), it.st, it.x);
    UP.list.appendChild(it.row);
    UP.items.push(it);
  }
  upTitle();
  pump();
}

function upTitle() {
  const left = UP.items.filter(i => i.state === 'wait' || i.state === 'up').length;
  UP.title.textContent = left ? 'uploading, ' + left + ' left' : 'uploads done';
  const el = $('#up-status');
  if (el) el.textContent = left ? 'upload: ' + left + ' left' : '';
}

function pump() {
  while (UP.running < 2) {
    const it = UP.items.find(i => i.state === 'wait');
    if (!it) break;
    sendUp(it, false);
  }
  upTitle();
}

function cancelUp(it) {
  if (it.state === 'up' && it.xhr) it.xhr.abort();
  else if (it.state === 'wait') { it.state = 'skip'; it.st.textContent = 'cancelled'; it.x.hidden = true; upTitle(); }
}

function xput(url, body, progress) {
  const x = new XMLHttpRequest();
  const p = new Promise((res, rej) => {
    x.open('PUT', url);
    x.setRequestHeader('x-shelf', '1');
    x.upload.onprogress = e => progress(e.loaded, e.total || body.size);
    x.onload = () => { let j = null; try { j = JSON.parse(x.responseText); } catch (e) { /* none */ } res({ status: x.status, json: j }); };
    x.onerror = () => rej(new Error('network error'));
    x.onabort = () => rej(new Error('cancelled'));
    x.send(body);
  });
  return { x, p };
}

async function sendUp(it, replace) {
  UP.running++;
  it.state = 'up';
  it.st.textContent = '0%';
  const q = [];
  if (!replace) q.push('mode=new');
  if (it.mk) q.push('mkdirs=1');
  const { x, p } = xput(U.raw(it.loc, it.path) + (q.length ? '?' + q.join('&') : ''), it.file, (a, b) => {
    const pc = b ? Math.floor(a * 100 / b) : 100;
    it.bar.style.width = pc + '%';
    it.st.textContent = pc + '%';
  });
  it.xhr = x;
  let r = null, err = null;
  try { r = await p; } catch (e) { err = e.message; }
  UP.running--;
  if (r && r.status === 409 && !replace) {
    it.state = 'ask';
    it.st.textContent = 'exists';
    const how = await conflict(it);
    if (how === 'replace') { sendUp(it, true); return; }
    it.state = 'skip';
    it.st.textContent = 'skipped';
  } else if (r && r.status >= 200 && r.status < 300) {
    it.state = 'done';
    it.bar.style.width = '100%';
    it.st.textContent = 'done';
    it.st.className = 'up-st ok';
    if (S.page && S.page.onUploaded) S.page.onUploaded(it.loc, it.path);
  } else {
    it.state = 'err';
    it.st.textContent = err || (r.json && r.json.error) || ('error ' + r.status);
    it.st.className = 'up-st bad';
    if (r && r.status === 401 && window.onUnauthorized) window.onUnauthorized();
  }
  it.x.hidden = true;
  pump();
}

/* one question at a time; "all" answers the rest of the batch */
function conflict(it) {
  UP.ask = UP.ask.then(async () => {
    if (it.batch.policy) return it.batch.policy;
    const v = await dialog({
      title: 'already there', body: h('div', { class: 'dlg-text', text: it.path + ' exists.' }),
      buttons: [{ label: 'skip', value: 'skip' }, { label: 'skip all', value: 'skip-all' },
        { label: 'replace all', value: 'replace-all', danger: true }, { label: 'replace', value: 'replace', primary: true, danger: true }],
    });
    if (v === 'skip-all' || v === 'replace-all') { it.batch.policy = v.split('-')[0]; return it.batch.policy; }
    return v || 'skip';
  });
  return UP.ask;
}

/* ---- viewing a file ---- */
async function viewPage(loc, path) {
  const ls = await api('GET', U.ls(loc, path));
  if (!ls.file) return { redirect: U.files(loc, path) };
  const name = ls.file.name, dir = parentPath(path), inFolder = splitPath(path).length > 0;
  let siblings = null;
  if (inFolder) {
    try { siblings = (await api('GET', U.ls(loc, dir))).entries.filter(e => !e.dir).map(e => e.name); } catch (e) { /* no prev / next */ }
  }
  const v = viewer({
    name, raw: U.raw(loc, path), siblings,
    rawOf: n => U.raw(loc, joinPath(dir, n)),
    md: async () => {
      const r = await fetchText(U.raw(loc, path), TEXT_MAX);
      const res = await api('POST', '/api/md', { text: r.text, img_base: '/api/raw/' + loc + encP(dir) + '/', link_base: '/view/' + loc + encP(dir) + '/' });
      return res.html;
    },
  });
  const go = n => { if (n) navigate(U.view(loc, joinPath(dir, n)), true); };
  const back = inFolder ? U.files(loc, dir) : '/shared';
  const canEdit = ls.write && editorOf(name), toOds = ls.write && kindOf(name) === 'sheet' && !canEdit;
  let nav = null;
  if (v.prev || v.next) {
    const p = btn('< prev', 'previous (left arrow)', () => go(v.prev)), n = btn('next >', 'next (right arrow)', () => go(v.next));
    p.disabled = !v.prev;
    n.disabled = !v.next;
    nav = [p, n];
  }
  const el = h('section', { class: 'win viewwin' },
    h('div', { class: 'titlebar' }, h('span', { class: 'grip', text: '::' }),
      inFolder ? crumbs(loc, ls.root_name, path, false) : h('span', { class: 'crumbs' }, h('span', { class: 'here', text: name })),
      h('span', { class: 'spacer' }), nav,
      canEdit ? btn('edit', 'edit (e)', () => navigate(U.edit(loc, path))) : null,
      toOds ? btn('edit as .ods', 'spreadsheets are edited as .ods: make one from this next to it, and edit that', () => editAsOds(loc, path, name).catch(fail)) : null,
      h('a', { class: 'btn-link', href: U.raw(loc, path) + '?dl=1', download: '', text: 'download' }),
      h('a', { class: 'btn-link', href: back, text: 'close', title: 'close (esc)' })),
    v.el);
  return {
    el, cls: 'fill', title: name,
    status: fmtSize(ls.file.size) + ', modified ' + fmtTime(ls.file.mtime),
    destroy: () => v.destroy(),
    key: e => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return false;
      const media = e.target instanceof HTMLMediaElement;
      if (e.key === 'ArrowLeft' && !media && v.prev) { go(v.prev); return true; }
      if (e.key === 'ArrowRight' && !media && v.next) { go(v.next); return true; }
      if (e.key === 'Escape') { navigate(back); return true; }
      if (e.key === 'e' && canEdit) { navigate(U.edit(loc, path)); return true; }
      return false;
    },
  };
}

/* an xlsx is shown, not edited: an .ods made from it is */
async function editAsOds(loc, path, name) {
  const to = joinPath(parentPath(path), stem(name) + '.ods'), url = U.raw(loc, to);
  const { bytes } = await fetchBytes(U.raw(loc, path), SHEET_MAX);
  const book = await XlsxBook.open(bytes), out = await OdsOut.write(book, new Calc(book));
  try {
    await putRaw(url + '?mode=new', out);
  } catch (e) {
    if (e.status !== 409) throw e;
    const v = await dialog({
      title: 'already there', body: h('div', { class: 'dlg-text', text: stem(name) + '.ods exists.' }),
      buttons: [{ label: 'cancel', value: null }, { label: 'replace it', value: 'replace', danger: true }, { label: 'edit that one', value: 'open', primary: true }],
    });
    if (!v) return;
    if (v === 'replace') await putRaw(url, out);
  }
  navigate(U.edit(loc, to));
}

/* ---- metaplace: every picture, newest first, and a slideshow through them ---- */
const PIC_SRC = { e: 'exif', n: 'from the name', f: 'from the folder', m: 'file time' };
function thumbUrl(p, screen) { return '/api/thumb/' + p.loc + encP(p.path) + '?v=' + p.mtime + (screen ? '&s=screen' : ''); }
/* `taken` is the wall-clock time written as if it were UTC */
function picMonth(p) { const d = new Date(p.taken * 1000); return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1); }
function picDate(p) {
  const d = new Date(p.taken * 1000), day = picMonth(p) + '-' + pad2(d.getUTCDate());
  // a folder or a name without a time gives only the day
  return p.src === 'f' || (p.src === 'n' && p.taken % 86400 === 0) ? day : day + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
}

async function picturesPage() {
  const [r, places] = await Promise.all([api('GET', '/api/pictures'), loadPlaces().catch(() => null)]);
  const pics = r.items.map(([d, name, taken, mtime, src, links]) => {
    const [loc, dir, write] = r.dirs[d];
    // dir is null for a single shared picture: the share is the file; links: other names keep a deleted one
    return { loc, dir, write, name, taken, mtime, src, links: links || 1, path: dir === null ? '/' : joinPath(dir, name) };
  });
  const shareName = loc => { const s = places && places.shares.find(x => x.loc === loc); return s ? s.name : 'shared'; };

  const wrap = h('div', { class: 'picwrap', tabindex: '0' });
  const tiles = [];
  const years = h('select', { title: 'jump to a year', onchange: () => {
    const hd = wrap.querySelector('[data-y="' + years.value + '"]');
    if (hd) wrap.scrollTop = hd.nextSibling.offsetTop - hd.offsetHeight;
    years.value = '';
    wrap.focus();
  } }, h('option', { value: '', text: 'year' }));
  for (let i = 0; i < pics.length;) {
    const m = picMonth(pics[i]);
    let j = i;
    while (j < pics.length && picMonth(pics[j]) === m) j++;
    const y = m.slice(0, 4), first = !years.querySelector('option[value="' + y + '"]');
    if (first) years.appendChild(h('option', { value: y, text: y }));
    const grid = h('div', { class: 'pic-grid' });
    for (let k = i; k < j; k++) {
      const p = pics[k];
      const t = h('a', { class: 'pic', href: U.view(p.loc, p.path), title: p.name + '\n' + picDate(p), 'data-i': String(k) });
      tiles.push(t);
      grid.appendChild(t);
    }
    wrap.append(h('div', { class: 'pic-month', 'data-y': first ? y : null }, m, h('span', { class: 'dim', text: ' ' + (j - i) })), grid);
    i = j;
  }
  if (!pics.length) wrap.appendChild(h('div', { class: 'empty dim', text: r.scanning ? 'looking for pictures; reload in a while' : 'no pictures here yet' }));

  // thumbnails once the scrolling stops, so a fast scroll does not fetch all it passes
  const want = new Set();
  let lazy = 0;
  const io = new IntersectionObserver(es => {
    for (const e of es) { if (e.isIntersecting) want.add(e.target); else want.delete(e.target); }
    clearTimeout(lazy);
    lazy = setTimeout(() => { want.forEach(fill); want.clear(); }, 120);
  }, { root: wrap, rootMargin: '400px 0px' });
  tiles.forEach(t => io.observe(t));
  function fill(t) {
    io.unobserve(t);
    const p = pics[+t.dataset.i];
    const img = h('img', { alt: '', decoding: 'async' });
    img.onerror = () => {
      // one the server cannot shrink (avif …) may still show as itself
      if (!img.dataset.again && !/^jpe?g$/.test(extOf(p.name))) { img.dataset.again = '1'; img.src = thumbUrl(p, true); return; }
      img.remove();
      t.classList.add('broken');
      t.textContent = p.name;
    };
    img.src = thumbUrl(p);
    t.appendChild(img);
  }

  // the slideshow takes one history step, so "back" closes it; #<n> is the picture
  let pushed = false;
  const slides = slideshow(pics, shareName, {
    moved: n => history.replaceState(null, '', '/pictures#' + n),
    close: () => { if (pushed) history.back(); else { history.replaceState(null, '', '/pictures'); hide(); } },
    renamed: p => {
      const t = tiles[pics.indexOf(p)];
      t.href = U.view(p.loc, p.path);
      t.title = p.name + '\n' + picDate(p);
      if (t.classList.contains('broken')) t.textContent = p.name;
    },
    removed: p => {
      const i = pics.indexOf(p), t = tiles[i], grid = t.parentNode, hd = grid.previousSibling;
      pics.splice(i, 1);
      tiles.splice(i, 1);
      io.unobserve(t);
      want.delete(t);
      t.remove();
      for (let k = i; k < tiles.length; k++) tiles[k].dataset.i = String(k);
      lbl.textContent = pics.length + ' pictures';
      if (grid.children.length) { hd.lastChild.textContent = ' ' + grid.children.length; return; }
      // the month is gone; the year's jump moves to its next month, if it has one
      const y = hd.dataset.y, nx = grid.nextSibling;
      if (y && nx && nx.firstChild.textContent.startsWith(y)) nx.dataset.y = y;
      else if (y) years.querySelector('option[value="' + y + '"]').remove();
      hd.remove();
      grid.remove();
      if (!pics.length) wrap.appendChild(h('div', { class: 'empty dim', text: 'no pictures here yet' }));
    },
  });
  const inHash = () => { const m = /^#(\d+)$/.exec(location.hash); return m && pics.length ? Math.min(+m[1], pics.length - 1) : null; };
  function open(n) {
    history.pushState(null, '', '/pictures#' + n);
    pushed = true;
    slides.show(n);
  }
  function hide() {
    const n = slides.hide();
    pushed = false;
    if (tiles[n]) tiles[n].scrollIntoView({ block: 'center' });
    wrap.focus();
  }
  wrap.addEventListener('click', e => {
    const t = e.target.closest('a.pic');
    if (!t || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    open(+t.dataset.i);
  });

  const scan = r.scanning ? h('div', { class: 'note dim', text: 'still looking for pictures' +
    (r.scanning.total ? ' (' + r.scanning.done + ' of ' + r.scanning.total + ')' : '') + '; reload in a while for the rest' }) : null;
  const lbl = h('span', { class: 'lbl', text: pics.length + ' pictures' });
  const bar = h('div', { class: 'toolbar' }, lbl, pics.length ? years : null,
    h('span', { class: 'spacer' }), pics.length ? btn('slideshow', 'from the newest, playing', () => { open(0); slides.play(true); }) : null);
  const pw = h('section', { class: 'win picwin' },
    h('div', { class: 'titlebar' }, h('span', { class: 'grip', text: '::' }), h('span', { class: 'crumbs' }, h('span', { class: 'here', text: 'pictures' }))),
    bar, scan, wrap, slides.el);
  const range = pics.length ? ', ' + picMonth(pics[pics.length - 1]) + ' to ' + picMonth(pics[0]) : '';
  return {
    el: h('div', { class: 'files-layout' }, placesBox(places, 'pictures'), pw), cls: 'fill', title: 'pictures',
    status: pics.length + ' pictures' + range + '; dates from exif, else the file name, the folder or the file time',
    shown: () => { const n = inHash(); if (n !== null) slides.show(n); else wrap.focus(); },
    pop: () => {
      if (location.pathname !== '/pictures') return false;
      const n = inHash();
      if (n === null) hide(); else slides.show(n);
      return true;
    },
    key: e => slides.open() ? slides.key(e) : false,
    destroy: () => { io.disconnect(); clearTimeout(lazy); slides.hide(); },
  };
}

/* full-window pictures, one at a time: arrows, swipes, space plays; on wide screens
   the picture can be renamed, moved, shared and deleted */
function slideshow(pics, shareName, on) {
  let cur = -1, playing = false, timer = 0;
  let img = h('img', { class: 'slide-img', alt: '' });
  const msg = h('div', { class: 'slide-msg dim', hidden: true });
  const count = h('span', { class: 'slide-count' });
  const date = h('span', { class: 'slide-date' });
  const name = h('a', { class: 'slide-name', title: 'open in the viewer' });
  const folder = h('a', { class: 'slide-dir dim', title: 'the folder' });
  const dl = h('a', { class: 'btn-link', download: '', text: 'download' });
  const playB = btn('play', 'play / pause (space)', () => play(!playing));
  const bRen = btn('rename', 'rename (f2)', () => act(rename), 'slide-act');
  const bMove = btn('move', 'move to another folder', () => act(move), 'slide-act');
  const bShare = btn('share', 'share with users or by link', () => act(p => shareDialog(p.loc, p.path, p.name)), 'slide-act');
  const bDel = btn('delete', 'delete (del)', () => act(remove), 'slide-act danger');
  const stage = h('div', { class: 'slide-stage' }, img, msg,
    h('button', { class: 'slide-go prev', text: '<', title: 'previous (left arrow)', onclick: () => go(cur - 1) }),
    h('button', { class: 'slide-go next', text: '>', title: 'next (right arrow)', onclick: () => go(cur + 1) }));
  const el = h('div', { class: 'slides', hidden: true },
    h('div', { class: 'slide-bar' }, count, date, name, folder, h('span', { class: 'spacer' }), playB,
      bRen, bMove, bShare, bDel, dl, btn('close', 'close (esc)', () => on.close())),
    stage);

  let sx = null, sy = 0;
  stage.addEventListener('pointerdown', e => { sx = e.clientX; sy = e.clientY; });
  stage.addEventListener('pointerup', e => {
    if (sx === null) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    sx = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) go(cur + (dx < 0 ? 1 : -1));
  });
  stage.addEventListener('pointercancel', () => { sx = null; });
  stage.addEventListener('dragstart', e => e.preventDefault());

  // while playing: the next picture `ms` after this one is up
  function later(ms) {
    clearTimeout(timer);
    if (playing) timer = setTimeout(() => { if (!go(cur + 1)) play(false); }, ms);
  }

  function show(n) {
    if (n < 0 || n >= pics.length) return false;
    el.hidden = false;
    cur = n;
    const p = pics[n];
    count.textContent = (n + 1) + ' / ' + pics.length;
    date.textContent = picDate(p) + ' (' + PIC_SRC[p.src] + ')';
    name.textContent = p.name;
    name.href = U.view(p.loc, p.path);
    folder.textContent = p.dir === null ? shareName(p.loc) : (p.loc === 'home' ? '' : shareName(p.loc)) + p.dir;
    folder.href = p.dir === null ? '/shared' : U.files(p.loc, p.dir);
    dl.href = U.raw(p.loc, p.path) + '?dl=1';
    // a shared file is the root of its share; only the owner shares
    bRen.disabled = bMove.disabled = bDel.disabled = !p.write || p.dir === null;
    bShare.disabled = p.loc !== 'home';
    clearTimeout(timer);
    // swapped in once loaded: the last picture stays up meanwhile
    const next = h('img', { class: 'slide-img', alt: '' });
    next.onload = () => {
      if (cur !== n) return;
      img.replaceWith(next);
      img = next;
      msg.hidden = true;
      later(4000);
    };
    next.onerror = () => {
      if (cur !== n) return;
      img.removeAttribute('src');
      msg.textContent = 'cannot show ' + p.name;
      msg.hidden = false;
      later(1000);
    };
    next.src = thumbUrl(p, true);
    for (const k of [n + 1, n + 2, n - 1]) if (pics[k]) new Image().src = thumbUrl(pics[k], true);
    return true;
  }
  function go(n) {
    if (!show(n)) return false;
    on.moved(n);
    return true;
  }
  function play(yes) {
    playing = yes;
    playB.textContent = yes ? 'pause' : 'play';
    playB.classList.toggle('on', yes);
    later(4000);
  }

  /* the show pauses for the dialog */
  function act(f) {
    if (!pics[cur]) return;
    play(false);
    f(pics[cur]).catch(fail);
  }
  async function rename(p) {
    const nn = await dialogAsk('rename', 'new name', p.name, 'rename', async v => {
      const bad = checkName(v);
      if (bad) return bad;
      if (v === p.name) return null;
      await api('POST', '/api/mv', { loc: p.loc, moves: [{ from: p.path, to: joinPath(p.dir, v) }] });
    });
    if (nn && nn !== p.name) changed(p, p.dir, nn);
  }
  async function move(p) {
    const dest = await pickFolder(p.loc, p.dir, 'move ' + p.name, []);
    if (dest === null || dest === p.dir) return;
    await api('POST', '/api/mv', { loc: p.loc, moves: [{ from: p.path, to: joinPath(dest, p.name) }] });
    toast('moved to ' + dest);
    changed(p, dest, p.name);
  }
  function changed(p, dir, nn) {
    p.dir = dir;
    p.name = nn;
    p.path = joinPath(dir, nn);
    on.renamed(p);
    if (pics[cur] === p) show(cur);
  }
  async function remove(p) {
    const also = p.links > 1 ? ' the same file is also at ' + (p.links > 2 ? p.links - 1 + ' other places' : 'another place') +
      ' (hard links), which keep it.' : '';
    if (!(await confirmBox('delete', 'delete ' + p.name + '? this cannot be undone.' + also, 'delete', true))) return;
    await api('POST', '/api/rm', { loc: p.loc, paths: [p.path] });
    const n = pics.indexOf(p);
    on.removed(p);
    if (!pics.length) on.close();
    else go(Math.min(n, pics.length - 1));
  }
  return {
    el, show, play,
    open: () => !el.hidden,
    /* closes; the index of the last picture shown */
    hide: () => {
      play(false);
      el.hidden = true;
      const n = cur;
      cur = -1;
      return n;
    },
    key: e => {
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      if (e.target instanceof HTMLButtonElement && (e.key === ' ' || e.key === 'Enter')) return false;
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(cur - 1);
      else if (e.key === 'ArrowRight' || e.key === 'PageDown') go(cur + 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(pics.length - 1);
      else if (e.key === ' ') play(!playing);
      else if (e.key === 'Escape') on.close();
      else if (e.key === 'F2' && !bRen.disabled) act(rename);
      else if (e.key === 'Delete' && !bDel.disabled) act(remove);
      else return false;
      return true;
    },
  };
}

/* ---- text encodings: UTF-8, else a single-byte legacy one, kept on save ---- */
const LEGACY = ['windows-1250', 'windows-1252', 'windows-1251', 'iso-8859-2', 'iso-8859-15', 'ibm852', 'koi8-r', 'macintosh'];
function guessLegacy() {
  const l = (navigator.language || '').slice(0, 2).toLowerCase();
  if (['cs', 'sk', 'pl', 'hu', 'sl', 'hr', 'ro', 'bs'].includes(l)) return 'windows-1250';
  if (['ru', 'uk', 'bg', 'be', 'mk', 'sr'].includes(l)) return 'windows-1251';
  return 'windows-1252';
}
function decodeBytes(bytes, enc) {
  if (!enc) {
    try { return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), enc: 'utf-8' }; } catch (e) { enc = guessLegacy(); }
  }
  return { text: new TextDecoder(enc, { ignoreBOM: true }).decode(bytes), enc };
}
const encMaps = {};
function encodeText(s, enc) {
  if (enc === 'utf-8') return { bytes: new TextEncoder().encode(s), lost: 0 };
  let m = encMaps[enc];
  if (!m) {
    const d = new TextDecoder(enc);
    m = encMaps[enc] = new Map();
    for (let b = 255; b >= 0; b--) { const c = d.decode(new Uint8Array([b])); if (c.length === 1 && c !== '�') m.set(c, b); }
  }
  const out = [];
  let lost = 0;
  for (const ch of s) {
    const b = m.get(ch);
    if (b === undefined) { out.push(63); lost++; } else out.push(b);
  }
  return { bytes: new Uint8Array(out), lost };
}

async function fetchBytes(url, max) {
  const r = await fetch(url, { credentials: 'same-origin', cache: 'no-cache' });
  if (!r.ok) {
    if (r.status === 401 && window.onUnauthorized) window.onUnauthorized();
    throw new Error(r.status + ' ' + r.statusText);
  }
  const b = new Uint8Array(await r.arrayBuffer());
  if (b.length > max) throw new Error('too big to edit here (over ' + fmtSize(max) + ')');
  return { bytes: b, etag: r.headers.get('etag') };
}

/* ---- text / markdown editor ---- */
function taReplace(ta, from, to, text, s0, s1) {
  ta.focus();
  ta.setSelectionRange(from, to);
  if (!document.execCommand('insertText', false, text)) {   // keeps the browser's undo; the fallback does not
    ta.setRangeText(text, from, to, 'end');
    ta.dispatchEvent(new Event('input'));
  }
  ta.setSelectionRange(s0, s1);
}
function lineRange(ta) {
  const v = ta.value;
  const s = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
  let endAt = ta.selectionEnd;
  if (endAt > ta.selectionStart && v[endAt - 1] === '\n') endAt--;   // whole lines selected: not the next one
  let e = v.indexOf('\n', endAt);
  if (e < 0) e = v.length;
  return [s, e];
}
function mdWrap(ta, a, b, ph) {
  const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
  if (v.slice(s - a.length, s) === a && v.slice(e, e + b.length) === b) {   // already wrapped: unwrap
    taReplace(ta, s - a.length, e + b.length, v.slice(s, e), s - a.length, e - a.length);
    return;
  }
  const t = v.slice(s, e) || ph;
  taReplace(ta, s, e, a + t + b, s + a.length, s + a.length + t.length);
}
function mdLines(ta, prefix, strip, numbered) {
  const [s, e] = lineRange(ta);
  const lines = ta.value.slice(s, e).split('\n');
  const all = !numbered && lines.every(l => l.startsWith(prefix));
  const out = lines.map((l, i) => all ? l.slice(prefix.length)
    : (numbered ? (i + 1) + '. ' : prefix) + (strip ? l.replace(strip, '') : l)).join('\n');
  taReplace(ta, s, e, out, s, s + out.length);
}
function mdInsert(ta, text) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  taReplace(ta, s, e, text, s + text.length, s + text.length);
}
const LIST_RE = /^([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/;
const MD_TOOLS = [
  ['b', 'bold (ctrl+b)', ta => mdWrap(ta, '**', '**', 'bold')],
  ['i', 'italic (ctrl+i)', ta => mdWrap(ta, '*', '*', 'italic')],
  ['s', 'strike through', ta => mdWrap(ta, '~~', '~~', 'text')],
  ['code', 'code', ta => (ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n') ? mdWrap(ta, '```\n', '\n```', 'code') : mdWrap(ta, '`', '`', 'code'))],
  null,
  ['h1', 'heading 1', ta => mdLines(ta, '# ', /^#{1,6}\s+/)],
  ['h2', 'heading 2', ta => mdLines(ta, '## ', /^#{1,6}\s+/)],
  ['h3', 'heading 3', ta => mdLines(ta, '### ', /^#{1,6}\s+/)],
  ['quote', 'quote', ta => mdLines(ta, '> ')],
  null,
  ['• list', 'bullet list', ta => mdLines(ta, '- ', LIST_RE)],
  ['1. list', 'numbered list', ta => mdLines(ta, '', LIST_RE, true)],
  ['[ ] task', 'task list', ta => mdLines(ta, '- [ ] ', LIST_RE)],
  null,
  ['link', 'link (ctrl+k)', ta => mdWrap(ta, '[', '](https://)', 'text')],
  ['image', 'image: a relative path shows a file from this folder', ta => mdWrap(ta, '![', '](picture.png)', 'description')],
  ['table', 'table', ta => mdInsert(ta, '\n| column | column |\n| ------ | ------ |\n| cell   | cell   |\n')],
  ['rule', 'horizontal rule', ta => mdInsert(ta, '\n---\n')],
];

class TextEditor {
  constructor(host, text, opts) {
    this.opts = opts;
    this.md = !!opts.md;
    this.eol = text.includes('\r\n') ? '\r\n' : '\n';
    text = text.replace(/\r\n/g, '\n');
    this.ta = h('textarea', { class: 'src', spellcheck: this.md, autocapitalize: 'off' });
    this.ta.value = text;
    this.saved = this.ta.value;
    this.wasDirty = false;
    this.ta.addEventListener('input', () => { this.changed(); if (this.md) this.preview(); });
    this.ta.addEventListener('keydown', e => this.keys(e));
    const st = () => { cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(() => this.status()); };
    this.ta.addEventListener('keyup', st);
    this.ta.addEventListener('click', st);
    const wrapOn = localStorage.getItem('shelf.wrap') !== '0';
    this.ta.classList.toggle('nowrap', !wrapOn);
    const wrapBox = h('input', { type: 'checkbox', checked: wrapOn });
    wrapBox.addEventListener('change', () => { this.ta.classList.toggle('nowrap', !wrapBox.checked); localStorage.setItem('shelf.wrap', wrapBox.checked ? '1' : '0'); });
    const tools = [];
    if (this.md) {
      for (const t of MD_TOOLS) {
        if (!t) { tools.push(h('span', { class: 'sep' })); continue; }
        const b = h('button', { text: t[0], title: t[1] });
        b.addEventListener('mousedown', e => e.preventDefault());
        b.addEventListener('click', () => t[2](this.ta));
        tools.push(b);
      }
      this.mode = localStorage.getItem('shelf.mdmode') || (innerWidth > 900 ? 'split' : 'edit');
      this.modeBtns = ['edit', 'split', 'preview'].map(m => btn(m, null, () => this.setMode(m)));
      tools.push(h('span', { class: 'spacer' }), h('span', { class: 'seg' }, this.modeBtns));
    } else tools.push(h('span', { class: 'spacer' }));
    tools.push(h('label', { class: 'chk', title: 'wrap long lines' }, wrapBox, ' wrap'));
    this.prev = h('div', { class: 'md-body md-preview' });
    this.split = h('div', { class: 'md-split' }, this.ta, this.md ? this.prev : null);
    this.ta.addEventListener('scroll', () => {
      if (!this.md || this.mode !== 'split') return;
      const r = this.ta.scrollTop / Math.max(1, this.ta.scrollHeight - this.ta.clientHeight);
      this.prev.scrollTop = r * (this.prev.scrollHeight - this.prev.clientHeight);
    });
    clear(host).append(h('div', { class: 'toolbar' }, tools), this.split);
    if (this.md) { this.setMode(this.mode); this.preview(true); }
  }

  setMode(m) {
    this.mode = m;
    localStorage.setItem('shelf.mdmode', m);
    this.split.className = 'md-split mode-' + m;
    this.modeBtns.forEach(b => b.classList.toggle('on', b.textContent === m));
    if (m !== 'preview') this.ta.focus();
  }

  preview(now) {
    clearTimeout(this.pt);
    this.pt = setTimeout(async () => {
      try {
        const r = await api('POST', '/api/md', { text: this.ta.value, img_base: this.opts.imgBase, link_base: this.opts.linkBase });
        this.prev.innerHTML = r.html;
      } catch (e) { /* keep the last preview */ }
    }, now ? 0 : 250);
  }

  keys(e) {
    const ta = this.ta, mod = e.ctrlKey || e.metaKey;
    if (this.md && mod && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); mdWrap(ta, '**', '**', 'bold'); return; }
      if (k === 'i') { e.preventDefault(); mdWrap(ta, '*', '*', 'italic'); return; }
      if (k === 'k') { e.preventDefault(); mdWrap(ta, '[', '](https://)', 'text'); return; }
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      const ind = this.md ? '  ' : '\t';
      const multi = ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n');
      if (e.shiftKey || multi) {
        const [s, en] = lineRange(ta);
        const out = ta.value.slice(s, en).split('\n').map(l => (e.shiftKey ? l.replace(this.md ? /^ {1,2}/ : /^\t/, '') : ind + l)).join('\n');
        taReplace(ta, s, en, out, s, s + out.length);
      } else mdInsert(ta, ind);
      return;
    }
    // markdown lists go on with Enter; Enter on an empty item ends the list
    if (this.md && e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey && ta.selectionStart === ta.selectionEnd) {
      const v = ta.value, p = ta.selectionStart, ls = v.lastIndexOf('\n', p - 1) + 1, line = v.slice(ls, p);
      const m = /^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)([.)]) |> )/.exec(line);
      if (!m) return;
      e.preventDefault();
      if (line.length === m[0].length) { taReplace(ta, ls, p, '', ls, ls); return; }
      let mk = m[2];
      if (m[3]) mk = (+m[3] + 1) + m[4] + ' ';
      else mk = mk.replace(/\[[xX]\]/, '[ ]');
      const ins = '\n' + m[1] + mk;
      taReplace(ta, p, p, ins, p + ins.length, p + ins.length);
    }
  }

  get dirty() { return this.ta.value !== this.saved; }
  changed() {
    const d = this.dirty;
    if (d !== this.wasDirty) { this.wasDirty = d; this.opts.onChange(d); }
  }
  markSaved(text) { this.saved = text; this.changed(); }
  text() { return this.eol === '\n' ? this.ta.value : this.ta.value.replace(/\n/g, '\r\n'); }
  status() {
    const v = this.ta.value, p = this.ta.selectionStart;
    let line = 1;
    for (let i = v.indexOf('\n'); i >= 0 && i < p; i = v.indexOf('\n', i + 1)) line++;
    const col = p - v.lastIndexOf('\n', p - 1);
    this.opts.onStatus('line ' + line + ', col ' + col + ' | ' + v.length + ' chars' + (this.eol === '\r\n' ? ' | crlf' : ''));
  }
  focus() { if (!this.md || this.mode !== 'preview') this.ta.focus(); }
  destroy() { clearTimeout(this.pt); }
}

/* ---- the edit page: md / text / csv / rtf, saved with If-Match ---- */
async function editPage(loc, path) {
  const ls = await api('GET', U.ls(loc, path));
  if (!ls.file) return { redirect: U.files(loc, path) };
  const name = ls.file.name, kind = editorOf(name), dir = parentPath(path);
  if (!kind) return { redirect: U.view(loc, path) };
  if (!ls.write) return { redirect: U.view(loc, path) };
  if (kind === 'sheet') return sheetPage(loc, path, ls);
  const max = kind === 'md' || kind === 'text' ? 8 << 20 : 32 << 20;
  let { bytes, etag } = await fetchBytes(U.raw(loc, path), max);

  const host = h('div', { class: 'edit-host edit-' + kind });
  const mark = h('span', { class: 'dirty', text: '' });
  const saveBtn = btn('save', 'save (ctrl+s)', () => save(), 'primary');
  const encSel = h('select', { title: 'text encoding of the file' });
  const note = h('div', { class: 'note warn', hidden: true });
  let ed = null, enc = 'utf-8', bom = false, statusText = '', lostOk = false, saving = false;

  const onChange = d => { mark.textContent = d ? '* modified' : ''; saveBtn.disabled = !d; };
  const onStatus = t => { statusText = t; setStatus((kind !== 'rtf' ? enc + (bom ? ' bom' : '') + ' | ' : '') + t); };

  function load(forceEnc) {
    if (ed && ed.destroy) ed.destroy();
    if (kind === 'rtf') {
      ed = new RtfEditor(host, bytes, { onChange });
      const lost = Object.keys(ed.lost);
      if (lost.length) { note.hidden = false; note.textContent = 'this file has ' + lost.join(', ') + ': the editor does not keep them, saving drops them.'; }
      onStatus('rtf');
      return;
    }
    const d = decodeBytes(bytes, forceEnc);
    enc = d.enc;
    let text = d.text;
    bom = text.startsWith('\uFEFF');
    if (bom) text = text.slice(1);
    encSel.replaceChildren(...['utf-8'].concat(LEGACY).map(x => h('option', { value: x, text: x })));
    encSel.value = enc;
    if (kind === 'csv') ed = new CsvGrid(host, text, { name, onChange, onStatus });
    else ed = new TextEditor(host, text, { md: kind === 'md', onChange, onStatus, imgBase: '/api/raw/' + loc + encP(dir) + '/', linkBase: '/view/' + loc + encP(dir) + '/' });
    if (ed.status) ed.status();
    onChange(false);
    if (!forceEnc && enc !== 'utf-8') toast('not UTF-8: opened as ' + enc + ', pick another encoding if it looks wrong', 'warn');
  }
  encSel.addEventListener('change', async () => {
    if (ed.dirty && !(await confirmBox('encoding', 'reload the file as ' + encSel.value + '? the changes are lost.', 'reload', true))) { encSel.value = enc; return; }
    load(encSel.value);
  });

  async function save(force) {
    if (saving || (!ed.dirty && !force)) return;
    const lost = kind === 'rtf' ? Object.keys(ed.lost) : [];
    if (lost.length && !lostOk) {
      if (!(await confirmBox('save', 'saving drops the ' + lost.join(', ') + ' in this file. save anyway?', 'save', true))) return;
      lostOk = true;
    }
    const snap = ed.ta ? ed.ta.value : null;   // what "saved" means if typing goes on during the upload
    const mark = () => (ed.ta ? ed.markSaved(snap) : ed.markSaved());
    let body = ed.text();
    if (kind !== 'rtf') {
      const r = encodeText((bom ? '\uFEFF' : '') + body, enc);
      if (r.lost && !(await confirmBox('encoding', r.lost + ' characters cannot be stored in ' + enc + ' and would become "?". save anyway? (or switch the encoding to utf-8)', 'save', true))) return;
      body = r.bytes;
    }
    saving = true;
    saveBtn.disabled = true;
    busy(true);
    let conflict = false;
    try {
      const r = await putRaw(U.raw(loc, path), body, { 'if-match': force ? '*' : etag });
      etag = r.etag;
      bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(body);
      mark();
      toast('saved');
    } catch (e) {
      if (e.status === 412) conflict = true; else fail(e);
    } finally {
      saving = false;
      busy(false);
      saveBtn.disabled = !ed.dirty;
    }
    if (!conflict) return;
    const how = await dialog({
      title: 'conflict', body: h('div', { class: 'dlg-text', text: name + ' was changed by someone else since you opened it.' }),
      buttons: [{ label: 'cancel', value: null }, { label: 'save as a copy', value: 'copy' }, { label: 'overwrite theirs', value: 'over', danger: true, primary: true }],
    });
    if (how === 'over') return save(true);
    if (how !== 'copy') return;
    const ext = extOf(name);
    const copy = await dialogAsk('save as a copy', 'name', stem(name) + ' (copy)' + (ext ? '.' + ext : ''), 'save', async v => {
      const bad = checkName(v);
      if (bad) return bad;
      await putRaw(U.raw(loc, joinPath(dir, v)) + '?mode=new', body);
    });
    if (copy) {
      mark();
      navigate(U.edit(loc, joinPath(dir, copy)), true);
    }
  }

  const el = h('section', { class: 'win editwin' },
    h('div', { class: 'titlebar' }, h('span', { class: 'grip', text: '::' }), crumbs(loc, ls.root_name, path, false), mark,
      h('span', { class: 'spacer' }), kind === 'rtf' ? null : encSel, saveBtn,
      btn('view', 'view', () => navigate(U.view(loc, path))),
      btn('close', 'back to the folder', () => navigate(splitPath(path).length ? U.files(loc, dir) : '/shared'))),
    note, host);
  load();
  return {
    el, cls: 'fill', title: name,
    status: '',
    dirty: () => !!(ed && ed.dirty),
    save: () => save(),
    destroy: () => { if (ed && ed.destroy) ed.destroy(); },
    shown: () => { onStatus(statusText); if (ed.focus) ed.focus(); else (ed.page || ed.scroll).focus(); },
  };
}

/* ---- the sheet page: ods, saved on its own every few seconds ---- */
const SHEET_MAX = 32 << 20;
const SHEET_TICK = 5000;
async function sheetPage(loc, path, ls) {
  const name = ls.file.name, dir = parentPath(path);
  let { bytes, etag } = await fetchBytes(U.raw(loc, path), SHEET_MAX);
  const host = h('div', { class: 'edit-host edit-sheet' });
  const mark = h('span', { class: 'dirty', text: '' });
  let grid = null, statusText = '', saving = false, job = Promise.resolve(), failed = '';

  const show = () => { mark.textContent = saving ? 'saving…' : grid && grid.dirty ? '* modified' : ''; };
  const onStatus = t => { statusText = t; setStatus(t); };
  // one thing at a time; the same error again is not shown again
  const run = f => (job = job.then(f).then(() => { failed = ''; }, e => { if (e.message !== failed) fail(e); failed = e.message; }));

  /* their file, with the cells changed here on top */
  async function reload(msg) {
    const cur = await fetchBytes(U.raw(loc, path), SHEET_MAX);
    await grid.rebase(cur.bytes);
    etag = cur.etag;
    toast(msg, 'warn');
  }

  async function save() {
    for (let tries = 0; grid.dirty; tries++) {
      const out = await grid.pack();
      saving = true;
      show();
      try {
        etag = (await putRaw(U.raw(loc, path), out.bytes, { 'if-match': etag })).etag;
        grid.stored(out);
        return;
      } catch (e) {
        if (e.status !== 412 || tries >= 2) throw e;
      } finally {
        saving = false;
        show();
      }
      await reload('changed elsewhere meanwhile: your edits went on top of that version');
    }
  }

  async function tick() {
    if (grid.dirty) return save();
    if (document.hidden) return;
    const l = await api('GET', U.ls(loc, path));
    if (l.file && l.file.etag !== etag) await reload('changed elsewhere: reloaded');
  }

  /* a copy as xlsx: downloaded, or saved next to it */
  async function exportXlsx() {
    const to = stem(name) + '.xlsx';
    const how = await dialog({
      title: 'export as xlsx', body: h('div', { class: 'dlg-text', text: 'a copy of ' + name + ' as it is now, in the Excel format.' }),
      buttons: [{ label: 'cancel', value: null }, { label: 'save as ' + to, value: 'save' }, { label: 'download', value: 'dl', primary: true }],
    });
    if (!how) return;
    const bytes = await grid.xlsx();
    if (how === 'dl') {
      const href = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = h('a', { href, download: to });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 60000);
      return;
    }
    const url = U.raw(loc, joinPath(dir, to));
    try {
      await putRaw(url + '?mode=new', bytes);
    } catch (e) {
      if (e.status !== 409) throw e;
      if (!(await confirmBox('already there', to + ' exists. replace it?', 'replace', true))) return;
      await putRaw(url, bytes);
    }
    toast('saved ' + to);
  }

  grid = await SheetGrid.open(host, bytes, { name, onChange: show, onStatus });
  bytes = null;
  const timer = setInterval(() => run(tick), SHEET_TICK);
  const vis = () => { if (document.hidden) run(save); };
  document.addEventListener('visibilitychange', vis);
  const leave = url => run(save).then(() => navigate(url));

  const el = h('section', { class: 'win editwin' },
    h('div', { class: 'titlebar' }, h('span', { class: 'grip', text: '::' }), crumbs(loc, ls.root_name, path, false), mark,
      h('span', { class: 'spacer' }), h('span', { class: 'dim', text: 'saves by itself' }),
      btn('export .xlsx', 'a copy in the Excel format', () => exportXlsx().catch(fail)),
      btn('view', 'view', () => leave(U.view(loc, path))),
      btn('close', 'back to the folder', () => leave(splitPath(path).length ? U.files(loc, dir) : '/shared'))),
    host);
  return {
    el, cls: 'fill', title: name,
    status: '',
    dirty: () => grid.dirty,
    save: () => run(save),
    destroy: () => { clearInterval(timer); document.removeEventListener('visibilitychange', vis); grid.destroy(); },
    shown: () => { onStatus(statusText); grid.scroll.focus(); },
  };
}

/* ---- shared with me / by me ---- */
async function sharedPage() {
  const d = await api('GET', '/api/shares');
  const box = h('div', { class: 'stack' });
  const withMe = d.with_me.map(s => h('tr', {},
    h('td', {}, h('a', { href: s.dir ? U.files(s.loc, '/') : U.view(s.loc, '/'), text: s.name + (s.dir ? '/' : '') })),
    h('td', { text: s.user }), h('td', { class: s.write ? 'ok' : 'dim', text: s.write ? 'can edit' : 'read only' }),
    h('td', { class: 'dim', text: fmtDate(s.created) }),
    h('td', { class: 'act' }, btn('remove', 'drop it from your list', async () => {
      if (await confirmBox('remove', 'remove ' + s.name + ' from your list? ' + s.user + ' keeps it.', 'remove')) api('DELETE', '/api/shares/' + s.id).then(() => navigate(location.pathname, true), fail);
    }))));
  const byMe = d.by_me.map(s => h('tr', {},
    h('td', {}, h('a', { href: s.dir ? U.files(s.loc, s.path) : U.view(s.loc, s.path), text: s.name + (s.dir ? '/' : '') })),
    h('td', { class: 'dim', text: s.loc_name + ':' + parentPath(s.path) }),
    h('td', { text: s.user }), h('td', { class: s.write ? 'ok' : 'dim', text: s.write ? 'can edit' : 'read only' }),
    h('td', { class: 'dim', text: fmtDate(s.created) }),
    h('td', { class: 'act' }, btn('stop', 'stop sharing', () => api('DELETE', '/api/shares/' + s.id).then(() => navigate(location.pathname, true), fail)))));
  const table = (heads, rows, none) => rows.length
    ? h('table', { class: 'x11' }, h('thead', {}, h('tr', {}, heads.map(t => h('th', { text: t })))), h('tbody', {}, rows))
    : h('div', { class: 'dim', text: none });
  box.append(
    win('shared with me', table(['name', 'from', 'access', 'since', ''], withMe, 'nothing yet')),
    win('shared by me', table(['name', 'in', 'with', 'access', 'since', ''], byMe, 'nothing: use share in the file list')));
  return { el: box, title: 'shared' };
}

async function linksPage() {
  const links = await api('GET', '/api/links');
  const rows = links.map(l => {
    const url = absUrl(l.url);
    const expired = l.expires && l.expires * 1000 < Date.now();
    return h('tr', {},
      h('td', {}, h('a', { href: l.dir ? U.files(l.loc, l.path) : U.view(l.loc, l.path), text: l.name + (l.dir ? '/' : '') })),
      h('td', { class: 'dim', text: l.loc_name + ':' + parentPath(l.path) }),
      h('td', { class: 'url' }, h('a', { href: url, target: '_blank', rel: 'noopener', text: url })),
      h('td', { class: expired ? 'bad' : 'dim', text: l.expires ? (expired ? 'expired ' : '') + fmtDate(l.expires) : 'never' }),
      h('td', { class: 'num', text: l.hits }),
      h('td', { class: 'dim', text: fmtDate(l.created) }),
      h('td', { class: 'act' }, btn('copy', null, () => copyText(url).then(ok => toast(ok ? 'copied' : 'copy failed', ok ? '' : 'err'))),
        btn('remove', 'the link stops working', () => api('DELETE', '/api/links/' + l.id).then(() => navigate(location.pathname, true), fail))));
  });
  const body = rows.length
    ? h('table', { class: 'x11' }, h('thead', {}, h('tr', {}, ['item', 'in', 'link', 'expires', 'opened', 'created', ''].map(t => h('th', { text: t })))), h('tbody', {}, rows))
    : h('div', { class: 'dim', text: 'no links: use share in the file list' });
  return { el: h('div', { class: 'stack' }, win('public links', body)), title: 'links' };
}

/* ---- sftp connection fields, for storage and for the backup target ---- */
function sftpFields(v, editing) {
  v = v || {};
  const host = h('input', { type: 'text', value: v.host || '', placeholder: 'name or address', spellcheck: false });
  const port = h('input', { type: 'number', value: v.port || 22, min: 1, max: 65535 });
  const user = h('input', { type: 'text', value: v.username || '', spellcheck: false, autocomplete: 'off' });
  const auth = h('select', { value: v.auth || 'password' }, h('option', { value: 'password', text: 'password' }), h('option', { value: 'key', text: 'private key' }));
  const pass = h('input', { type: 'password', placeholder: editing ? '(unchanged)' : '', autocomplete: 'new-password' });
  const key = h('textarea', { rows: 4, class: 'key', spellcheck: false, placeholder: editing ? '(unchanged)' : '-----BEGIN OPENSSH PRIVATE KEY-----' });
  const phrase = h('input', { type: 'password', placeholder: editing ? '(unchanged)' : '(if the key has one)', autocomplete: 'new-password' });
  const root = h('input', { type: 'text', value: v.root || '', placeholder: '(the login folder)', spellcheck: false });
  const pw = field('password', pass, 'span2');
  const kb = h('div', { class: 'span2 form2' }, field('private key (openssh or pem)', key, 'span2'), field('key passphrase', phrase));
  const sync = () => { pw.hidden = auth.value !== 'password'; kb.hidden = auth.value !== 'key'; };
  auth.addEventListener('change', sync);
  sync();
  return {
    el: h('div', { class: 'form2' }, field('host', host), field('port', port), field('user', user), field('log in with', auth), pw, kb, field('folder', root, 'span2')),
    value: () => ({ host: host.value.trim(), port: +port.value || 22, username: user.value.trim(), auth: auth.value, password: pass.value, key: key.value, passphrase: phrase.value, root: root.value.trim() }),
  };
}

function mountDialog(m) {
  const name = h('input', { type: 'text', value: m ? m.name : '', placeholder: 'shown in places, e.g. nas' });
  const f = sftpFields(m, !!m);
  const reset = h('input', { type: 'checkbox' });
  return dialog({
    title: m ? 'edit ' + m.name : 'add sftp storage', wide: true,
    body: [field('name', name), f.el,
      m ? h('label', { class: 'chk' }, reset, ' forget the pinned host key (after the server was reinstalled)') : null,
      h('p', { class: 'dim', text: 'saving connects first; the server\'s host key is pinned from then on. passwords and keys are stored encrypted.' })],
    buttons: [{ label: 'cancel', value: null }, { label: m ? 'save' : 'add', primary: true, value: () => Object.assign({ name: name.value.trim(), reset_host_key: reset.checked }, f.value()) }],
    check: async v => {
      const r = await api(m ? 'PUT' : 'POST', m ? '/api/mounts/' + m.id : '/api/mounts', v);
      toast('connected: ' + r.entries + ' entries at the folder');
    },
  });
}

/* ---- settings: phones ----
   Phones paired for folder sync, which only puts files into the home. Inside the
   android app, window.ShelfApp also runs this phone's side: pairing, the folders
   and where they go, and the last run's outcome; the app calls shelfAppEvent(). */
function phonesWin(devices, again) {
  const app = window.ShelfApp;
  let info = app ? JSON.parse(app.info()) : null;
  const rows = devices.map(d => h('tr', {},
    h('td', {}, d.name, info && info.paired && d.id === info.device_id ? h('span', { class: 'dim', text: ' (this phone)' }) : null),
    h('td', { class: 'dim', text: 'paired ' + fmtDate(d.created) }),
    h('td', { class: 'dim', text: 'seen ' + fmtTime(d.last_seen) }),
    h('td', { text: d.files + ' files put' }),
    h('td', { class: 'act' }, btn('remove', 'the phone stops syncing; the files it put stay', async () => {
      if (!(await confirmBox('remove phone', 'remove ' + d.name + '? it stops syncing; the files it put stay.', 'remove', true))) return;
      api('DELETE', '/api/devices/' + d.id).then(() => { if (info && d.id === info.device_id) app.unpair(); again(); }, fail);
    }, 'danger'))));
  const body = [rows.length ? h('table', { class: 'x11' }, h('tbody', {}, rows)) : null];
  if (!app) {
    const url = 'http://' + location.hostname + ':88/';
    body.push(h('p', { class: 'dim' }, 'the shelf app for android puts phone folders (camera, screenshots, ...) here, one way. install it ',
      S.me.remote ? 'from port 88 of this server, at home' : h('a', { href: url, text: url }), ' (Obtainium can keep it up to date from there), then pair the phone here, in the app.'));
    return { el: win('phones', body) };
  }
  if (!info.paired) {
    body.push(h('p', { class: 'dim', text: 'pairing gives this phone a key of its own; it can only put files into your home, never change or remove what somebody else put there.' }),
      h('div', { class: 'row' }, btn('pair this phone', null, () => api('POST', '/api/devices', { name: info.model })
        .then(r => { app.pair(r.token, r.username, r.name, r.id); again(); }, fail), 'primary')));
    return { el: win('phones', body) };
  }

  const folders = h('div'), status = h('p', { class: 'dim' });
  const wifi = h('input', { type: 'checkbox', checked: info.wifi_only, onchange: () => app.setWifiOnly(wifi.checked) });
  const refused = f => dialog({
    title: 'refused in ' + f.name,
    body: [h('p', { class: 'dim', text: 'shelf keeps these as they are there; they are tried again when they change on the phone, or now.' }),
      h('table', { class: 'x11' }, h('tbody', {}, f.problems.map(p => h('tr', {}, h('td', { text: p.path }), h('td', { class: 'dim', text: p.why })))))],
    buttons: [{ label: 'close', value: null }, { label: 'try again', primary: true, value: true }],
  }).then(v => { if (v) { app.retry(f.id); toast('tried again at the next sync'); show(); } });
  const dest = (f, label) => ask('sync ' + f.name, 'into this folder of your home', f.dest, label);
  let shown = '';
  function show() {
    info = JSON.parse(app.info());
    const st = info.status;
    status.textContent = st.running || info.running ? 'syncing: ' + (st.text || '')
      : st.finished ? 'last sync ' + fmtTime(st.finished / 1000) + (st.sent ? ', ' + st.sent + ' files put' : ', nothing new') + (st.error ? '. ' + st.error : '')
      : 'not synced yet';
    const key = JSON.stringify(info.folders);
    if (key === shown) return;
    shown = key;
    add(clear(folders), info.folders.length ? h('table', { class: 'x11' }, h('tbody', {}, info.folders.map(f => h('tr', {},
      h('td', { text: f.name }),
      h('td', { class: 'dim', text: '→ ' + f.dest }),
      h('td', { text: f.sent + (f.local >= 0 ? ' of ' + f.local : '') + ' put' }),
      h('td', { class: 'act' },
        f.refused ? btn(f.refused + ' refused', 'files shelf did not take', () => refused(f)) : null,
        btn('change', 'where the files go', () => dest(f, 'save').then(v => { if (v !== null) { app.setDest(f.id, v); show(); } })),
        btn('remove', 'stop syncing this folder; nothing is removed', () => { app.removeFolder(f.id); show(); }, 'danger'))))))
      : h('p', { class: 'dim', text: 'no folders yet: add one, like DCIM/Camera or Pictures/Screenshots.' }));
  }
  window.shelfAppEvent = (what, id) => {
    show();
    const f = what === 'picked' && info.folders.find(x => x.id === id);
    if (f) dest(f, 'add').then(v => {
      if (v === null) app.removeFolder(f.id);
      else { app.setDest(f.id, v); toast(f.name + ' syncs within the hour, or now with sync now'); }
      show();
    });
  };
  show();
  const poll = setInterval(show, 2000);
  body.push(folders, status,
    h('div', { class: 'row' },
      btn('add folder', null, () => app.addFolder(), 'primary'),
      btn('sync now', 'uses any network', () => { app.syncNow(); setTimeout(show, 300); }),
      h('label', { class: 'chk' }, wifi, ' sync by itself only on Wi-Fi'),
      btn('unpair', 'this phone stops syncing; the files it put stay', async () => {
        if (!(await confirmBox('unpair', 'unpair this phone? it stops syncing; the files it put stay.', 'unpair', true))) return;
        app.unpair();
        setTimeout(again, 500);
      }, 'danger')),
    h('p', { class: 'dim', text: 'one way: new and changed files go to shelf, by themselves every hour and soon after a new picture or video. nothing is ever removed, and what was changed on shelf is not overwritten.' }));
  return { el: win('phones', body), destroy: () => { clearInterval(poll); window.shelfAppEvent = null; } };
}

/* ---- settings: password, storage, phones, API keys ---- */
async function settingsPage() {
  const [mounts, devices, keys] = await Promise.all([api('GET', '/api/mounts'), api('GET', '/api/devices'), api('GET', '/api/keys')]);
  const old = h('input', { type: 'password', autocomplete: 'current-password' });
  const n1 = h('input', { type: 'password', autocomplete: 'new-password' });
  const n2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const change = btn('change password', null, async () => {
    if (n1.value !== n2.value) { toast('the new passwords differ', 'err'); return; }
    try {
      await api('POST', '/api/password', { old: old.value, new: n1.value });
      old.value = n1.value = n2.value = '';
      toast('password changed');
    } catch (e) { fail(e); }
  }, 'primary');
  const again = () => navigate(location.pathname, true);
  const phones = phonesWin(devices, again);
  const rows = mounts.map(m => h('tr', {},
    h('td', {}, h('a', { href: U.files(m.loc, '/'), text: m.name })),
    h('td', { text: m.username + '@' + m.host + (m.port !== 22 ? ':' + m.port : '') }),
    h('td', { class: 'dim', text: m.root || '(login folder)' }),
    h('td', { class: 'dim small', text: m.host_key || '' }),
    h('td', { class: 'act' },
      btn('test', 'connect now', () => api('POST', '/api/mounts/' + m.id + '/test').then(r => toast('ok: ' + r.entries + ' entries'), fail)),
      btn('edit', null, () => mountDialog(m).then(v => { if (v) again(); })),
      btn('remove', 'only the connection; no files are touched', async () => {
        if (await confirmBox('remove storage', 'remove ' + m.name + '? files on the server stay; shares and links into it stop working.', 'remove', true)) api('DELETE', '/api/mounts/' + m.id).then(again, fail);
      }, 'danger'))));
  const el = h('div', { class: 'stack' },
    win('account', [h('p', {}, 'logged in as ', h('b', { text: S.me.username }), S.me.admin ? ' (admin)' : ''),
      h('div', { class: 'form3' }, field('current password', old), field('new password', n1), field('new password again', n2)), h('div', { class: 'row' }, change)]),
    win('external storage (sftp)', [
      rows.length ? h('table', { class: 'x11' }, h('thead', {}, h('tr', {}, ['name', 'login', 'folder', 'host key', ''].map(t => h('th', { text: t })))), h('tbody', {}, rows))
        : h('p', { class: 'dim', text: 'none yet. storage shows up under places in the file list, only for you.' }),
      h('div', { class: 'row' }, btn('add sftp storage', null, () => mountDialog(null).then(v => { if (v) again(); }), 'primary'))]),
    phones.el,
    win('API keys', [
      keys.length ? h('table', { class: 'x11' }, h('thead', {}, h('tr', {}, ['name', 'folder', 'access', 'expires', 'last used', ''].map(t => h('th', { text: t })))), h('tbody', {}, keyRows(keys, again, true)))
        : h('p', { class: 'dim', text: 'none yet. a key lets a program list, download and (if it may edit) upload, move and delete files in one folder.' }),
      h('p', { class: 'dim', text: 'make one with share on a folder in the file list.' })]),
    win('about', h('p', { class: 'dim', text: 'shelf ' + S.me.version + ' on ' + S.me.host + (S.me.remote ? ', reached from outside (' + S.me.remote + ')' : '') })));
  return { el, title: 'settings', destroy: phones.destroy };
}

/* ---- admin: users, backup ---- */
async function adminPage() {
  if (!S.me.admin) throw new Error('admins only');
  const [users, bk] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/backup')]);
  const again = () => navigate(location.pathname, true);
  // a note: how the AS numbers in an outside list were looked up
  const patch = (u, body, msg) => api('PATCH', '/api/users/' + u.id, body).then(r => {
    if (r && r.note) toast(r.note, r.note.includes('not fetched') ? 'err' : null);
    else if (msg) toast(msg);
    again();
  }, fail);
  const rows = users.map(u => {
    const me = u.id === S.me.id;
    return h('tr', { class: u.disabled ? 'off' : null },
      h('td', { text: u.username }),
      h('td', { class: u.admin ? 'warn' : 'dim', text: u.admin ? 'admin' : 'user' }),
      h('td', { class: u.disabled ? 'bad' : 'ok', text: u.disabled ? 'disabled' : 'active' }),
      h('td', { class: u.remote ? 'warn' : 'dim', text: u.remote || 'no' }),
      h('td', { class: 'dim', text: fmtDate(u.created) }),
      h('td', { class: 'act' },
        me ? h('span', { class: 'dim', text: '(you)' }) : [
          btn(u.admin ? 'make user' : 'make admin', null, () => patch(u, { admin: !u.admin })),
          btn(u.disabled ? 'enable' : 'disable', u.disabled ? null : 'logs them out; their shares and links stop working', () => patch(u, { disabled: !u.disabled })),
        ],
        btn('outside', 'networks this account may be used from through the public address', async () => {
          const v = await ask('outside access for ' + u.username, 'networks: CIDR or AS number (AS5610 = every network of that provider), comma separated; empty: LAN only', u.remote, 'set');
          if (v !== null) patch(u, { remote: v }, v.trim() ? null : u.username + ': LAN only');
        }),
        btn('set password', null, async () => {
          const p = await ask('password for ' + u.username, 'new password', genPassword(), 'set');
          if (!p) return;
          try {
            await api('PATCH', '/api/users/' + u.id, { password: p });
            await dialog({ title: 'password set', body: [h('div', { class: 'dlg-text', text: 'the new password for ' + u.username + ':' }), h('pre', { class: 'secret', text: p })] });
          } catch (e) { fail(e); }
        }),
        me ? null : btn('delete', null, async () => {
          if (!(await confirmBox('delete user', 'delete ' + u.username + '? their files are moved aside on the server, not destroyed.', 'delete', true))) return;
          try {
            const r = await api('DELETE', '/api/users/' + u.id);
            if (r.files_kept_at) await dialog({ title: 'deleted', body: h('div', { class: 'dlg-text', text: u.username + '\'s files are kept at ' + r.files_kept_at + ' on the server.' }) });
            again();
          } catch (e) { fail(e); }
        }, 'danger')));
  });
  const nu = h('input', { type: 'text', spellcheck: false, autocomplete: 'off', placeholder: 'username' });
  const np = h('input', { type: 'text', spellcheck: false, autocomplete: 'off', value: genPassword() });
  const na = h('input', { type: 'checkbox' });
  const addUser = btn('add user', null, async () => {
    try {
      await api('POST', '/api/users', { username: nu.value.trim(), password: np.value, admin: na.checked });
      await dialog({ title: 'user added', body: [h('div', { class: 'dlg-text', text: 'hand these to ' + nu.value.trim() + ' (they can change the password in settings):' }),
        h('pre', { class: 'secret', text: 'user:     ' + nu.value.trim() + '\npassword: ' + np.value + '\naddress:  ' + location.origin + '/' + (S.me.public_url && S.me.public_url !== location.origin ? '\noutside:  ' + S.me.public_url + '/ (once allowed under "outside")' : '') })] });
      again();
    } catch (e) { fail(e); }
  }, 'primary');

  const bkBox = h('div');
  const page = { el: null, title: 'admin', destroy: () => clearInterval(page.poll) };
  backupBox(bkBox, bk, page);
  page.el = h('div', { class: 'stack' },
    win('users', [
      h('table', { class: 'x11' }, h('thead', {}, h('tr', {}, ['user', 'role', 'state', 'from outside', 'since', ''].map(t => h('th', { text: t })))), h('tbody', {}, rows)),
      h('div', { class: 'row' }, nu, np, btn('new', 'another password', () => { np.value = genPassword(); }), h('label', { class: 'chk' }, na, ' admin'), addUser)]),
    win('nightly backup', bkBox));
  return page;
}

function backupBox(box, bk, page) {
  const c = bk.config || {};
  const on = h('input', { type: 'checkbox', checked: c.enabled !== false && !!bk.config });
  const time = h('input', { type: 'time', value: c.time || '02:30' });
  const f = sftpFields(c, !!bk.config);
  const reset = h('input', { type: 'checkbox' });
  const state = h('div', { class: 'bk-state' });
  const snaps = h('div', { class: 'dim' });
  const runs = h('div');

  function paint(d) {
    const running = d.running;
    state.replaceChildren(
      running ? h('span', { class: 'warn', text: 'running: ' }) : h('span', { class: 'dim', text: d.config ? (d.config.enabled ? 'next run ' + d.config.time + ' daily. ' : 'nightly runs are off. ') : 'not set up yet. ' }),
      h('span', { text: running ? (d.status || 'starting') : (d.status ? 'last: ' + d.status : '') }));
    snaps.textContent = d.snapshots.length ? 'on the target: ' + d.snapshots.join(', ') : '';
    runBtn.disabled = running || !d.config;
    testBtn.disabled = !d.config;
    const rs = d.runs.map(r => {
      const took = r.finished ? Math.max(0, r.finished - r.started) : null;
      const res = r.ok === true ? ['ok', 'ok'] : r.finished || !running ? ['failed', 'bad'] : ['running', 'warn'];
      return h('tr', {},
        h('td', { text: fmtTime(r.started) }),
        h('td', { class: 'dim', text: took === null ? '' : took < 90 ? took + ' s' : Math.round(took / 60) + ' min' }),
        h('td', { class: res[1], text: res[0] }),
        h('td', { class: 'num', text: r.uploaded }), h('td', { class: 'num', text: fmtSize(r.bytes) }), h('td', { class: 'num', text: r.linked }),
        h('td', { class: 'dim msg', text: r.message || '' }));
    });
    runs.replaceChildren(rs.length
      ? h('table', { class: 'x11' }, h('thead', {}, h('tr', {}, ['started', 'took', 'result', 'files sent', 'size', 'linked', 'message'].map(t => h('th', { text: t })))), h('tbody', {}, rs))
      : h('div', { class: 'dim', text: 'no runs yet' }));
    clearInterval(page.poll);
    if (running) page.poll = setInterval(() => api('GET', '/api/backup').then(paint, () => {}), 2000);
  }

  const saveBtn = btn('save', 'connects to the target first', async () => {
    busy(true);
    try {
      const r = await api('PUT', '/api/backup', Object.assign({ enabled: on.checked, time: time.value, reset_host_key: reset.checked }, f.value()));
      toast('saved; target reachable (' + r.entries + ' entries), host key ' + r.host_key);
      reset.checked = false;
      paint(await api('GET', '/api/backup'));
    } catch (e) { fail(e); } finally { busy(false); }
  }, 'primary');
  const testBtn = btn('test', 'connect to the target', () => { busy(true); api('POST', '/api/backup/test').then(r => toast('ok: ' + r.entries + ' entries at the target'), fail).finally(() => busy(false)); });
  const runBtn = btn('run now', null, () => api('POST', '/api/backup/run').then(() => api('GET', '/api/backup')).then(paint, fail));

  box.replaceChildren(
    h('p', { class: 'dim', text: 'copies everything needed to rebuild this server to an sftp target: a consistent snapshot of the database (the server keeps running), ' +
      'the encryption key, the service settings, the program and all user files. each run is a complete folder named by its time; three are kept: ' +
      'the newest, one up to a week older and one one to four weeks older. files already on the target are hard-linked, not sent again, so each is stored once. ' +
      'RESTORE.md on the target says how to rebuild. files on users\' sftp storage are not included.' }),
    h('div', { class: 'row' }, h('label', { class: 'chk' }, on, ' every night at'), time),
    f.el,
    bk.config ? h('label', { class: 'chk' }, reset, ' forget the pinned host key' + (c.host_key ? ' (' + c.host_key + ')' : '')) : '',
    h('div', { class: 'row' }, saveBtn, testBtn, runBtn),
    state, snaps, runs);
  paint(bk);
}

/* ---- wiring ---- */
document.addEventListener('click', e => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('a');
  if (!a || a.target || a.hasAttribute('download') || a.origin !== location.origin) return;
  if (!/^\/(files|view|edit|pictures|shared|links|settings|admin|login)(\/|$)/.test(a.pathname)) return;
  e.preventDefault();
  navigate(a.pathname + a.search);
});
// a page may take its own history steps (the slideshow's open / close)
window.addEventListener('popstate', () => { if (!(S.page && S.page.pop && S.page.pop())) route(); });
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();   // never the browser's "save page"
    if (S.page && S.page.save && !dlgOpen) S.page.save();
  }
}, true);
document.addEventListener('keydown', e => {
  if (dlgOpen || e.defaultPrevented || !S.page || !S.page.key) return;
  if (S.page.key(e)) e.preventDefault();
});
// files dropped outside a drop zone must not replace the app
document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('drop', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('beforeunload', e => {
  if ((S.page && S.page.dirty && S.page.dirty()) || UP.items.some(i => i.state === 'up' || i.state === 'wait')) { e.preventDefault(); e.returnValue = ''; }
});
route();
