// First-visit walkthrough: a few short steps pointing at the parts of the portal people use most.
// Shown once per person (remembered on the server); restart it from Help.
import { h, button, icon } from '/ui.js';

const STEPS = [
  { sel: null, icon: 'party-popper', title: 'Welcome to GB People', text: 'This is GB Advisory’s workspace: your projects, time, requests, reviews and company knowledge. This short tour takes a minute.' },
  { sel: 'a.nav-item[href="#/"]', icon: 'house', title: 'Home', text: 'What needs you now, your week ahead and your projects. Start here every morning.' },
  { sel: 'a.nav-item[href="#/active"]', icon: 'briefcase', title: 'My Work', text: 'Your engagements and their milestones, your monthly timesheet, requests (leave, expenses, gym allowance, letters) and messages.' },
  { sel: 'a.nav-item[href="#/performance"]', icon: 'trending-up', title: 'My Growth', text: 'Your priorities, feedback and results, earlier reviews, training, your profile and CV, and AI examples.' },
  { sel: 'a.nav-item[href="#/team"]', icon: 'building-2', title: 'Company', text: 'Who is who, the library of past work and the toolkit, policies to acknowledge, deliverable checklists, the company profile and onboarding.' },
  { sel: '.ws-switch', icon: 'users', title: 'Your other workspaces', text: 'Approvals, team reviews and the resource calendar are in Manager; People Ops tools are in Admin. Your own tasks stay on Home.' },
  { sel: '.search-trigger', icon: 'search', title: 'Find anything', text: 'Search people, projects, policies and tasks — or press Ctrl K (⌘K on a Mac). Restart this tour from Help in your account menu.' },
];

export function startTour({ api, onDone } = {}) {
  let i = 0; let target = null;
  const overlay = h('div', { class: 'tour-overlay' });
  const spot = h('div', { class: 'tour-spot', 'aria-hidden': 'true' });
  const box = h('div', { class: 'tour-box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-title' });
  const finish = async () => {
    target?.classList.remove('tour-target'); overlay.remove(); spot.remove(); box.remove(); document.removeEventListener('keydown', onKey);
    try { await api?.('/api/me/prefs', { method: 'POST', body: { tour_done: true } }); } catch { /* offline: it will show again next time */ }
    onDone?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') finish(); if (e.key === 'ArrowRight') go(1); if (e.key === 'ArrowLeft') go(-1); };
  const visible = (s) => { if (!s.sel) return true; const el = document.querySelector(s.sel); return el && el.offsetParent !== null; };
  const steps = STEPS.filter(visible);
  function go(d) { const n = i + d; if (n < 0) return; if (n >= steps.length) return finish(); i = n; draw(); }
  function draw() {
    const s = steps[i];
    target?.classList.remove('tour-target');
    target = s.sel ? document.querySelector(s.sel) : null;
    target?.classList.add('tour-target'); target?.scrollIntoView({ block: 'nearest' });
    // spotlight: a hole in the dimmed page around the item being explained
    if (target) { const r = target.getBoundingClientRect(); Object.assign(spot.style, { insetBlockStart: `${r.top - 4}px`, insetInlineStart: `${r.left - 4}px`, inlineSize: `${r.width + 8}px`, blockSize: `${r.height + 8}px` }); spot.classList.remove('none'); }
    else spot.classList.add('none');
    box.replaceChildren(
      h('div', { class: 'tour-icon' }, icon(s.icon, { size: 'lg' })),
      h('h2', { id: 'tour-title' }, s.title), h('p', {}, s.text),
      h('div', { class: 'tour-foot' }, h('span', { class: 'muted' }, `${i + 1} of ${steps.length}`),
        h('div', { class: 'row' }, button('Skip', { variant: 'ghost', size: 'sm', onClick: finish }), i ? button('Back', { size: 'sm', onClick: () => go(-1) }) : null,
          button(i === steps.length - 1 ? 'Finish' : 'Next', { variant: 'primary', size: 'sm', iconName: i === steps.length - 1 ? 'check' : 'arrow-right', onClick: () => go(1) }))));
    // place the card next to the highlighted item, or in the middle
    if (target && innerWidth > 760) {
      const r = target.getBoundingClientRect();
      const top = Math.min(Math.max(16, r.top - 8), innerHeight - box.offsetHeight - 16);
      const left = r.right + 16 + 360 < innerWidth ? r.right + 16 : Math.max(16, r.left - 376);
      box.style.insetBlockStart = `${top}px`; box.style.insetInlineStart = `${left}px`; box.classList.remove('centered');
    } else { box.style.insetBlockStart = ''; box.style.insetInlineStart = ''; box.classList.add('centered'); }
    box.querySelector('.btn-primary')?.focus();
  }
  document.body.append(overlay, spot, box); document.addEventListener('keydown', onKey);
  draw();
}
