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
  // earlier versions, from the backups (src/versions.rs)
  versions: (loc, p) => '/api/versions/' + loc + encP(p),
  snapLs: (snap, loc, p) => '/api/snap/' + snap + '/ls/' + loc + encP(p),
  snapRaw: (snap, loc, p) => '/api/snap/' + snap + '/raw/' + loc + encP(p),
  version: (snap, loc, p) => '/version/' + snap + '/' + loc + encP(p),
};
function itemUrl(loc, p, dir) { return dir ? U.files(loc, p) : U.view(loc, p); }
function absUrl(u) { return /^https?:\/\//.test(u) ? u : location.origin + u; }
function decodeSegs(rest) {
  return '/' + (rest || '').split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch (e) { return s; } }).join('/');
}
function checkName(n) {
  if (!n || !n.trim()) return tx('a name is needed');
  if (n.includes('/')) return tx('no slashes in names');
  if (n === '.' || n === '..') return tx('not a usable name');
  return null;
}

/* PUT a body; JSON back, or an ApiError */
async function putRaw(url, body, headers) {
  let r;
  try {
    r = await fetch(url, { method: 'PUT', credentials: 'same-origin', headers: Object.assign({ 'x-shelf': '1' }, headers || {}), body });
  } catch (e) { throw new ApiError(tx('server unreachable'), 0); }
  let data = null;
  try { data = await r.json(); } catch (e) { /* not JSON */ }
  if (!r.ok) {
    if (r.status === 401 && window.onUnauthorized) window.onUnauthorized();
    throw new ApiError(txErr((data && data.error) || (r.status + ' ' + r.statusText)), r.status);
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
/* "home" is a word of the UI; storage keeps its own name */
function locName(x) { return x.loc === 'home' ? tx('home') : x.loc_name; }
/* a storage limit as an admin types it: 50G, 1536G, 500M */
function fmtLimit(n) {
  for (const [u, s] of [['T', 40], ['G', 30], ['M', 20]]) if (n >= 2 ** s && n % 2 ** s === 0) return n / 2 ** s + u;
  return +(n / 2 ** 30).toFixed(2) + 'G';
}

/* ---- router ---- */
const NAV = [['files', '/files/home/'], ['shared', '/shared'], ['links', '/links'], ['settings', '/settings'], ['admin', '/admin']];
const ROUTES = [
  [/^\/login$/, () => loginPage()],
  [/^\/files\/([^/]+)(\/.*)?$/, m => filesPage(m[1], decodeSegs(m[2]))],
  [/^\/view\/([^/]+)(\/.*)?$/, m => viewPage(m[1], decodeSegs(m[2]))],
  [/^\/edit\/([^/]+)(\/.*)?$/, m => editPage(m[1], decodeSegs(m[2]))],
  [/^\/version\/([^/]+)\/([^/]+)(\/.*)?$/, m => versionPage(m[1], m[2], decodeSegs(m[3]))],
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
  // the account's language, once picked, wins over this browser's
  if (S.me && S.me.lang && S.me.lang !== LANG) setLang(S.me.lang);
  paintTop();
}

/* the language picker in the top bar (i18n.js); logged in, it is the account's default */
window.onLangPick = code => {
  setLang(code);
  if (S.me) { S.me.lang = code; api('PUT', '/api/me/lang', { lang: code }).catch(fail); }
  paintTop();
  if (UP.win) upTitle();
  if (S.page && S.page.dirty && S.page.dirty()) toast(tx('the editor switches language when it is opened again'), 'warn');
  else route();
};

async function route() {
  const url = location.pathname + location.search;
  if (S.page && url !== S.url && S.page.dirty && S.page.dirty()) {
    if (!(await confirmBox(tx('unsaved changes'), tx('leave this page? the changes are lost.'), tx('leave'), true))) {
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
  try { page = fn ? await fn(m) : errorPage(new Error(tx('no such page'))); } catch (e) { page = errorPage(e); } finally { busy(false); }
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
  const back = S.me ? h('a', { class: 'btn-link', href: '/files/home/', text: tx('home') }) : null;
  return { el: win(tx('error'), [h('p', { class: 'bad', text: e.message || String(e) }), back], 'narrow'), title: tx('error') };
}

function paintTop() {
  const nav = clear($('#nav')), who = clear($('#who'));
  document.body.classList.toggle('anon', !S.me);
  if (!S.me) return;
  for (const [name, href] of NAV) {
    if (name !== 'admin' || S.me.admin) nav.appendChild(h('a', { href, text: tx(name), 'data-sec': name }));
  }
  who.append(h('span', { class: 'dim', text: S.me.username }), btn(tx('log out'), null, logout));
  markNav();
}
function markNav() {
  const seg = location.pathname.split('/')[1];
  const sec = seg === 'view' || seg === 'edit' || seg === 'pictures' ? 'files' : seg;
  for (const a of $$('#nav a')) a.classList.toggle('on', a.dataset.sec === sec);
}

async function logout() {
  if (S.page && S.page.dirty && S.page.dirty() && !(await confirmBox(tx('unsaved changes'), tx('log out and lose the changes?'), tx('log out'), true))) return;
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
  if (S.page && S.page.dirty && S.page.dirty()) { toast(tx('logged out: log in again in another tab, then save'), 'err'); return; }
  S.me = null;
  paintTop();
  navigate('/login?next=' + encodeURIComponent(S.url), true);
};

/* ---- login ---- */
function loginPage() {
  const q = new URLSearchParams(location.search);
  const next = q.get('next') || '/files/home/';
  // a sign-in for another program (oidc.rs): the server finishes it, after the login
  const oidc = next.startsWith('/oidc/');
  const to = oidc && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(q.get('to') || '') ? q.get('to') : null;
  const user = h('input', { type: 'text', autocomplete: 'username', spellcheck: false, autocapitalize: 'off' });
  const pass = h('input', { type: 'password', autocomplete: 'current-password' });
  const msg = h('div', { class: 'bad login-msg' });
  const go = h('button', { class: 'primary', type: 'submit', text: tx('log in') });
  const form = h('form', { class: 'win login' },
    h('div', { class: 'titlebar' }, h('span', { class: 'grip', text: '::' }), tx('log in')),
    h('div', { class: 'body' }, to ? h('p', { class: 'dim', text: tx('to continue to {name}', { name: to }) }) : null,
      field(tx('user'), user), field(tx('password'), pass), msg, h('div', { class: 'row-end' }, go)));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    go.disabled = true;
    msg.textContent = '';
    try {
      await api('POST', '/api/login', { username: user.value.trim(), password: pass.value });
      if (oidc) { location.replace(next); return; }
      await loadMe();
      navigate(next.startsWith('/') && !next.startsWith('//') ? next : '/files/home/', true);
    } catch (err) {
      msg.textContent = err.message;
      pass.select();
    } finally { go.disabled = false; }
  });
  return { el: h('div', { class: 'login-page' }, form), title: tx('log in'), shown: () => user.focus() };
}

/* ---- places: home, sftp storage, things shared with me ---- */
async function loadPlaces() {
  const [mounts, shares] = await Promise.all([api('GET', '/api/mounts'), api('GET', '/api/shares')]);
  return {
    mounts: mounts.map(m => ({ loc: m.loc, name: m.name, title: 'sftp: ' + m.username + '@' + m.host + (m.root ? ':' + m.root : '') })),
    shares: shares.with_me.map(s => ({ loc: s.loc, name: s.name, dir: s.dir, title: s.write ? tx('from {user}, can edit', { user: s.user }) : tx('from {user}, read only', { user: s.user }) })),
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
/* used/size in small print, grey until 80% full; a home with a limit (s.limit) is as big as its limit */
function spaceTag(loc) {
  const el = h('span', { class: 'space' });
  spaceOf(loc).then(s => {
    if (!s || !s.size) return;
    const full = s.limit ? s.used / s.size : s.used / (s.used + s.free || 1), top = s.limit ? 999.5 : undefined;
    el.textContent = fmtShort(s.used, top) + '/' + fmtShort(s.size, top);
    el.classList.toggle('full', full >= 0.8);
    const v = { used: fmtSize(s.used), free: fmtSize(s.free), size: fmtSize(s.size), pc: Math.round(full * 100) };
    el.title = s.limit ? tx('{used} used, {free} free of your limit of {size} ({pc}% full)', v) : tx('{used} used, {free} free of {size} ({pc}% full)', v);
  });
  return el;
}

/* the places window; a click on its titlebar folds it away (remembered),
   metaplaces and all */
function placesBox(places, loc) {
  let here = loc === 'pictures' ? tx('pictures') : tx('home'), hereLoc = loc === 'pictures' ? null : 'home';
  const a = (p, href) => {
    if (p.loc === loc) { here = p.name; hereLoc = p.loc === 'pictures' ? null : p.loc; }
    return h('a', { href, class: 'place' + (p.loc === loc ? ' on' : ''), title: p.title || null },
      h('span', { class: 'pn', text: p.name + (p.dir === false ? '' : '/') }),
      p.loc === 'pictures' ? null : spaceTag(p.loc));
  };
  const kids = [a({ loc: 'home', name: tx('home') }, U.files('home', '/'))];
  if (places && places.mounts.length) {
    kids.push(h('div', { class: 'lbl', text: tx('storage') }));
    places.mounts.forEach(p => kids.push(a(p, U.files(p.loc, '/'))));
  }
  if (places && places.shares.length) {
    kids.push(h('div', { class: 'lbl', text: tx('shared with me') }));
    places.shares.forEach(p => kids.push(a(p, p.dir ? U.files(p.loc, '/') : U.view(p.loc, '/'))));
  }
  kids.push(h('div', { class: 'lbl', text: tx('metaplaces') }));
  kids.push(a({ loc: 'pictures', name: tx('pictures'), dir: false, title: tx('every picture here and shared with you, newest first') }, '/pictures'));
  const fold = h('span', { class: 'fold' });
  const box = win([tx('places'), h('span', { class: 'crumbs place-here' }, here, hereLoc && ' ', hereLoc && spaceTag(hereLoc)), h('span', { class: 'spacer' }), fold], kids, 'places');
  const set = shaded => {
    box.classList.toggle('shaded', shaded);
    fold.textContent = shaded ? '[+]' : '[-]';
  };
  set(localStorage.getItem('shelf.places') === '0');
  const bar = box.querySelector('.titlebar');
  bar.title = tx('fold / unfold the places');
  bar.addEventListener('click', () => {
    const shaded = !box.classList.contains('shaded');
    set(shaded);
    localStorage.setItem('shelf.places', shaded ? '0' : '1');
  });
  return box;
}

function crumbs(loc, rootName, path, last) {
  const segs = splitPath(path);
  const out = [h('a', { href: U.files(loc, '/'), text: loc === 'home' ? tx('home') : rootName })];
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
      el: this.el, cls: 'fill', title: (this.loc === 'home' ? tx('home') : this.ls.root_name) + (this.path === '/' ? '' : this.path),
      key: e => this.key(e),
      onUploaded: (loc, p) => { if (loc === this.loc && p.startsWith(this.path === '/' ? '/' : this.path + '/')) this.soon(); },
      destroy: () => clearTimeout(this.timer),
      shown: () => { this.upd(); this.wrap.focus(); },
    };
  }

  build(places) {
    const w = !this.write;
    this.bUp = btn(tx('upload'), tx('upload files (or drop them on the list)'), () => this.pick(false));
    this.bUpDir = btn(tx('upload folder'), tx('upload a folder with everything in it'), () => this.pick(true));
    this.newSel = h('select', { title: tx('create something here') },
      h('option', { value: '', text: tx('new…') }), h('option', { value: 'dir', text: tx('folder') }),
      h('option', { value: 'md', text: tx('markdown (.md)') }), h('option', { value: 'txt', text: tx('text (.txt)') }),
      h('option', { value: 'csv', text: tx('table (.csv)') }), h('option', { value: 'ods', text: tx('spreadsheet (.ods)') }),
      h('option', { value: 'rtf', text: tx('document (.rtf)') }));
    this.newSel.addEventListener('change', () => { const v = this.newSel.value; this.newSel.value = ''; if (v) this.create(v).catch(fail); });
    [this.bUp, this.bUpDir, this.newSel].forEach(b => { b.disabled = w; });
    this.bOpen = btn(tx('open'), tx('open (enter)'), () => this.openSel());
    this.bEdit = btn(tx('edit'), tx('edit in the browser'), () => this.editSel());
    this.bDl = btn(tx('download'), tx('download'), () => this.download());
    this.bRen = btn(tx('rename'), tx('rename (f2)'), () => this.rename().catch(fail));
    this.bMove = btn(tx('move'), tx('move to another folder'), () => this.move().catch(fail));
    this.bDel = btn(tx('delete'), tx('delete (del)'), () => this.remove().catch(fail), 'danger');
    this.bShare = btn(tx('share'), tx('share with users or by link'), () => this.share());
    this.bVer = btn(tx('versions'), null, () => this.versions());
    this.bVer.hidden = !(this.loc === 'home' && S.me.versions);
    this.filterIn = h('input', { type: 'search', class: 'filter', placeholder: tx('filter (/)'), spellcheck: false });
    this.filterIn.addEventListener('input', () => { this.filter = this.filterIn.value; this.render(); this.paint(); });
    this.filterIn.addEventListener('keydown', e => {
      if (e.key === 'Escape') { this.filterIn.value = ''; this.filter = ''; this.render(); this.paint(); this.wrap.focus(); }
      else if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); this.wrap.focus(); if (this.view.length && this.cur < 0) this.moveTo(0); }
    });
    const bar = h('div', { class: 'toolbar' }, this.bUp, this.bUpDir, this.newSel, h('span', { class: 'sep' }),
      this.bOpen, this.bEdit, this.bDl, this.bRen, this.bMove, this.bShare, this.bVer, this.bDel, h('span', { class: 'spacer' }), this.filterIn);

    const th = (k, label, cls) => {
      const el = h('th', { class: cls || null, text: tx(label), title: tx('sort') });
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
    this.drop = h('div', { class: 'dropnote', hidden: true }, h('span', { text: tx('drop to upload here') }));

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
        this.write ? null : h('span', { class: 'tag', text: tx('read only') })),
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
      if (!this.write) { toast(tx('this folder is read only'), 'err'); return; }
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
          e.shared ? h('span', { class: 'tag', text: tx('shared'), title: tx('shared with users') }) : null,
          e.linked ? h('span', { class: 'tag', text: tx('link'), title: tx('has a public link') }) : null),
        h('td', { class: 'sz', text: e.dir && !e.du ? '' : fmtSize(e.size) }),
        h('td', { class: 'tm', text: fmtTime(e.mtime) }));
    });
    const up = splitPath(this.path).length
      ? [h('tr', { 'data-i': -1, class: 'up' }, h('td', { class: 'nm' }, h('a', { href: U.files(this.loc, parentPath(this.path)), text: '../', title: tx('up (backspace)') })), h('td'), h('td'))]
      : [];
    this.tbody.replaceChildren(...up, ...this.rows);
    this.cur = curName ? this.view.findIndex(e => e.name === curName) : -1;
    for (const t of this.thead.querySelectorAll('th')) {
      t.classList.toggle('sorted', t.dataset.k === this.sort.k);
      t.classList.toggle('desc', t.dataset.k === this.sort.k && this.sort.d);
    }
    this.empty.textContent = this.view.length ? '' : this.entries.length ? tx('nothing matches the filter') :
      this.write ? tx('empty folder: drop files here or use upload') : tx('empty folder');
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
    this.bDl.title = s.some(e => e.dir) ? tx('folders cannot be downloaded yet') : tx('download');
    this.bRen.disabled = !(one && w);
    this.bMove.disabled = !(s.length && w);
    this.bDel.disabled = !(s.length && w);
    this.bShare.disabled = !(one && this.owner);
    this.bVer.disabled = s.length > 1;
    this.bVer.title = one ? tx('earlier versions of {name}, from the backups', { name: one.name }) : tx('earlier versions of this folder, from the backups (deleted files too)');
    const dirs = this.view.filter(e => e.dir).length, files = this.view.length - dirs;
    // folders count once their size is in
    const size = list => fmtSize(list.reduce((a, e) => a + (e.dir && !e.du ? 0 : e.size), 0));
    let t = txn(dirs, '{n} folder', '{n} folders') + ', ' + txn(files, '{n} file', '{n} files') + ', ' + size(this.view);
    if (s.length) t += '  |  ' + txn(s.length, '{n} selected', '{n} selected') + (s.some(e => !e.dir || e.du) ? ', ' + size(s) : '');
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
    const nn = await dialogAsk(tx('rename'), tx('new name'), e.name, tx('rename'), async v => {
      const bad = checkName(v);
      if (bad) return bad;
      if (v === e.name) return null;
      await api('POST', '/api/mv', { loc: this.loc, moves: [{ from: joinPath(this.path, e.name), to: joinPath(this.path, v) }] });
    });
    if (nn && nn !== e.name) await this.refresh(nn);
  }

  async move() {
    const s = this.selected();
    const dest = await pickFolder(this.loc, this.path, tx('move {what}', { what: s.length === 1 ? s[0].name : txn(s.length, '{n} item', '{n} items') }),
      s.filter(e => e.dir).map(e => joinPath(this.path, e.name)));
    if (dest === null || dest === this.path) return;
    await api('POST', '/api/mv', { loc: this.loc, moves: s.map(e => ({ from: joinPath(this.path, e.name), to: joinPath(dest, e.name) })) });
    toast(tx('moved to {dest}', { dest }));
    this.sel.clear();
    await this.refresh();
  }

  async remove() {
    const s = this.selected();
    const what = s.length !== 1 ? txn(s.length, '{n} item', '{n} items') : s[0].dir ? tx('{name} and everything in it', { name: s[0].name }) : s[0].name;
    if (!(await confirmBox(tx('delete'), tx('delete {what}? this cannot be undone.', { what }), tx('delete'), true))) return;
    await api('POST', '/api/rm', { loc: this.loc, paths: s.map(e => joinPath(this.path, e.name)) });
    this.sel.clear();
    await this.refresh();
  }

  async create(kind) {
    if (kind === 'dir') {
      const n = await dialogAsk(tx('new folder'), tx('name'), tx('new folder'), tx('create'), async v => {
        const bad = checkName(v);
        if (bad) return bad;
        await api('POST', '/api/mkdir', { loc: this.loc, path: joinPath(this.path, v) });
      });
      if (n) await this.refresh(n);
      return;
    }
    const n = await dialogAsk(tx('new file'), tx('name'), tx('untitled') + '.' + kind, tx('create'), async v => {
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

  /* of the one selected, else of this folder */
  versions() {
    const s = this.selected();
    if (s.length > 1) return;
    versionsDialog(this.loc, s.length ? joinPath(this.path, s[0].name) : this.path).then(put => { if (put) this.refresh(); });
  }
}

/* ask() whose check runs on the server before the dialog closes */
function dialogAsk(title, label, value, okLabel, check) {
  const inp = h('input', { type: 'text', value: value || '', spellcheck: false, class: 'wide' });
  return dialog({
    title, body: [h('label', { class: 'lbl', text: label }), inp],
    buttons: [{ label: tx('cancel'), value: null }, { label: okLabel, primary: true, value: () => inp.value.trim() }],
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
    list.replaceChildren(h('div', { class: 'dim', text: tx('loading…') }));
    try {
      const ls = await api('GET', U.ls(loc, p));
      cur = p;
      where.textContent = (loc === 'home' ? tx('home') : ls.root_name) + (p === '/' ? '/' : p + '/');
      const rows = [];
      if (splitPath(p).length) rows.push(btn('../', tx('up'), () => load(parentPath(p)), 'pick-item'));
      (ls.entries || []).filter(e => e.dir).map(e => e.name).sort(nameCmp).forEach(d => {
        const full = joinPath(p, d);
        const inside = exclude.some(x => full === x || full.startsWith(x + '/'));
        rows.push(h('button', { class: 'pick-item', text: d + '/', disabled: inside, title: inside ? tx('cannot move a folder into itself') : null, onclick: () => load(full) }));
      });
      if (rows.length === (splitPath(p).length ? 1 : 0)) rows.push(h('div', { class: 'dim', text: tx('(no folders in here)') }));
      list.replaceChildren(...rows);
    } catch (e) { list.replaceChildren(h('div', { class: 'bad', text: e.message })); }
  }
  return dialog({
    title, body: [h('label', { class: 'lbl', text: tx('to') }), where, list],
    buttons: [{ label: tx('cancel'), value: null }, { label: tx('move here'), primary: true, value: () => cur }],
    opened: () => load(start),
  });
}

/* ---- API keys: a program gets one folder (docs/API.md) ---- */
function keyRows(keys, again, withFolder) {
  return keys.map(k => {
    const expired = k.expires && k.expires * 1000 < Date.now();
    return h('tr', {},
      h('td', { text: k.name }),
      withFolder ? h('td', {}, h('a', { href: U.files(k.loc, k.path), text: locName(k) + ':' + k.path })) : null,
      h('td', { class: k.write ? 'ok' : 'dim', text: k.write ? tx('can edit') : tx('read only') }),
      h('td', { class: expired ? 'bad' : 'dim', text: k.expires ? (expired ? tx('expired {date}', { date: fmtDate(k.expires) }) : tx('until {date}', { date: fmtDate(k.expires) })) : tx('no expiry') }),
      h('td', { class: 'dim', text: k.last_used ? tx('used {time}', { time: fmtTime(k.last_used) }) : tx('never used') }),
      h('td', { class: 'act' }, btn(tx('remove'), tx('the key stops working'), async () => {
        if (await confirmBox(tx('remove API key'), tx('remove {name}? whatever uses it loses access.', { name: k.name }), tx('remove'), true)) api('DELETE', '/api/keys/' + k.id).then(again, fail);
      }, 'danger')));
  });
}

/* the key is shown once, here */
function keyShown(r) {
  const key = h('input', { type: 'text', value: r.key, readonly: true, spellcheck: false, class: 'wide mono' });
  const base = absUrl('/api/v1');
  return dialog({
    title: tx('API key {name}', { name: r.name }), wide: true,
    body: [h('p', { text: tx('copy the key now: shelf keeps only a hash of it and cannot show it again.') }),
      h('div', { class: 'row' }, key, btn(tx('copy'), null, () => copyText(r.key).then(ok => toast(ok ? tx('copied') : tx('copy failed'), ok ? '' : 'err')))),
      h('p', { class: 'dim', text: r.write ? tx('the program sends it as "Authorization: Bearer <key>" to {url} (read and write). for example:', { url: base })
        : tx('the program sends it as "Authorization: Bearer <key>" to {url} (read only). for example:', { url: base }) }),
      h('pre', { class: 'mono', text: 'curl -H "Authorization: Bearer ' + r.key + '" ' + base + '/list' }),
      h('p', { class: 'dim', text: tx('the API is described in docs/API.md in the shelf repository.') })],
    buttons: [{ label: tx('done'), primary: true, value: true }],
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
      const w = h('input', { type: 'checkbox', checked: s.write, title: tx('can change, add and delete') });
      w.addEventListener('change', () => api('POST', '/api/shares', { loc, path, user: s.user, write: w.checked }).then(load, fail));
      return h('tr', {}, h('td', { text: s.user }), h('td', {}, h('label', { class: 'chk' }, w, ' ' + tx('can edit'))), h('td', { class: 'dim', text: fmtDate(s.created) }),
        h('td', { class: 'act' }, btn(tx('remove'), tx('stop sharing with {user}', { user: s.user }), () => api('DELETE', '/api/shares/' + s.id).then(load, fail))));
    });
    const who = h('select', {}, others.length ? others.map(n => h('option', { value: n, text: n })) : h('option', { value: '', text: tx('(nobody left)') }));
    const canEdit = h('input', { type: 'checkbox' });
    const add = btn(tx('share'), null, () => {
      if (!who.value) return;
      api('POST', '/api/shares', { loc, path, user: who.value, write: canEdit.checked }).then(load, fail);
    }, 'primary');
    add.disabled = !others.length;

    const lrows = it.links.map(l => {
      const url = absUrl(l.url);
      const expired = l.expires && l.expires * 1000 < Date.now();
      return h('tr', {}, h('td', { class: 'url' }, h('a', { href: url, target: '_blank', rel: 'noopener', text: url })),
        h('td', { class: expired ? 'bad' : 'dim', text: l.expires ? (expired ? tx('expired {date}', { date: fmtDate(l.expires) }) : tx('until {date}', { date: fmtDate(l.expires) })) : tx('no expiry') }),
        h('td', { class: 'dim', text: txn(l.hits, 'opened {n} time', 'opened {n} times') }),
        h('td', { class: 'act' }, btn(tx('copy'), null, () => copyText(url).then(ok => toast(ok ? tx('copied') : tx('copy failed'), ok ? '' : 'err'))),
          btn(tx('remove'), tx('the link stops working'), () => api('DELETE', '/api/links/' + l.id).then(load, fail))));
    });
    const days = h('input', { type: 'number', min: 1, max: 3650, placeholder: tx('never'), class: 'num' });
    const mk = btn(tx('create link'), null, async () => {
      try {
        const r = await api('POST', '/api/links', { loc, path, days: days.value ? +days.value : null });
        const ok = await copyText(absUrl(r.url));
        toast(ok ? tx('link created and copied') : tx('link created'));
        load();
      } catch (e) { fail(e); }
    }, 'primary');

    box.replaceChildren(
      h('div', { class: 'lbl', text: tx('users of this server') }),
      urows.length ? h('table', { class: 'x11' }, h('tbody', {}, urows)) : h('div', { class: 'dim', text: tx('not shared with anyone') }),
      h('div', { class: 'row' }, who, h('label', { class: 'chk' }, canEdit, ' ' + tx('can edit')), add),
      h('div', { class: 'lbl gap', text: tx('links: anyone with the link can open it, no login') }),
      lrows.length ? h('table', { class: 'x11' }, h('tbody', {}, lrows)) : h('div', { class: 'dim', text: tx('no links') }),
      h('div', { class: 'row' }, h('span', { class: 'dim', text: tx('expires after') }), days, h('span', { class: 'dim', text: tx('days') }), mk));
    if (!it.dir) return;

    const krows = keyRows(allKeys.filter(k => k.loc === loc && k.path === it.path), load, false);
    const kname = h('input', { type: 'text', placeholder: tx('what uses it, e.g. backup script'), maxlength: 60 });
    const kwrite = h('input', { type: 'checkbox' });
    const kdays = h('input', { type: 'number', min: 1, max: 3650, placeholder: tx('never'), class: 'num' });
    const mkKey = btn(tx('create key'), null, async () => {
      try {
        const r = await api('POST', '/api/keys', { loc, path, name: kname.value, write: kwrite.checked, days: kdays.value ? +kdays.value : null });
        kname.value = kdays.value = '';
        await keyShown(r);
        load();
      } catch (e) { fail(e); }
    }, 'primary');
    box.append(
      h('div', { class: 'lbl gap', text: tx('API keys: a program with the key can use this folder and what is in it, nothing else') }),
      krows.length ? h('table', { class: 'x11' }, h('tbody', {}, krows)) : h('div', { class: 'dim', text: tx('no keys') }),
      h('div', { class: 'row' }, kname, h('label', { class: 'chk' }, kwrite, ' ' + tx('can edit')),
        h('span', { class: 'dim', text: tx('expires after') }), kdays, h('span', { class: 'dim', text: tx('days') }), mkKey));
  }
  return dialog({
    title: tx('share {name}', { name }), wide: true, body: box,
    buttons: [{ label: tx('close'), value: true, primary: true }],
    opened: () => load().catch(e => box.replaceChildren(h('div', { class: 'bad', text: e.message }))),
  });
}

/* ---- earlier versions, from the backup's snapshots (src/versions.rs). Of a file: what it was,
   once per content. Of a folder: the folder as a backup has it, to look through and restore
   from, deleted files too. Gives true when something was put back. ---- */
function versionsDialog(loc, path) {
  const box = h('div', { class: 'versions' }, h('div', { class: 'dim', text: tx('loading…') }));
  const name = baseName(path) || tx('home');
  const when = s => fmtTime(s.time);
  let put = false, close = null;
  const open = (snap, p) => { close(null); navigate(U.version(snap, loc, p)); };
  const dl = (snap, p) => h('a', { class: 'btn-link', href: U.snapRaw(snap, loc, p) + '?dl=1', download: '', text: tx('download') });
  /* a restore button, off while it runs */
  function putBtn(snap, p, after) {
    const b = btn(tx('restore'), tx('put this version back'), async () => {
      b.disabled = true;
      try { if (await restoreVersion(loc, p, snap)) { put = true; after(); } } catch (e) { fail(e); } finally { b.disabled = false; }
    });
    return b;
  }

  function fileList(v) {
    const list = v.versions.filter(x => !x.dir);
    if (!list.length) {
      box.replaceChildren(h('div', { class: 'dim', text: v.snapshots.length ? tx('no backup has {name}', { name }) : tx('there are no backups yet') }));
      return;
    }
    const rows = list.map(x => h('tr', { class: x.same ? 'off' : null },
      h('td', { class: 'num', text: fmtTime(x.mtime) }),
      h('td', { class: 'num', text: fmtSize(x.size) }),
      h('td', { class: 'dim', text: x.snaps.map(when).join(', ') }),
      h('td', { class: 'act' }, x.same ? h('span', { class: 'tag', text: tx('as now') }) : null,
        btn(tx('open'), null, () => open(x.snaps[0].name, path)), dl(x.snaps[0].name, path),
        x.same ? null : putBtn(x.snaps[0].name, path, () => load().catch(fail)))));
    box.replaceChildren(
      h('div', { class: 'dim', text: v.now ? tx('now: {size}, modified {time}', { size: fmtSize(v.now.size), time: fmtTime(v.now.mtime) }) : tx('{name} is not there now', { name }) }),
      h('table', { class: 'x11' },
        h('thead', {}, h('tr', {}, h('th', { text: tx('modified') }), h('th', { text: tx('size') }), h('th', { text: tx('in the backups of') }), h('th'))),
        h('tbody', {}, rows)));
  }

  function folder(v) {
    if (!v.snapshots.length) { box.replaceChildren(h('div', { class: 'dim', text: tx('there are no backups yet') })); return; }
    const has = v.versions.filter(x => x.dir);
    const sel = h('select', { title: tx('which backup') }, v.snapshots.map(s => {
      const x = has.find(y => y.snaps[0].name === s.name);
      return h('option', { value: s.name, text: tx('backup of {time}', { time: when(s) }) + (x ? ': ' + txn(x.files, '{n} file', '{n} files') + ', ' + fmtSize(x.size) : '') });
    }));
    sel.value = has.length ? has[0].snaps[0].name : v.snapshots[0].name;
    const where = h('div', { class: 'pick-path' });
    const list = h('div', { class: 'vlist' });
    let cur = path, seq = 0;
    const bAll = h('span');
    sel.addEventListener('change', () => show(cur));
    async function show(p) {
      const n = ++seq;
      cur = p;
      where.textContent = tx('home') + (p === '/' ? '/' : p + '/');
      bAll.replaceChildren(p === '/' ? '' : putBtn(sel.value, p, () => show(cur)));
      list.replaceChildren(h('div', { class: 'dim', text: tx('loading…') }));
      let r;
      try { r = await api('GET', U.snapLs(sel.value, loc, p)); } catch (e) {
        if (n === seq) list.replaceChildren(h('div', { class: e.status === 404 ? 'dim' : 'bad', text: e.status === 404 ? tx('this backup does not have this folder') : e.message }));
        return;
      }
      if (n !== seq) return;
      const state = e => e.now === 'gone' ? h('span', { class: 'tag warn', text: tx('deleted since') })
        : e.now === 'changed' ? h('span', { class: 'tag', text: tx('changed since') }) : e.now === 'same' ? h('span', { class: 'tag', text: tx('as now') }) : null;
      const rows = r.entries.sort((a, b) => (b.dir - a.dir) || nameCmp(a.name, b.name)).map(e => {
        const ep = joinPath(p, e.name);
        return h('tr', { class: e.now === 'same' ? 'off' : null },
          h('td', { class: 'nm' }, e.dir ? h('a', { href: '#', text: e.name + '/', onclick: ev => { ev.preventDefault(); show(ep); } }) : e.name, state(e)),
          h('td', { class: 'num', text: fmtSize(e.size), title: e.dir ? txn(e.files, '{n} file', '{n} files') : null }),
          h('td', { class: 'num', text: fmtTime(e.mtime) }),
          h('td', { class: 'act' }, e.dir ? null : [btn(tx('open'), null, () => open(sel.value, ep)), dl(sel.value, ep)],
            e.now === 'same' ? null : putBtn(sel.value, ep, () => show(cur))));
      });
      if (p !== '/') rows.unshift(h('tr', {}, h('td', { class: 'nm', colspan: 4 }, h('a', { href: '#', text: '../', title: tx('up'), onclick: ev => { ev.preventDefault(); show(parentPath(p)); } }))));
      list.replaceChildren(rows.length ? h('table', { class: 'x11' }, h('tbody', {}, rows)) : h('div', { class: 'dim', text: tx('empty folder') }));
    }
    box.replaceChildren(h('div', { class: 'row' }, sel, h('span', { class: 'spacer' }), bAll), where, list);
    show(path);
  }

  async function load() {
    const v = await api('GET', U.versions(loc, path));
    const dir = v.now ? v.now.dir : v.versions.length ? v.versions[0].dir : true;
    if (dir) folder(v); else fileList(v);
  }
  return dialog({
    title: tx('earlier versions of {name}', { name }), wide: true, body: box,
    buttons: [{ label: tx('close'), value: true, primary: true }],
    opened: (w, done) => { close = done; load().catch(e => box.replaceChildren(h('div', { class: 'bad', text: e.message }))); },
  }).then(() => put);
}

/* puts back what backup `snap` has at path: in its place when that is free, else next to it, or a
   file over the one there now. Asks first when something is there. Gives where it went, or null. */
async function restoreVersion(loc, path, snap) {
  const v = await api('GET', U.versions(loc, path));
  const name = baseName(path), ver = v.versions.find(x => x.snaps.some(s => s.name === snap));
  if (!ver) throw new Error(tx('this backup does not have {name}', { name }));
  const time = fmtTime(ver.snaps.find(s => s.name === snap).time);
  let replace = false;
  if (v.now) {
    const files = !ver.dir && !v.now.dir;
    const text = files
      ? tx('{name} is there now. put the one from the backup of {time} next to it, or in its place?', { name, time }) +
        (v.versions.some(x => x.same) ? '' : ' ' + tx('the file as it is now is in no backup: replacing it loses it.'))
      : tx('{name} is there now. the one from the backup of {time} goes next to it.', { name, time });
    const a = await dialog({
      title: tx('restore {name}', { name }), body: h('div', { class: 'dlg-text', text }),
      buttons: [{ label: tx('cancel'), value: null }].concat(files ? [{ label: tx('replace'), value: 'replace', danger: true }] : [],
        [{ label: tx('next to it'), value: 'copy', primary: true }]),
    });
    if (!a) return null;
    replace = a === 'replace';
  }
  busy(true);
  setStatus(tx('restoring {name}…', { name }));
  try {
    const r = await api('POST', '/api/restore', { loc, path, snap, replace });
    toast(tx('restored: {path}', { path: r.path }));
    return r.path;
  } finally { busy(false); setStatus(''); }
}

/* ---- a file as a backup has it: /version/<snap>/<loc>/<path> ---- */
async function versionPage(snap, loc, path) {
  const o = await api('GET', U.versions(loc, path));
  const name = baseName(path), dir = parentPath(path), raw = U.snapRaw(snap, loc, path);
  const ver = o.versions.find(x => !x.dir && x.snaps.some(s => s.name === snap));
  if (!ver) throw new Error(tx('this backup does not have {name}', { name }));
  const when = fmtTime(ver.snaps.find(s => s.name === snap).time);
  const v = viewer({
    name, raw, siblings: null, rawOf: () => raw,
    md: async () => {
      const r = await fetchText(raw, TEXT_MAX);
      const res = await api('POST', '/api/md', { text: r.text, img_base: '/api/snap/' + snap + '/raw/' + loc + encP(dir) + '/', link_base: '/version/' + snap + '/' + loc + encP(dir) + '/' });
      return res.html;
    },
  });
  const back = U.files(loc, dir);
  const el = h('section', { class: 'win viewwin' },
    h('div', { class: 'titlebar' }, h('span', { class: 'grip', text: '::' }), crumbs(loc, '', path, false),
      h('span', { class: 'tag', text: tx('backup of {time}', { time: when }) }), h('span', { class: 'spacer' }),
      ver.same ? null : btn(tx('restore'), tx('put this version back'), () => restoreVersion(loc, path, snap).then(p => { if (p) navigate(U.view(loc, p)); }, fail)),
      h('a', { class: 'btn-link', href: raw + '?dl=1', download: '', text: tx('download') }),
      h('a', { class: 'btn-link', href: back, text: tx('close'), title: tx('close (esc)') })),
    v.el);
  return {
    el, cls: 'fill', title: name + ' (' + when + ')',
    status: tx('{size}, modified {time}', { size: fmtSize(ver.size), time: fmtTime(ver.mtime) }) + (ver.same ? ', ' + tx('as now') : ''),
    destroy: () => v.destroy(),
    key: e => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return false;
      if (e.key === 'Escape') { navigate(back); return true; }
      return false;
    },
  };
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
        btn(tx('clear'), tx('remove finished'), () => { UP.items = UP.items.filter(i => { if (i.state === 'done' || i.state === 'skip' || i.state === 'err') { i.row.remove(); return false; } return true; }); upTitle(); }),
        btn('x', tx('hide (uploads go on)'), () => { UP.win.hidden = true; })),
      UP.list);
    document.body.appendChild(UP.win);
  }
  UP.win.hidden = false;
  const batch = { policy: null };
  for (const f of files) {
    const it = { loc, path: joinPath(dir, f.rel), file: f.file, mk: f.rel.includes('/'), batch, state: 'wait' };
    it.bar = h('i');
    it.st = h('span', { class: 'up-st dim', text: tx('waiting') });
    it.x = btn('x', tx('cancel'), () => cancelUp(it));
    it.row = h('div', { class: 'up-row' }, h('span', { class: 'up-name', text: f.rel, title: it.path }), h('span', { class: 'up-bar' }, it.bar), it.st, it.x);
    UP.list.appendChild(it.row);
    UP.items.push(it);
  }
  upTitle();
  pump();
}

function upTitle() {
  const left = UP.items.filter(i => i.state === 'wait' || i.state === 'up').length;
  UP.title.textContent = left ? tx('uploading, {n} left', { n: left }) : tx('uploads done');
  const el = $('#up-status');
  if (el) el.textContent = left ? tx('upload: {n} left', { n: left }) : '';
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
  else if (it.state === 'wait') { it.state = 'skip'; it.st.textContent = tx('cancelled'); it.x.hidden = true; upTitle(); }
}

function xput(url, body, progress) {
  const x = new XMLHttpRequest();
  const p = new Promise((res, rej) => {
    x.open('PUT', url);
    x.setRequestHeader('x-shelf', '1');
    x.upload.onprogress = e => progress(e.loaded, e.total || body.size);
    x.onload = () => { let j = null; try { j = JSON.parse(x.responseText); } catch (e) { /* none */ } res({ status: x.status, json: j }); };
    x.onerror = () => rej(new Error(tx('network error')));
    x.onabort = () => rej(new Error(tx('cancelled')));
    x.send(body);
  });
  return { x, p };
}

async function sendUp(it, replace) {
  UP.running++;
  it.state = 'up';
  it.st.textContent = '0%';
  // a big file that cannot fit in a home with a limit is not sent at all (the server would read it, then refuse)
  if (!replace && it.loc === 'home' && it.file.size > 32 << 20) {
    const s = await api('GET', '/api/space/home').catch(() => null);
    if (s && s.limit && it.file.size > s.free) {
      UP.running--;
      it.state = 'err';
      it.st.textContent = tx('this does not fit within the storage limit');
      it.st.className = 'up-st bad';
      it.x.hidden = true;
      pump();
      return;
    }
  }
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
    it.st.textContent = tx('exists');
    const how = await conflict(it);
    if (how === 'replace') { sendUp(it, true); return; }
    it.state = 'skip';
    it.st.textContent = tx('skipped');
  } else if (r && r.status >= 200 && r.status < 300) {
    it.state = 'done';
    it.bar.style.width = '100%';
    it.st.textContent = tx('done');
    it.st.className = 'up-st ok';
    if (S.page && S.page.onUploaded) S.page.onUploaded(it.loc, it.path);
  } else {
    it.state = 'err';
    it.st.textContent = err || (r.json && r.json.error && txErr(r.json.error)) || tx('error {status}', { status: r.status });
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
      title: tx('already there'), body: h('div', { class: 'dlg-text', text: tx('{name} exists.', { name: it.path }) }),
      buttons: [{ label: tx('skip'), value: 'skip' }, { label: tx('skip all'), value: 'skip-all' },
        { label: tx('replace all'), value: 'replace-all', danger: true }, { label: tx('replace'), value: 'replace', primary: true, danger: true }],
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
    const p = btn(tx('< prev'), tx('previous (left arrow)'), () => go(v.prev)), n = btn(tx('next >'), tx('next (right arrow)'), () => go(v.next));
    p.disabled = !v.prev;
    n.disabled = !v.next;
    nav = [p, n];
  }
  const el = h('section', { class: 'win viewwin' },
    h('div', { class: 'titlebar' }, h('span', { class: 'grip', text: '::' }),
      inFolder ? crumbs(loc, ls.root_name, path, false) : h('span', { class: 'crumbs' }, h('span', { class: 'here', text: name })),
      h('span', { class: 'spacer' }), nav,
      canEdit ? btn(tx('edit'), tx('edit (e)'), () => navigate(U.edit(loc, path))) : null,
      toOds ? btn(tx('edit as .ods'), tx('spreadsheets are edited as .ods: make one from this next to it, and edit that'), () => editAsOds(loc, path, name).catch(fail)) : null,
      loc === 'home' && S.me.versions ? btn(tx('versions'), tx('earlier versions of {name}, from the backups', { name }),
        () => versionsDialog(loc, path).then(put => { if (put) route(); })) : null,
      h('a', { class: 'btn-link', href: U.raw(loc, path) + '?dl=1', download: '', text: tx('download') }),
      h('a', { class: 'btn-link', href: back, text: tx('close'), title: tx('close (esc)') })),
    v.el);
  return {
    el, cls: 'fill', title: name,
    status: tx('{size}, modified {time}', { size: fmtSize(ls.file.size), time: fmtTime(ls.file.mtime) }),
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
      title: tx('already there'), body: h('div', { class: 'dlg-text', text: tx('{name} exists.', { name: stem(name) + '.ods' }) }),
      buttons: [{ label: tx('cancel'), value: null }, { label: tx('replace it'), value: 'replace', danger: true }, { label: tx('edit that one'), value: 'open', primary: true }],
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
  const shareName = loc => { const s = places && places.shares.find(x => x.loc === loc); return s ? s.name : tx('shared'); };

  const wrap = h('div', { class: 'picwrap', tabindex: '0' });
  const tiles = [];
  const years = h('select', { title: tx('jump to a year'), onchange: () => {
    const hd = wrap.querySelector('[data-y="' + years.value + '"]');
    if (hd) wrap.scrollTop = hd.nextSibling.offsetTop - hd.offsetHeight;
    years.value = '';
    wrap.focus();
  } }, h('option', { value: '', text: tx('year') }));
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
  if (!pics.length) wrap.appendChild(h('div', { class: 'empty dim', text: r.scanning ? tx('looking for pictures; reload in a while') : tx('no pictures here yet') }));

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
      lbl.textContent = txn(pics.length, '{n} picture', '{n} pictures');
      if (grid.children.length) { hd.lastChild.textContent = ' ' + grid.children.length; return; }
      // the month is gone; the year's jump moves to its next month, if it has one
      const y = hd.dataset.y, nx = grid.nextSibling;
      if (y && nx && nx.firstChild.textContent.startsWith(y)) nx.dataset.y = y;
      else if (y) years.querySelector('option[value="' + y + '"]').remove();
      hd.remove();
      grid.remove();
      if (!pics.length) wrap.appendChild(h('div', { class: 'empty dim', text: tx('no pictures here yet') }));
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

  const scan = r.scanning ? h('div', { class: 'note dim', text: r.scanning.total
    ? tx('still looking for pictures ({done} of {total}); reload in a while for the rest', r.scanning)
    : tx('still looking for pictures; reload in a while for the rest') }) : null;
  const lbl = h('span', { class: 'lbl', text: txn(pics.length, '{n} picture', '{n} pictures') });
  const bar = h('div', { class: 'toolbar' }, lbl, pics.length ? years : null,
    h('span', { class: 'spacer' }), pics.length ? btn(tx('slideshow'), tx('from the newest, playing'), () => { open(0); slides.play(true); }) : null);
  const pw = h('section', { class: 'win picwin' },
    h('div', { class: 'titlebar' }, h('span', { class: 'grip', text: '::' }), h('span', { class: 'crumbs' }, h('span', { class: 'here', text: tx('pictures') }))),
    bar, scan, wrap, slides.el);
  const range = pics.length ? ', ' + tx('{from} to {to}', { from: picMonth(pics[pics.length - 1]), to: picMonth(pics[0]) }) : '';
  return {
    el: h('div', { class: 'files-layout' }, placesBox(places, 'pictures'), pw), cls: 'fill', title: tx('pictures'),
    status: txn(pics.length, '{n} picture', '{n} pictures') + range + '; ' + tx('dates from exif, else the file name, the folder or the file time'),
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
  const name = h('a', { class: 'slide-name', title: tx('open in the viewer') });
  const folder = h('a', { class: 'slide-dir dim', title: tx('the folder') });
  const dl = h('a', { class: 'btn-link', download: '', text: tx('download') });
  const playB = btn(tx('play'), tx('play / pause (space)'), () => play(!playing));
  const bRen = btn(tx('rename'), tx('rename (f2)'), () => act(rename), 'slide-act');
  const bMove = btn(tx('move'), tx('move to another folder'), () => act(move), 'slide-act');
  const bShare = btn(tx('share'), tx('share with users or by link'), () => act(p => shareDialog(p.loc, p.path, p.name)), 'slide-act');
  const bDel = btn(tx('delete'), tx('delete (del)'), () => act(remove), 'slide-act danger');
  const stage = h('div', { class: 'slide-stage' }, img, msg,
    h('button', { class: 'slide-go prev', text: '<', title: tx('previous (left arrow)'), onclick: () => go(cur - 1) }),
    h('button', { class: 'slide-go next', text: '>', title: tx('next (right arrow)'), onclick: () => go(cur + 1) }));
  const el = h('div', { class: 'slides', hidden: true },
    h('div', { class: 'slide-bar' }, count, date, name, folder, h('span', { class: 'spacer' }), playB,
      bRen, bMove, bShare, bDel, dl, btn(tx('close'), tx('close (esc)'), () => on.close())),
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
    date.textContent = picDate(p) + ' (' + tx(PIC_SRC[p.src]) + ')';
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
      msg.textContent = tx('cannot show {name}', { name: p.name });
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
    playB.textContent = yes ? tx('pause') : tx('play');
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
    const nn = await dialogAsk(tx('rename'), tx('new name'), p.name, tx('rename'), async v => {
      const bad = checkName(v);
      if (bad) return bad;
      if (v === p.name) return null;
      await api('POST', '/api/mv', { loc: p.loc, moves: [{ from: p.path, to: joinPath(p.dir, v) }] });
    });
    if (nn && nn !== p.name) changed(p, p.dir, nn);
  }
  async function move(p) {
    const dest = await pickFolder(p.loc, p.dir, tx('move {what}', { what: p.name }), []);
    if (dest === null || dest === p.dir) return;
    await api('POST', '/api/mv', { loc: p.loc, moves: [{ from: p.path, to: joinPath(dest, p.name) }] });
    toast(tx('moved to {dest}', { dest }));
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
    const also = p.links > 1 ? ' ' + txn(p.links - 1, 'the same file is also at another place (hard links), which keeps it.',
      'the same file is also at {n} other places (hard links), which keep it.') : '';
    if (!(await confirmBox(tx('delete'), tx('delete {what}? this cannot be undone.', { what: p.name }) + also, tx('delete'), true))) return;
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

/* for the editors: the whole file as it is now, never a copy from the browser's
   cache (which Chromium can piece together from an older, shorter range);
   anything but a full 200 would be saved back cut short */
async function fetchBytes(url, max) {
  const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (!r.ok) {
    if (r.status === 401 && window.onUnauthorized) window.onUnauthorized();
    throw new Error(r.status + ' ' + r.statusText);
  }
  if (r.status !== 200) throw new Error(tx('the file came back incomplete ({status}); open it again', { status: r.status }));
  const b = new Uint8Array(await r.arrayBuffer());
  if (b.length > max) throw new Error(tx('too big to edit here (over {size})', { size: fmtSize(max) }));
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
  ['b', 'bold (ctrl+b)', ta => mdWrap(ta, '**', '**', tx('bold'))],
  ['i', 'italic (ctrl+i)', ta => mdWrap(ta, '*', '*', tx('italic'))],
  ['s', 'strike through', ta => mdWrap(ta, '~~', '~~', tx('text'))],
  ['code', 'code', ta => (ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n') ? mdWrap(ta, '```\n', '\n```', tx('code')) : mdWrap(ta, '`', '`', tx('code')))],
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
  ['link', 'link (ctrl+k)', ta => mdWrap(ta, '[', '](https://)', tx('text'))],
  ['image', 'image: a relative path shows a file from this folder', ta => mdWrap(ta, '![', '](picture.png)', tx('description'))],
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
        const b = h('button', { text: tx(t[0]), title: tx(t[1]) });
        b.addEventListener('mousedown', e => e.preventDefault());
        b.addEventListener('click', () => t[2](this.ta));
        tools.push(b);
      }
      this.mode = localStorage.getItem('shelf.mdmode') || (innerWidth > 900 ? 'split' : 'edit');
      this.modeBtns = ['edit', 'split', 'preview'].map(m => { const b = btn(tx(m), null, () => this.setMode(m)); b.dataset.mode = m; return b; });
      tools.push(h('span', { class: 'spacer' }), h('span', { class: 'seg' }, this.modeBtns));
    } else tools.push(h('span', { class: 'spacer' }));
    tools.push(h('label', { class: 'chk', title: tx('wrap long lines') }, wrapBox, ' ' + tx('wrap')));
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
    this.modeBtns.forEach(b => b.classList.toggle('on', b.dataset.mode === m));
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
      if (k === 'b') { e.preventDefault(); mdWrap(ta, '**', '**', tx('bold')); return; }
      if (k === 'i') { e.preventDefault(); mdWrap(ta, '*', '*', tx('italic')); return; }
      if (k === 'k') { e.preventDefault(); mdWrap(ta, '[', '](https://)', tx('text')); return; }
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
    this.opts.onStatus(tx('line {line}, col {col}', { line, col }) + ' | ' + txn(v.length, '{n} char', '{n} chars') + (this.eol === '\r\n' ? ' | crlf' : ''));
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
  const saveBtn = btn(tx('save'), tx('save (ctrl+s)'), () => save(), 'primary');
  const encSel = h('select', { title: tx('text encoding of the file') });
  const note = h('div', { class: 'note warn', hidden: true });
  let ed = null, enc = 'utf-8', bom = false, statusText = '', lostOk = false, saving = false;

  const onChange = d => { mark.textContent = d ? '* ' + tx('modified') : ''; saveBtn.disabled = !d; };
  const onStatus = t => { statusText = t; setStatus((kind !== 'rtf' ? enc + (bom ? ' bom' : '') + ' | ' : '') + t); };

  function load(forceEnc) {
    if (ed && ed.destroy) ed.destroy();
    if (kind === 'rtf') {
      ed = new RtfEditor(host, bytes, { onChange });
      const lost = Object.keys(ed.lost);
      if (lost.length) { note.hidden = false; note.textContent = tx('this file has {what}: the editor does not keep them, saving drops them.', { what: lost.map(k => tx(k)).join(', ') }); }
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
    if (!forceEnc && enc !== 'utf-8') toast(tx('not UTF-8: opened as {enc}, pick another encoding if it looks wrong', { enc }), 'warn');
  }
  encSel.addEventListener('change', async () => {
    if (ed.dirty && !(await confirmBox(tx('encoding'), tx('reload the file as {enc}? the changes are lost.', { enc: encSel.value }), tx('reload'), true))) { encSel.value = enc; return; }
    load(encSel.value);
  });

  async function save(force) {
    if (saving || (!ed.dirty && !force)) return;
    const lost = kind === 'rtf' ? Object.keys(ed.lost) : [];
    if (lost.length && !lostOk) {
      if (!(await confirmBox(tx('save'), tx('saving drops the {what} in this file. save anyway?', { what: lost.map(k => tx(k)).join(', ') }), tx('save'), true))) return;
      lostOk = true;
    }
    const snap = ed.ta ? ed.ta.value : null;   // what "saved" means if typing goes on during the upload
    const mark = () => (ed.ta ? ed.markSaved(snap) : ed.markSaved());
    let body = ed.text();
    if (kind !== 'rtf') {
      const r = encodeText((bom ? '\uFEFF' : '') + body, enc);
      if (r.lost && !(await confirmBox(tx('encoding'), tx('{n} characters cannot be stored in {enc} and would become "?". save anyway? (or switch the encoding to utf-8)', { n: r.lost, enc }), tx('save'), true))) return;
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
      toast(tx('saved'));
    } catch (e) {
      if (e.status === 412) conflict = true; else fail(e);
    } finally {
      saving = false;
      busy(false);
      saveBtn.disabled = !ed.dirty;
    }
    if (!conflict) return;
    const how = await dialog({
      title: tx('conflict'), body: h('div', { class: 'dlg-text', text: tx('{name} was changed by someone else since you opened it.', { name }) }),
      buttons: [{ label: tx('cancel'), value: null }, { label: tx('save as a copy'), value: 'copy' }, { label: tx('overwrite theirs'), value: 'over', danger: true, primary: true }],
    });
    if (how === 'over') return save(true);
    if (how !== 'copy') return;
    const ext = extOf(name);
    const copy = await dialogAsk(tx('save as a copy'), tx('name'), tx('{name} (copy)', { name: stem(name) }) + (ext ? '.' + ext : ''), tx('save'), async v => {
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
      btn(tx('view'), tx('view'), () => navigate(U.view(loc, path))),
      btn(tx('close'), tx('back to the folder'), () => navigate(splitPath(path).length ? U.files(loc, dir) : '/shared'))),
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

  const show = () => { mark.textContent = saving ? tx('saving…') : grid && grid.dirty ? '* ' + tx('modified') : ''; };
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
      await reload(tx('changed elsewhere meanwhile: your edits went on top of that version'));
    }
  }

  async function tick() {
    if (grid.dirty) return save();
    if (document.hidden) return;
    const l = await api('GET', U.ls(loc, path));
    if (l.file && l.file.etag !== etag) await reload(tx('changed elsewhere: reloaded'));
  }

  /* a copy as xlsx: downloaded, or saved next to it */
  async function exportXlsx() {
    const to = stem(name) + '.xlsx';
    const how = await dialog({
      title: tx('export as xlsx'), body: h('div', { class: 'dlg-text', text: tx('a copy of {name} as it is now, in the Excel format.', { name }) }),
      buttons: [{ label: tx('cancel'), value: null }, { label: tx('save as {name}', { name: to }), value: 'save' }, { label: tx('download'), value: 'dl', primary: true }],
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
      if (!(await confirmBox(tx('already there'), tx('{name} exists. replace it?', { name: to }), tx('replace'), true))) return;
      await putRaw(url, bytes);
    }
    toast(tx('saved {name}', { name: to }));
  }

  grid = await SheetGrid.open(host, bytes, { name, onChange: show, onStatus });
  bytes = null;
  const timer = setInterval(() => run(tick), SHEET_TICK);
  const vis = () => { if (document.hidden) run(save); };
  document.addEventListener('visibilitychange', vis);
  const leave = url => run(save).then(() => navigate(url));

  const el = h('section', { class: 'win editwin' },
    h('div', { class: 'titlebar' }, h('span', { class: 'grip', text: '::' }), crumbs(loc, ls.root_name, path, false), mark,
      h('span', { class: 'spacer' }), h('span', { class: 'dim', text: tx('saves by itself') }),
      btn(tx('export .xlsx'), tx('a copy in the Excel format'), () => exportXlsx().catch(fail)),
      btn(tx('view'), tx('view'), () => leave(U.view(loc, path))),
      btn(tx('close'), tx('back to the folder'), () => leave(splitPath(path).length ? U.files(loc, dir) : '/shared'))),
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
    h('td', { text: s.user }), h('td', { class: s.write ? 'ok' : 'dim', text: s.write ? tx('can edit') : tx('read only') }),
    h('td', { class: 'dim', text: fmtDate(s.created) }),
    h('td', { class: 'act' }, btn(tx('remove'), tx('drop it from your list'), async () => {
      if (await confirmBox(tx('remove'), tx('remove {name} from your list? {user} keeps it.', { name: s.name, user: s.user }), tx('remove'))) api('DELETE', '/api/shares/' + s.id).then(() => navigate(location.pathname, true), fail);
    }))));
  const byMe = d.by_me.map(s => h('tr', {},
    h('td', {}, h('a', { href: s.dir ? U.files(s.loc, s.path) : U.view(s.loc, s.path), text: s.name + (s.dir ? '/' : '') })),
    h('td', { class: 'dim', text: locName(s) + ':' + parentPath(s.path) }),
    h('td', { text: s.user }), h('td', { class: s.write ? 'ok' : 'dim', text: s.write ? tx('can edit') : tx('read only') }),
    h('td', { class: 'dim', text: fmtDate(s.created) }),
    h('td', { class: 'act' }, btn(tx('stop'), tx('stop sharing'), () => api('DELETE', '/api/shares/' + s.id).then(() => navigate(location.pathname, true), fail)))));
  const table = (heads, rows, none) => rows.length
    ? h('table', { class: 'x11' }, h('thead', {}, h('tr', {}, heads.map(t => h('th', { text: tx(t) })))), h('tbody', {}, rows))
    : h('div', { class: 'dim', text: none });
  box.append(
    win(tx('shared with me'), table(['name', 'from', 'access', 'since', ''], withMe, tx('nothing yet'))),
    win(tx('shared by me'), table(['name', 'in', 'with', 'access', 'since', ''], byMe, tx('nothing: use share in the file list'))));
  return { el: box, title: tx('shared') };
}

async function linksPage() {
  const links = await api('GET', '/api/links');
  const rows = links.map(l => {
    const url = absUrl(l.url);
    const expired = l.expires && l.expires * 1000 < Date.now();
    return h('tr', {},
      h('td', {}, h('a', { href: l.dir ? U.files(l.loc, l.path) : U.view(l.loc, l.path), text: l.name + (l.dir ? '/' : '') })),
      h('td', { class: 'dim', text: locName(l) + ':' + parentPath(l.path) }),
      h('td', { class: 'url' }, h('a', { href: url, target: '_blank', rel: 'noopener', text: url })),
      h('td', { class: expired ? 'bad' : 'dim', text: l.expires ? (expired ? tx('expired {date}', { date: fmtDate(l.expires) }) : fmtDate(l.expires)) : tx('never') }),
      h('td', { class: 'num', text: l.hits }),
      h('td', { class: 'dim', text: fmtDate(l.created) }),
      h('td', { class: 'act' }, btn(tx('copy'), null, () => copyText(url).then(ok => toast(ok ? tx('copied') : tx('copy failed'), ok ? '' : 'err'))),
        btn(tx('remove'), tx('the link stops working'), () => api('DELETE', '/api/links/' + l.id).then(() => navigate(location.pathname, true), fail))));
  });
  const body = rows.length
    ? h('table', { class: 'x11' }, h('thead', {}, h('tr', {}, ['item', 'in', 'link', 'expires', 'opened', 'created', ''].map(t => h('th', { text: tx(t) })))), h('tbody', {}, rows))
    : h('div', { class: 'dim', text: tx('no links: use share in the file list') });
  return { el: h('div', { class: 'stack' }, win(tx('public links'), body)), title: tx('links') };
}

/* ---- sftp connection fields, for storage and for the backup target ---- */
function sftpFields(v, editing) {
  v = v || {};
  const host = h('input', { type: 'text', value: v.host || '', placeholder: tx('name or address'), spellcheck: false });
  const port = h('input', { type: 'number', value: v.port || 22, min: 1, max: 65535 });
  const user = h('input', { type: 'text', value: v.username || '', spellcheck: false, autocomplete: 'off' });
  const auth = h('select', { value: v.auth || 'password' }, h('option', { value: 'password', text: tx('password') }), h('option', { value: 'key', text: tx('private key') }));
  const pass = h('input', { type: 'password', placeholder: editing ? tx('(unchanged)') : '', autocomplete: 'new-password' });
  const key = h('textarea', { rows: 4, class: 'key', spellcheck: false, placeholder: editing ? tx('(unchanged)') : '-----BEGIN OPENSSH PRIVATE KEY-----' });
  const phrase = h('input', { type: 'password', placeholder: editing ? tx('(unchanged)') : tx('(if the key has one)'), autocomplete: 'new-password' });
  const root = h('input', { type: 'text', value: v.root || '', placeholder: tx('(the login folder)'), spellcheck: false });
  const pw = field(tx('password'), pass, 'span2');
  const kb = h('div', { class: 'span2 form2' }, field(tx('private key (openssh or pem)'), key, 'span2'), field(tx('key passphrase'), phrase));
  const sync = () => { pw.hidden = auth.value !== 'password'; kb.hidden = auth.value !== 'key'; };
  auth.addEventListener('change', sync);
  sync();
  return {
    el: h('div', { class: 'form2' }, field(tx('host'), host), field(tx('port'), port), field(tx('user'), user), field(tx('log in with'), auth), pw, kb, field(tx('folder'), root, 'span2')),
    value: () => ({ host: host.value.trim(), port: +port.value || 22, username: user.value.trim(), auth: auth.value, password: pass.value, key: key.value, passphrase: phrase.value, root: root.value.trim() }),
  };
}

function mountDialog(m) {
  const name = h('input', { type: 'text', value: m ? m.name : '', placeholder: tx('shown in places, e.g. nas') });
  const f = sftpFields(m, !!m);
  const reset = h('input', { type: 'checkbox' });
  return dialog({
    title: m ? tx('edit {name}', { name: m.name }) : tx('add sftp storage'), wide: true,
    body: [field(tx('name'), name), f.el,
      m ? h('label', { class: 'chk' }, reset, ' ' + tx('forget the pinned host key (after the server was reinstalled)')) : null,
      h('p', { class: 'dim', text: tx('saving connects first; the server\'s host key is pinned from then on. passwords and keys are stored encrypted.') })],
    buttons: [{ label: tx('cancel'), value: null }, { label: m ? tx('save') : tx('add'), primary: true, value: () => Object.assign({ name: name.value.trim(), reset_host_key: reset.checked }, f.value()) }],
    check: async v => {
      const r = await api(m ? 'PUT' : 'POST', m ? '/api/mounts/' + m.id : '/api/mounts', v);
      toast(txn(r.entries, 'connected: {n} entry at the folder', 'connected: {n} entries at the folder'));
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
    h('td', {}, d.name, info && info.paired && d.id === info.device_id ? h('span', { class: 'dim', text: ' (' + tx('this phone') + ')' }) : null),
    h('td', { class: 'dim', text: tx('paired {date}', { date: fmtDate(d.created) }) }),
    h('td', { class: 'dim', text: tx('seen {time}', { time: fmtTime(d.last_seen) }) }),
    h('td', { text: txn(d.files, '{n} file put', '{n} files put') }),
    h('td', { class: 'act' }, btn(tx('remove'), tx('the phone stops syncing; the files it put stay'), async () => {
      if (!(await confirmBox(tx('remove phone'), tx('remove {name}? it stops syncing; the files it put stay.', { name: d.name }), tx('remove'), true))) return;
      api('DELETE', '/api/devices/' + d.id).then(() => { if (info && d.id === info.device_id) app.unpair(); again(); }, fail);
    }, 'danger'))));
  const body = [rows.length ? h('table', { class: 'x11' }, h('tbody', {}, rows)) : null];
  if (!app) {
    const url = 'http://' + location.hostname + ':88/';
    body.push(h('p', { class: 'dim' }, tx('the shelf app for android puts phone folders (camera, screenshots, ...) here, one way. install it') + ' ',
      S.me.remote ? tx('from port 88 of this server, at home') : h('a', { href: url, text: url }), ' ' + tx('(Obtainium can keep it up to date from there), then pair the phone here, in the app.')));
    return { el: win(tx('phones'), body) };
  }
  if (!info.paired) {
    body.push(h('p', { class: 'dim', text: tx('pairing gives this phone a key of its own; it can only put files into your home, never change or remove what somebody else put there.') }),
      h('div', { class: 'row' }, btn(tx('pair this phone'), null, () => api('POST', '/api/devices', { name: info.model })
        .then(r => { app.pair(r.token, r.username, r.name, r.id); again(); }, fail), 'primary')));
    return { el: win(tx('phones'), body) };
  }

  const folders = h('div'), status = h('p', { class: 'dim' });
  const wifi = h('input', { type: 'checkbox', checked: info.wifi_only, onchange: () => app.setWifiOnly(wifi.checked) });
  const refused = f => dialog({
    title: tx('refused in {name}', { name: f.name }),
    body: [h('p', { class: 'dim', text: tx('shelf keeps these as they are there; they are tried again when they change on the phone, or now.') }),
      h('table', { class: 'x11' }, h('tbody', {}, f.problems.map(p => h('tr', {}, h('td', { text: p.path }), h('td', { class: 'dim', text: p.why })))))],
    buttons: [{ label: tx('close'), value: null }, { label: tx('try again'), primary: true, value: true }],
  }).then(v => { if (v) { app.retry(f.id); toast(tx('tried again at the next sync')); show(); } });
  const dest = (f, label) => ask(tx('sync {name}', { name: f.name }), tx('into this folder of your home'), f.dest, label);
  let shown = '';
  function show() {
    info = JSON.parse(app.info());
    const st = info.status;
    status.textContent = st.running || info.running ? tx('syncing:') + ' ' + (st.text || '')
      : st.finished ? tx('last sync {time}', { time: fmtTime(st.finished / 1000) }) + ', ' + (st.sent ? txn(st.sent, '{n} file put', '{n} files put') : tx('nothing new')) + (st.error ? '. ' + st.error : '')
      : tx('not synced yet');
    const key = JSON.stringify(info.folders);
    if (key === shown) return;
    shown = key;
    add(clear(folders), info.folders.length ? h('table', { class: 'x11' }, h('tbody', {}, info.folders.map(f => h('tr', {},
      h('td', { text: f.name }),
      h('td', { class: 'dim', text: '→ ' + f.dest }),
      h('td', { text: f.local >= 0 ? tx('{sent} of {local} put', f) : tx('{sent} put', f) }),
      h('td', { class: 'act' },
        f.refused ? btn(tx('{refused} refused', f), tx('files shelf did not take'), () => refused(f)) : null,
        btn(tx('change'), tx('where the files go'), () => dest(f, tx('save')).then(v => { if (v !== null) { app.setDest(f.id, v); show(); } })),
        btn(tx('remove'), tx('stop syncing this folder; nothing is removed'), () => { app.removeFolder(f.id); show(); }, 'danger'))))))
      : h('p', { class: 'dim', text: tx('no folders yet: add one, like DCIM/Camera or Pictures/Screenshots.') }));
  }
  window.shelfAppEvent = (what, id) => {
    show();
    const f = what === 'picked' && info.folders.find(x => x.id === id);
    if (f) dest(f, tx('add')).then(v => {
      if (v === null) app.removeFolder(f.id);
      else { app.setDest(f.id, v); toast(tx('{name} syncs within the hour, or now with sync now', { name: f.name })); }
      show();
    });
  };
  show();
  const poll = setInterval(show, 2000);
  body.push(folders, status,
    h('div', { class: 'row' },
      btn(tx('add folder'), null, () => app.addFolder(), 'primary'),
      btn(tx('sync now'), tx('uses any network'), () => { app.syncNow(); setTimeout(show, 300); }),
      h('label', { class: 'chk' }, wifi, ' ' + tx('sync by itself only on Wi-Fi')),
      btn(tx('unpair'), tx('this phone stops syncing; the files it put stay'), async () => {
        if (!(await confirmBox(tx('unpair'), tx('unpair this phone? it stops syncing; the files it put stay.'), tx('unpair'), true))) return;
        app.unpair();
        setTimeout(again, 500);
      }, 'danger')),
    h('p', { class: 'dim', text: tx('one way: new and changed files go to shelf, by themselves every hour and soon after a new picture or video. nothing is ever removed, and what was changed on shelf is not overwritten.') }));
  return { el: win(tx('phones'), body), destroy: () => { clearInterval(poll); window.shelfAppEvent = null; } };
}

/* ---- settings: password, storage, phones, API keys ---- */
async function settingsPage() {
  const [mounts, devices, keys] = await Promise.all([api('GET', '/api/mounts'), api('GET', '/api/devices'), api('GET', '/api/keys')]);
  const old = h('input', { type: 'password', autocomplete: 'current-password' });
  const n1 = h('input', { type: 'password', autocomplete: 'new-password' });
  const n2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const change = btn(tx('change password'), null, async () => {
    if (n1.value !== n2.value) { toast(tx('the new passwords differ'), 'err'); return; }
    try {
      await api('POST', '/api/password', { old: old.value, new: n1.value });
      old.value = n1.value = n2.value = '';
      toast(tx('password changed'));
    } catch (e) { fail(e); }
  }, 'primary');
  const again = () => navigate(location.pathname, true);
  const phones = phonesWin(devices, again);
  const rows = mounts.map(m => h('tr', {},
    h('td', {}, h('a', { href: U.files(m.loc, '/'), text: m.name })),
    h('td', { text: m.username + '@' + m.host + (m.port !== 22 ? ':' + m.port : '') }),
    h('td', { class: 'dim', text: m.root || tx('(login folder)') }),
    h('td', { class: 'dim small', text: m.host_key || '' }),
    h('td', { class: 'act' },
      btn(tx('test'), tx('connect now'), () => api('POST', '/api/mounts/' + m.id + '/test').then(r => toast(txn(r.entries, 'ok: {n} entry', 'ok: {n} entries')), fail)),
      btn(tx('edit'), null, () => mountDialog(m).then(v => { if (v) again(); })),
      btn(tx('remove'), tx('only the connection; no files are touched'), async () => {
        if (await confirmBox(tx('remove storage'), tx('remove {name}? files on the server stay; shares and links into it stop working.', { name: m.name }), tx('remove'), true)) api('DELETE', '/api/mounts/' + m.id).then(again, fail);
      }, 'danger'))));
  const el = h('div', { class: 'stack' },
    win(tx('account'), [h('p', {}, tx('logged in as') + ' ', h('b', { text: S.me.username }), S.me.admin ? ' (' + tx('admin') + ')' : ''),
      h('div', { class: 'form3' }, field(tx('current password'), old), field(tx('new password'), n1), field(tx('new password again'), n2)), h('div', { class: 'row' }, change)]),
    win(tx('external storage (sftp)'), [
      rows.length ? h('table', { class: 'x11' }, h('thead', {}, h('tr', {}, ['name', 'login', 'folder', 'host key', ''].map(t => h('th', { text: tx(t) })))), h('tbody', {}, rows))
        : h('p', { class: 'dim', text: tx('none yet. storage shows up under places in the file list, only for you.') }),
      h('div', { class: 'row' }, btn(tx('add sftp storage'), null, () => mountDialog(null).then(v => { if (v) again(); }), 'primary'))]),
    phones.el,
    win(tx('API keys'), [
      keys.length ? h('table', { class: 'x11' }, h('thead', {}, h('tr', {}, ['name', 'folder', 'access', 'expires', 'last used', ''].map(t => h('th', { text: tx(t) })))), h('tbody', {}, keyRows(keys, again, true)))
        : h('p', { class: 'dim', text: tx('none yet. a key lets a program list, download and (if it may edit) upload, move and delete files in one folder.') }),
      h('p', { class: 'dim', text: tx('make one with share on a folder in the file list.') })]),
    win(tx('about'), h('p', { class: 'dim', text: tx('shelf {version} on {host}', S.me) + (S.me.remote ? ', ' + tx('reached from outside ({ip})', { ip: S.me.remote }) : '') })));
  return { el, title: tx('settings'), destroy: phones.destroy };
}

/* ---- admin: users, backup ---- */
async function adminPage() {
  if (!S.me.admin) throw new Error(tx('admins only'));
  const [users, bk, oidc] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/backup'), api('GET', '/api/oidc/clients')]);
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
      h('td', { class: u.admin ? 'warn' : 'dim', text: u.admin ? tx('admin') : tx('user') }),
      h('td', { class: u.disabled ? 'bad' : 'ok', text: u.disabled ? tx('disabled') : tx('active') }),
      h('td', { class: u.remote ? 'warn' : 'dim', text: u.remote || tx('no') }),
      h('td', { class: u.quota == null ? 'dim' : u.used >= u.quota * 0.8 ? 'warn' : null,
        text: u.quota == null ? tx('no') : u.used == null ? fmtLimit(u.quota) : tx('{used} of {limit}', { used: fmtShort(u.used, 999.5), limit: fmtShort(u.quota, 999.5) }) }),
      h('td', { class: 'dim', text: fmtDate(u.created) }),
      h('td', { class: 'act' },
        me ? h('span', { class: 'dim', text: tx('(you)') }) : [
          btn(u.admin ? tx('make user') : tx('make admin'), null, () => patch(u, { admin: !u.admin })),
          btn(u.disabled ? tx('enable') : tx('disable'), u.disabled ? null : tx('logs them out; their shares and links stop working'), () => patch(u, { disabled: !u.disabled })),
        ],
        btn(tx('outside'), tx('networks this account may be used from through the public address'), async () => {
          const v = await ask(tx('outside access for {name}', { name: u.username }), tx('networks: CIDR or AS number (AS5610 = every network of that provider), comma separated; empty: LAN only'), u.remote, tx('set'));
          if (v !== null) patch(u, { remote: v }, v.trim() ? null : tx('{name}: LAN only', { name: u.username }));
        }),
        btn(tx('limit'), tx('room this account may use in its home'), async () => {
          const v = await ask(tx('storage limit for {name}', { name: u.username }), tx('size, like 50G, 500M or 1.5T; empty: no limit'),
            u.quota == null ? '' : fmtLimit(u.quota), tx('set'));
          if (v !== null) patch(u, { quota: v }, v.trim() ? tx('{name}: storage limit {size}', { name: u.username, size: v.trim() }) : tx('{name}: no storage limit', { name: u.username }));
        }),
        btn(tx('set password'), null, async () => {
          const p = await ask(tx('password for {name}', { name: u.username }), tx('new password'), genPassword(), tx('set'));
          if (!p) return;
          try {
            await api('PATCH', '/api/users/' + u.id, { password: p });
            await dialog({ title: tx('password set'), body: [h('div', { class: 'dlg-text', text: tx('the new password for {name}:', { name: u.username }) }), h('pre', { class: 'secret', text: p })] });
          } catch (e) { fail(e); }
        }),
        me ? null : btn(tx('delete'), null, async () => {
          if (!(await confirmBox(tx('delete user'), tx('delete {name}? their files are moved aside on the server, not destroyed.', { name: u.username }), tx('delete'), true))) return;
          try {
            const r = await api('DELETE', '/api/users/' + u.id);
            if (r.files_kept_at) await dialog({ title: tx('deleted'), body: h('div', { class: 'dlg-text', text: tx('the files of {name} are kept at {path} on the server.', { name: u.username, path: r.files_kept_at }) }) });
            again();
          } catch (e) { fail(e); }
        }, 'danger')));
  });
  const nu = h('input', { type: 'text', spellcheck: false, autocomplete: 'off', placeholder: tx('username') });
  const np = h('input', { type: 'text', spellcheck: false, autocomplete: 'off', value: genPassword() });
  const na = h('input', { type: 'checkbox' });
  const addUser = btn(tx('add user'), null, async () => {
    try {
      await api('POST', '/api/users', { username: nu.value.trim(), password: np.value, admin: na.checked });
      await dialog({ title: tx('user added'), body: [h('div', { class: 'dlg-text', text: tx('hand these to {name} (they can change the password in settings):', { name: nu.value.trim() }) }),
        h('pre', { class: 'secret', text: 'user:     ' + nu.value.trim() + '\npassword: ' + np.value + '\naddress:  ' + location.origin + '/' + (S.me.public_url && S.me.public_url !== location.origin ? '\noutside:  ' + S.me.public_url + '/ (once allowed under "outside")' : '') })] });
      again();
    } catch (e) { fail(e); }
  }, 'primary');

  const bkBox = h('div');
  const page = { el: null, title: tx('admin'), destroy: () => clearInterval(page.poll) };
  backupBox(bkBox, bk, page);
  page.el = h('div', { class: 'stack' },
    win(tx('users'), [
      h('table', { class: 'x11' }, h('thead', {}, h('tr', {}, ['user', 'role', 'state', 'from outside', 'limit', 'since', ''].map(t => h('th', { text: tx(t) })))), h('tbody', {}, rows)),
      h('div', { class: 'row' }, nu, np, btn(tx('new'), tx('another password'), () => { np.value = genPassword(); }), h('label', { class: 'chk' }, na, ' ' + tx('admin')), addUser)]),
    oidcWin(oidc, again),
    win(tx('nightly backup'), bkBox));
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
      running ? h('span', { class: 'warn', text: tx('running:') + ' ' })
        : h('span', { class: 'dim', text: (d.config ? (d.config.enabled ? tx('next run {time} daily.', d.config) : tx('nightly runs are off.')) : tx('not set up yet.')) + ' ' }),
      h('span', { text: running ? (d.status || tx('starting')) : (d.status ? tx('last:') + ' ' + d.status : '') }));
    snaps.textContent = d.snapshots.length ? tx('on the target:') + ' ' + d.snapshots.join(', ') : '';
    runBtn.disabled = running || !d.config;
    testBtn.disabled = !d.config;
    const rs = d.runs.map(r => {
      const took = r.finished ? Math.max(0, r.finished - r.started) : null;
      const res = r.ok === true ? ['ok', 'ok'] : r.finished || !running ? ['failed', 'bad'] : ['running', 'warn'];
      return h('tr', {},
        h('td', { text: fmtTime(r.started) }),
        h('td', { class: 'dim', text: took === null ? '' : took < 90 ? took + ' s' : Math.round(took / 60) + ' min' }),
        h('td', { class: res[1], text: tx(res[0]) }),
        h('td', { class: 'num', text: r.uploaded }), h('td', { class: 'num', text: fmtSize(r.bytes) }), h('td', { class: 'num', text: r.linked }),
        h('td', { class: 'dim msg', text: r.message || '' }));
    });
    runs.replaceChildren(rs.length
      ? h('table', { class: 'x11' }, h('thead', {}, h('tr', {}, ['started', 'took', 'result', 'files sent', 'size', 'linked', 'message'].map(t => h('th', { text: tx(t) })))), h('tbody', {}, rs))
      : h('div', { class: 'dim', text: tx('no runs yet') }));
    clearInterval(page.poll);
    if (running) page.poll = setInterval(() => api('GET', '/api/backup').then(paint, () => {}), 2000);
  }

  const saveBtn = btn(tx('save'), tx('connects to the target first'), async () => {
    busy(true);
    try {
      const r = await api('PUT', '/api/backup', Object.assign({ enabled: on.checked, time: time.value, reset_host_key: reset.checked }, f.value()));
      toast(tx('saved; target reachable ({entries} entries), host key {host_key}', r));
      reset.checked = false;
      paint(await api('GET', '/api/backup'));
    } catch (e) { fail(e); } finally { busy(false); }
  }, 'primary');
  const testBtn = btn(tx('test'), tx('connect to the target'), () => { busy(true); api('POST', '/api/backup/test').then(r => toast(txn(r.entries, 'ok: {n} entry at the target', 'ok: {n} entries at the target')), fail).finally(() => busy(false)); });
  const runBtn = btn(tx('run now'), null, () => api('POST', '/api/backup/run').then(() => api('GET', '/api/backup')).then(paint, fail));

  box.replaceChildren(
    h('p', { class: 'dim', text: tx('copies everything needed to rebuild this server to an sftp target: a consistent snapshot of the database (the server keeps running), ' +
      'the encryption key, the service settings, the program and all user files. each run is a complete folder named by its time; three are kept: ' +
      'the newest, one up to a week older and one one to four weeks older. files already on the target are hard-linked, not sent again, so each is stored once. ' +
      'RESTORE.md on the target says how to rebuild. files on users\' sftp storage are not included.') }),
    h('div', { class: 'row' }, h('label', { class: 'chk' }, on, ' ' + tx('every night at')), time),
    f.el,
    bk.config ? h('label', { class: 'chk' }, reset, ' ' + tx('forget the pinned host key') + (c.host_key ? ' (' + c.host_key + ')' : '')) : '',
    h('div', { class: 'row' }, saveBtn, testBtn, runBtn),
    state, snaps, runs);
  paint(bk);
}

/* ---- admin: sign-in for other programs (OpenID Connect, oidc.rs) ---- */
function oidcWin(o, again) {
  const handOver = (title, id, secret) => dialog({ title, body: [
    h('div', { class: 'dlg-text', text: secret ? tx('the program needs these; the secret is shown only now:') : tx('the program needs these:') }),
    h('pre', { class: 'secret', text: 'issuer:        ' + (o.issuer || tx('(not set)')) + '\nclient_id:     ' + id + (secret ? '\nclient_secret: ' + secret : '') })] });
  const rows = o.clients.map(c => h('tr', {},
    h('td', { text: c.name }),
    h('td', { class: 'dim', text: c.public ? tx('public (PKCE)') : tx('with secret') }),
    h('td', { class: 'small', text: c.redirect_uris.join(' ') }),
    h('td', { class: c.users ? 'warn' : 'dim', text: c.users || tx('everyone') }),
    h('td', { class: 'num', text: c.signed_in }),
    h('td', { class: 'dim', text: c.last_used ? fmtDate(c.last_used) : tx('never') }),
    h('td', { class: 'act' },
      btn(tx('edit'), null, () => clientDialog(c).then(v => { if (v) again(); })),
      c.public ? null : btn(tx('new secret'), tx('the old one stops working'), async () => {
        if (!(await confirmBox(tx('new secret'), tx('make a new secret for {name}? it stops working until it has the new one.', { name: c.name }), tx('new secret'), true))) return;
        try { const r = await api('POST', '/api/oidc/clients/' + c.id + '/secret'); await handOver(tx('new secret'), c.name, r.client_secret); } catch (e) { fail(e); }
      }),
      btn(tx('remove'), null, async () => {
        if (await confirmBox(tx('remove program'), tx('remove {name}? nobody can log in to it with shelf any more.', { name: c.name }), tx('remove'), true)) api('DELETE', '/api/oidc/clients/' + c.id).then(again, fail);
      }, 'danger'))));
  return win(tx('sign-in for other programs'), [
    h('p', { class: 'dim', text: o.issuer
      ? tx('programs on the network can let people log in with their shelf account (OpenID Connect). issuer: {issuer}', o)
      : tx('off: set SHELF_OIDC_ISSUER in /etc/shelf/shelf.env and restart shelf. programs can be added already.') }),
    rows.length ? h('table', { class: 'x11' }, h('thead', {}, h('tr', {}, ['program', 'kind', 'redirect URIs', 'who', 'logged in', 'last used', ''].map(t => h('th', { text: tx(t) })))), h('tbody', {}, rows))
      : h('p', { class: 'dim', text: tx('no programs yet.') }),
    h('div', { class: 'row' }, btn(tx('add program'), null, () => clientDialog(null).then(r => { if (r) handOver(tx('program added'), r.client_id, r.client_secret).then(again); }), 'primary'))]);
}

/* add (c null) or edit a program; resolves to the server's answer, or null */
function clientDialog(c) {
  const name = h('input', { type: 'text', value: c ? c.name : '', disabled: !!c, spellcheck: false, autocomplete: 'off', placeholder: tx('e.g. tracker; it is the client_id') });
  const uris = h('textarea', { class: 'key', rows: 3, spellcheck: false, value: c ? c.redirect_uris.join('\n') : '', placeholder: 'http://apps.lan/oauth2/callback' });
  const who = h('input', { type: 'text', value: c ? c.users : '', spellcheck: false, autocomplete: 'off', placeholder: tx('everyone') });
  const pub = h('input', { type: 'checkbox' });
  let res = null;
  return dialog({
    title: c ? tx('edit {name}', { name: c.name }) : tx('add program'), wide: true,
    body: [field(tx('name'), name), field(tx('redirect URIs, one per line'), uris), field(tx('who may log in: usernames, comma separated; empty: everyone'), who),
      c ? null : h('label', { class: 'chk' }, pub, ' ' + tx('public: an app on a phone or in a browser, which cannot keep a secret (it must use PKCE)'))],
    buttons: [{ label: tx('cancel'), value: null }, { label: c ? tx('save') : tx('add'), primary: true,
      value: () => c ? { redirect_uris: uris.value, users: who.value } : { name: name.value.trim(), redirect_uris: uris.value, users: who.value, public: pub.checked } }],
    check: async v => { res = await api(c ? 'PATCH' : 'POST', c ? '/api/oidc/clients/' + c.id : '/api/oidc/clients', v); },
  }).then(v => v && res);
}

/* ---- wiring ---- */
document.addEventListener('click', e => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('a');
  if (!a || a.target || a.hasAttribute('download') || a.origin !== location.origin) return;
  if (!/^\/(files|view|edit|version|pictures|shared|links|settings|admin|login)(\/|$)/.test(a.pathname)) return;
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
