/* The file viewer, used by the app (/view/…) and by public links (/s/…).
   src = {
     name,                   file name
     raw,                    url of the content
     siblings,               names in the same folder, or null (prev / next, subtitles)
     rawOf(name),            url of a sibling
     md(),                   Promise of the rendered HTML (markdown only)
   }
   Returns {el, prev, next, destroy}; prev / next are sibling names or null. */
'use strict';

const TEXT_MAX = 4 << 20;
const CSV_MAX = 32 << 20;

/* the first `max` bytes as text; truncated when the file is longer */
async function fetchText(url, max) {
  const r = await fetch(url, { credentials: 'same-origin', headers: { range: 'bytes=0-' + (max - 1) } });
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
  const total = /\/(\d+)$/.exec(r.headers.get('content-range') || '');
  return { text: await r.text(), truncated: !!total && +total[1] > max, etag: r.headers.get('etag') };
}

function viewer(src) {
  const kind = kindOf(src.name);
  const el = h('div', { class: 'viewer viewer-' + kind });
  const blobs = [];
  let media = null, grid = null, rtf = null;

  function note(msg) { return h('div', { class: 'viewer-note dim', text: msg }); }

  if (kind === 'video' || kind === 'audio') {
    media = h(kind, { controls: true, preload: 'metadata', src: src.raw });
    media.addEventListener('error', () => {
      el.appendChild(note('the browser cannot play this file (container or codec); download it instead'));
    });
    if (kind === 'video' && src.siblings) {
      // movie.mkv takes movie.vtt, movie.srt, movie.en.srt, movie.cs.vtt …
      const base = stem(src.name);
      src.siblings.filter(n => (extOf(n) === 'vtt' || extOf(n) === 'srt') && stem(n).startsWith(base)).forEach(n => {
        const lang = stem(n).slice(base.length).replace(/^[.\-_ ]+/, '') || 'subtitles';
        const t = h('track', { kind: 'subtitles', label: lang, srclang: /^[a-z]{2,3}$/i.test(lang) ? lang : null });
        if (extOf(n) === 'vtt') t.src = src.rawOf(n);
        else {
          fetch(src.rawOf(n), { credentials: 'same-origin' }).then(r => r.text()).then(s => {
            const u = URL.createObjectURL(new Blob([srtToVtt(s)], { type: 'text/vtt' }));
            blobs.push(u);
            t.src = u;
          });
        }
        media.appendChild(t);
      });
    }
    el.appendChild(media);
  } else if (kind === 'image') {
    const img = h('img', { src: src.raw, alt: src.name, title: 'click: actual size / fit' });
    img.addEventListener('click', () => el.classList.toggle('actual'));
    el.appendChild(img);
  } else if (kind === 'pdf') {
    el.appendChild(h('iframe', { src: src.raw, title: src.name }));
  } else if (kind === 'md') {
    const body = h('div', { class: 'md-body' }, note('rendering…'));
    el.appendChild(body);
    src.md().then(html => { body.innerHTML = html; }, e => { clear(body).appendChild(note(e.message)); });
  } else if (kind === 'csv' && typeof CsvGrid !== 'undefined') {
    const host = h('div', { class: 'csv-host' }, note('loading…'));
    el.appendChild(host);
    fetchText(src.raw, CSV_MAX).then(r => {
      if (r.truncated) { clear(host).appendChild(note('too big for the table view (over ' + fmtSize(CSV_MAX) + '); download it')); return; }
      grid = new CsvGrid(host, r.text, { readonly: true, name: src.name });
    }, e => { clear(host).appendChild(note(e.message)); });
  } else if (kind === 'sheet' && typeof SheetGrid !== 'undefined') {
    const host = h('div', { class: 'csv-host' }, note('loading…'));
    el.appendChild(host);
    fetch(src.raw, { credentials: 'same-origin' })
      .then(r => {
        if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
        if (+r.headers.get('content-length') > CSV_MAX) throw new Error('too big for the table view (over ' + fmtSize(CSV_MAX) + '); download it');
        return r.arrayBuffer();
      })
      .then(b => SheetGrid.open(host, new Uint8Array(b), { readonly: true }))
      .then(g => { grid = g; }, e => { clear(host).appendChild(note(e.message)); });
  } else if (kind === 'rtf' && typeof RtfEditor !== 'undefined') {
    const host = h('div', { class: 'rtf-view' }, note('loading…'));
    el.appendChild(host);
    fetch(src.raw, { credentials: 'same-origin' })
      .then(r => { if (!r.ok) throw new Error(r.status + ' ' + r.statusText); return r.arrayBuffer(); })
      .then(b => { rtf = new RtfEditor(host, new Uint8Array(b), { readonly: true }); }, e => { clear(host).appendChild(note(e.message)); });
  } else if (kind === 'text' || kind === 'csv' || kind === 'rtf') {
    const pre = h('pre', { class: 'text-view' }, note('loading…'));
    el.appendChild(pre);
    fetch(src.raw, { credentials: 'same-origin', headers: { range: 'bytes=0-' + (TEXT_MAX - 1) } })
      .then(r => { if (!r.ok) throw new Error(r.status + ' ' + r.statusText); return r.text(); })
      .then(t => {
        pre.textContent = t;
        if (t.length >= TEXT_MAX - 4) el.appendChild(note('only the first ' + fmtSize(TEXT_MAX) + ' are shown'));
      }, e => { clear(pre).appendChild(note(e.message)); });
  } else {
    el.appendChild(note('no preview for this kind of file'));
  }

  // prev / next among files of the same kind
  let prev = null, next = null;
  if (src.siblings && (kind === 'image' || kind === 'video' || kind === 'audio')) {
    const same = src.siblings.filter(n => kindOf(n) === kind).sort(nameCmp);
    const i = same.indexOf(src.name);
    if (i > 0) prev = same[i - 1];
    if (i >= 0 && i < same.length - 1) next = same[i + 1];
  }

  return {
    el, prev, next,
    destroy() {
      if (media) { media.pause(); media.removeAttribute('src'); media.load(); }
      blobs.forEach(u => URL.revokeObjectURL(u));
      if (grid) grid.destroy();
      if (rtf) rtf.destroy();
    },
  };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
function nameCmp(a, b) { return collator.compare(a, b); }
