/* public links: /s/<token> and /s/<token>/p/<path>. Every navigation is a
   plain page load, so the pages cache well in front of a proxy. */
'use strict';

(async function () {
  const m = /^\/s\/([^/]+)(?:\/p(\/.*))?$/.exec(location.pathname);
  const main = $('#app');
  if (!m) { main.appendChild(h('p', { class: 'bad', text: 'not a link' })); return; }
  const tok = m[1];
  const sub = '/' + splitPath(m[2] || '').map(s => { try { return decodeURIComponent(s); } catch (e) { return s; } }).join('/');
  const encP = p => { const e = encPath(p); return e ? '/' + e : ''; };
  const base = '/s/' + tok;
  const pageUrl = p => (splitPath(p).length ? base + '/p' + encP(p) : base);
  const rawUrl = p => base + '/raw' + encP(p);
  const setStatus = t => { $('#status').textContent = t || ''; };

  async function get(url) {
    const r = await fetch(url, { credentials: 'omit' });
    if (r.status === 404) throw new Error('404');
    if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
    return r.json();
  }
  function frame(titleKids, body, cls) {
    return h('section', { class: 'win ' + cls }, h('div', { class: 'titlebar' }, h('span', { class: 'grip', text: '::' }), titleKids), body);
  }
  function crumbs(root, p, dirLink) {
    const segs = splitPath(p);
    const out = [segs.length ? h('a', { href: base, text: root }) : h('span', { class: 'here', text: root })];
    let acc = '';
    segs.forEach((s, i) => {
      acc += '/' + s;
      out.push(h('span', { class: 'dim', text: ' / ' }));
      out.push(i === segs.length - 1 && !dirLink ? h('span', { class: 'here', text: s }) : h('a', { href: pageUrl(acc), text: s }));
    });
    return h('span', { class: 'crumbs' }, out);
  }

  let ls;
  busy(true);
  try { ls = await get(base + '/ls' + encP(sub)); } catch (e) {
    busy(false);
    document.title = 'not found · shelf';
    main.appendChild(frame('shelf', h('div', { class: 'body' }, h('p', { class: e.message === '404' ? 'dim' : 'bad',
      text: e.message === '404' ? 'this link does not exist or has expired.' : 'error: ' + e.message })), 'narrow'));
    return;
  }
  busy(false);
  const shared = h('span', { class: 'dim', text: 'shared by ' + ls.owner });

  if (ls.file) {
    const f = ls.file, inFolder = splitPath(sub).length > 0, dir = parentPath(sub);
    let siblings = null;
    if (inFolder) {
      try { siblings = (await get(base + '/ls' + encP(dir))).entries.filter(e => !e.dir).map(e => e.name); } catch (e) { /* no prev / next */ }
    }
    const v = viewer({
      name: f.name, raw: rawUrl(sub), siblings,
      rawOf: n => rawUrl(joinPath(dir, n)),
      md: () => get(base + '/md' + encP(sub)).then(r => r.html),
    });
    const go = n => { if (n) location.href = pageUrl(joinPath(dir, n)); };
    let nav = null;
    if (v.prev || v.next) {
      const p = h('button', { text: '< prev', title: 'previous (left arrow)', onclick: () => go(v.prev) });
      const n = h('button', { text: 'next >', title: 'next (right arrow)', onclick: () => go(v.next) });
      p.disabled = !v.prev;
      n.disabled = !v.next;
      nav = [p, n];
    }
    main.className = 'fill';
    main.appendChild(frame([inFolder ? crumbs(ls.root_name, sub, false) : h('span', { class: 'crumbs' }, h('span', { class: 'here', text: f.name })),
      h('span', { class: 'spacer' }), nav, shared,
      h('a', { class: 'btn-link', href: rawUrl(sub) + '?dl=1', download: '', text: 'download' })], v.el, 'viewwin'));
    document.title = f.name + ' · shelf';
    setStatus(fmtSize(f.size) + ', modified ' + fmtTime(f.mtime));
    document.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLInputElement || e.target instanceof HTMLMediaElement) return;
      if (e.key === 'ArrowLeft' && v.prev) go(v.prev);
      else if (e.key === 'ArrowRight' && v.next) go(v.next);
      else if (e.key === 'Backspace' && inFolder) location.href = pageUrl(dir);
    });
    return;
  }

  const list = ls.entries.slice().sort((a, b) => (b.dir - a.dir) || nameCmp(a.name, b.name));
  const rows = list.map(e => {
    const p = joinPath(sub, e.name);
    return h('tr', { class: e.dir ? 'd' : 'f' },
      h('td', { class: 'nm' }, h('a', { href: pageUrl(p), text: e.name + (e.dir ? '/' : '') })),
      h('td', { class: 'sz', text: e.dir ? '' : fmtSize(e.size) }),
      h('td', { class: 'tm', text: fmtTime(e.mtime) }),
      h('td', { class: 'act' }, e.dir ? null : h('a', { class: 'btn-link', href: rawUrl(p) + '?dl=1', download: '', text: 'download' })));
  });
  if (splitPath(sub).length) {
    rows.unshift(h('tr', { class: 'up' }, h('td', { class: 'nm' }, h('a', { href: pageUrl(parentPath(sub)), text: '../' })), h('td'), h('td'), h('td')));
  }
  const body = h('div', { class: 'listwrap' },
    h('table', { class: 'x11 files' }, h('thead', {}, h('tr', {}, h('th', { class: 'nm', text: 'name' }), h('th', { class: 'sz', text: 'size' }), h('th', { class: 'tm', text: 'modified' }), h('th'))),
      h('tbody', {}, rows)),
    list.length ? null : h('div', { class: 'empty dim', text: 'empty folder' }));
  main.className = 'fill';
  main.appendChild(frame([crumbs(ls.root_name, sub, true), h('span', { class: 'spacer' }), shared], body, 'filewin'));
  document.title = (splitPath(sub).length ? baseName(sub) : ls.root_name) + ' · shelf';
  const files = list.filter(e => !e.dir);
  setStatus(list.length - files.length + ' folders, ' + files.length + ' files, ' + fmtSize(files.reduce((a, e) => a + e.size, 0)));
  document.addEventListener('keydown', e => {
    if (e.key === 'Backspace' && splitPath(sub).length && !(e.target instanceof HTMLInputElement)) location.href = pageUrl(parentPath(sub));
  });
})();
