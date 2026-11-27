// Message and comment text: links to cards ([[card:<id>|<title>]]), web links and @mentions, all
// built as DOM nodes (never innerHTML). The composer suggests people after "@" and cards after "#";
// only people who can open the conversation are offered.
import { h, icon } from '/ui.js';

const TOKEN = /\[\[card:([\w-]+)\|([^\]]{1,160})\]\]|(https:\/\/[^\s<>()]+)|@([A-Z][\w'-]+(?: [A-Z][\w'-]+){0,2})/g;

export function renderRich(text, { people = [] } = {}) {
  const names = new Set(people.map((p) => p.name));
  const out = []; let last = 0;
  for (const m of String(text || '').matchAll(TOKEN)) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) out.push(h('a', { class: 'chip-link', href: `#/card/${m[1]}` }, icon('list-checks'), h('span', {}, m[2])));
    else if (m[3]) out.push(h('a', { href: m[3], target: '_blank', rel: 'noopener', class: 'ext-link' }, /docs\.google|drive\.google/.test(m[3]) ? [icon('folder-open'), ' Google Drive file'] : m[3]));
    else if (m[4]) {
      const full = [...names].find((n) => m[4].startsWith(n));
      if (full) { out.push(h('span', { class: 'mention' }, `@${full}`)); if (m[4].length > full.length) out.push(document.createTextNode(m[4].slice(full.length))); } else out.push(document.createTextNode(m[0]));
    }
    last = m.index + m[0].length;
  }
  if (last < String(text || '').length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

/** A textarea with @people and #card suggestions. value() turns "#Card title" into a card link. */
export function composer({ people = [], cards = [], placeholder = 'Write…', rows = 2, label = 'Message', onSubmit } = {}) {
  const ta = h('textarea', { class: 'textarea composer', rows, placeholder, 'aria-label': label, 'aria-autocomplete': 'list' });
  const list = h('ul', { class: 'suggest', role: 'listbox', hidden: true });
  const mentioned = new Map(); const linked = new Map(); // name -> id, title -> id
  let items = []; let active = 0; let trigger = null;
  const close = () => { list.hidden = true; trigger = null; ta.removeAttribute('aria-activedescendant'); };
  function suggest() {
    const before = ta.value.slice(0, ta.selectionStart);
    const m = /(^|\s)([@#])([^\s@#]{0,30}(?: [^\s@#]{0,30})?)$/.exec(before);
    if (!m) return close();
    const q = m[3].toLowerCase();
    trigger = { char: m[2], start: before.length - m[3].length - 1 };
    items = (m[2] === '@' ? people.map((p) => ({ id: p.id, label: p.name })) : cards.map((c) => ({ id: c.id, label: c.title }))).filter((x) => x.label.toLowerCase().includes(q)).slice(0, 6);
    if (!items.length) return close();
    active = 0; draw(); list.hidden = false;
  }
  function draw() {
    list.replaceChildren(...items.map((x, i) => h('li', { role: 'option', id: `sg-${i}-${x.id}`, 'aria-selected': String(i === active), class: 'suggest-item', onmousedown: (e) => { e.preventDefault(); pick(i); } },
      icon(trigger?.char === '@' ? 'user' : 'list-checks'), x.label)));
    ta.setAttribute('aria-activedescendant', `sg-${active}-${items[active]?.id}`);
  }
  function pick(i) {
    const x = items[i]; if (!x || !trigger) return;
    const text = `${trigger.char}${x.label} `;
    ta.value = ta.value.slice(0, trigger.start) + text + ta.value.slice(ta.selectionStart);
    (trigger.char === '@' ? mentioned : linked).set(x.label, x.id);
    const at = trigger.start + text.length; ta.setSelectionRange(at, at); close(); ta.focus();
  }
  ta.addEventListener('input', suggest);
  ta.addEventListener('blur', () => setTimeout(close, 100));
  ta.addEventListener('keydown', (e) => {
    if (!list.hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; return draw(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; return draw(); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pick(active); }
      if (e.key === 'Escape') { e.preventDefault(); return close(); }
    }
    if (e.key === 'Enter' && !e.shiftKey && onSubmit) { e.preventDefault(); onSubmit(); }
  });
  return {
    el: h('div', { class: 'composer-wrap' }, ta, list), textarea: ta,
    value: () => { let v = ta.value; for (const [title, id] of linked) v = v.split(`#${title}`).join(`[[card:${id}|${title}]]`); return v.trim(); },
    mentions: () => [...mentioned].filter(([name]) => ta.value.includes(`@${name}`)).map(([, id]) => id),
    clear: () => { ta.value = ''; mentioned.clear(); linked.clear(); close(); },
    setPeople: (p) => { people = p; }, setCards: (c) => { cards = c; },
  };
}
