/**
 * ui.js — everything outside the 3D view: top bar, "Find my house", Overview / Houses / Activity
 * tabs, the detail card with its "Where to plug in" block, deep links (#6020), edit mode (code
 * unlock, optimistic writes), checklist, toasts, failure banner and the phone bottom sheet.
 * Database-sourced strings are only ever set via textContent.
 */
import {
  STAGES, FIELD_LABELS, RUN_LABELS, nodeStatus, statusText, positionText, progress, matchesQuery,
  findNodes, nodeIdForKey, plugInfo, boxText,
} from './model.js';

const CODE_KEY = 'lightshow.editCode';
const NAME_KEY = 'lightshow.name';
const MODE_KEY = 'lightshow.mode';
const NOTE_MAX = 280;
const TOAST_MS = 4500;

/**
 * Bottom-sheet layout: narrow screens, except short landscape ones (phones on their side),
 * which get a side panel — a sheet there would leave a sliver of map. The aspect-ratio test
 * keeps a portrait phone on the sheet while an on-screen keyboard shortens the viewport.
 * Must match the sheet media query in style.css.
 */
const SHEET = window.matchMedia('(max-width: 767px) and (min-height: 481px), (max-width: 767px) and (max-aspect-ratio: 4/3)');

/** Messages for the unlock dialog. */
const UNLOCK_ERRORS = {
  bad_code: 'Wrong code.',
  locked: 'Too many attempts. Try again in 15 minutes.',
  network: 'Can’t reach the server.',
  timeout: 'Can’t reach the server.',
};

/** Reasons shown in a toast when a write fails. */
const WRITE_ERRORS = {
  locked: 'too many wrong codes recently. Try again in 15 minutes.',
  network: 'can’t reach the server.',
  timeout: 'the server took too long to answer.',
  not_found: 'that item no longer exists.',
  empty_label: 'type a label first.',
  too_many_tasks: 'the checklist is full.',
  bad_parent: 'sub-items can’t have their own sub-items.',
  bad_field: 'the server rejected that change.',
  bad_value: 'the server rejected that change.',
};

// ------------------------------------------------------------------ small helpers

/** Creates an element. String children become text nodes (never parsed as HTML). */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  el.append(...children.filter((c) => c != null && c !== false));
  return el;
}

const $ = (id) => document.getElementById(id);

/** Creates an SVG element from attributes (no markup is parsed). */
function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) if (value != null) el.setAttribute(key, String(value));
  el.append(...children);
  return el;
}

/**
 * The connection box as seen facing its ports: the OUT socket on the left, IN on the right, each
 * labelled, with its cable hanging below (the IN arrow points up into the box, the OUT arrow
 * away from it) and LEFT / RIGHT written beside the cables. With `outEmpty` (end of the run) the
 * OUT socket is dashed and has no cable.
 */
function plugDiagram(outEmpty) {
  const port = (x, kind, side, empty) => svg('g', { class: `diagram-port diagram-${kind}` },
    svg('text', { x, y: 27, 'text-anchor': 'middle', class: 'diagram-label' }, kind.toUpperCase()),
    svg('path', {
      d: `M${x - 24} 32h48v19h-14v5h-20v-5h-14z`, class: 'diagram-socket', 'stroke-dasharray': empty ? '5 4' : null,
    }),
    svg('path', { d: Array.from({ length: 8 }, (_, i) => `M${x - 14 + 4 * i} 35v5`).join(''), class: 'diagram-pins' }),
    // The side word sits outboard of the cable: LEFT left of the left port, RIGHT right of the right one.
    svg('text', {
      x: side === 'left' ? x - 18 : x + 18, y: 77, 'text-anchor': side === 'left' ? 'end' : 'start', class: 'diagram-side',
    }, side.toUpperCase()),
    ...(empty ? [] : [
      svg('path', { d: `M${x} 58V82`, class: 'diagram-cable' }),
      svg('path', { d: kind === 'in' ? `M${x - 9} 77h18l-9-13z` : `M${x - 9} 64h18l-9 13z`, class: 'diagram-arrow' }),
    ]));
  return svg('svg', { class: 'plug-diagram', viewBox: '0 0 320 84', 'aria-hidden': 'true', focusable: 'false' },
    svg('rect', { x: 6, y: 4, width: 308, height: 53, rx: 12, class: 'diagram-box' }),
    port(80, 'out', 'left', outEmpty),
    port(240, 'in', 'right', false));
}

function storage(kind) {
  return {
    get(key) {
      try { return window[kind].getItem(key); } catch { return null; }
    },
    set(key, value) {
      try { window[kind].setItem(key, value); } catch { /* storage unavailable: keep in memory only */ }
    },
    remove(key) {
      try { window[kind].removeItem(key); } catch { /* storage unavailable */ }
    },
  };
}
const local = storage('localStorage');
const session = storage('sessionStorage');

function timeAgo(when, now) {
  const t = typeof when === 'number' ? when : Date.parse(when);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const truncate = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const yesNo = (v) => (v === 'true' || v === true ? 'yes' : v === 'false' || v === false ? 'no' : String(v ?? '—'));

// ------------------------------------------------------------------ UI

/**
 * @param {{model:object, scene:object, api:object, refresh:() => void}} deps
 * @returns {{select(id|null):void, setState(state, startedAt:number):void, setLoadError(err):void}}
 */
export function createUI({ model, scene, api, refresh }) {
  const st = {
    nodes: new Map(),          // id → server node
    tasks: [],
    log: [],
    fetchedAt: 0,
    skew: 0,                   // server clock − client clock (ms)
    loadError: null,
    pending: new Map(),        // id → {field: value} optimistic overrides
    inflight: new Set(),       // `${id}|${field}` writes in flight
    taskPending: new Map(),    // task id → done
    taskDeleting: new Set(),
    lastWriteAt: 0,
    selected: null,
    editCode: session.get(CODE_KEY),
    name: local.get(NAME_KEY) ?? '',
  };

  const now = () => Date.now() + st.skew;
  const effective = (id) => {
    const base = st.nodes.get(id);
    return base && st.pending.has(id) ? { ...base, ...st.pending.get(id) } : base;
  };
  const hasData = () => st.fetchedAt > 0;
  /** "Box 12" for a node that has a box right now (an island or a participating house), else ''. */
  const boxOf = (id) => {
    const node = model.nodes.get(id);
    const hasBox = node.kind === 'island' || (effective(id)?.participating ?? node.defaultParticipating);
    return hasBox ? boxText(node) : '';
  };
  /** A neighbor's name with its box: "6022 (box 13)", "6024 (cable start · box 12)". */
  const withBox = (id) => {
    const notes = [id === model.homeId ? 'cable start' : '', boxOf(id).toLowerCase()].filter(Boolean);
    return { tag: model.nodes.get(id).tag, note: notes.length ? `(${notes.join(' · ')})` : '' };
  };
  /** Text for an empty list: `empty` once data is in, else loading / offline. */
  const placeholder = (empty) => (hasData() ? empty : st.loadError ? 'Unavailable while offline.' : 'Loading…');

  const toasts = createToasts($('toasts'));
  const sheet = createSheet($('panel'), $('sheet-handle'), () => syncInset());
  // Without a 3D map there is nothing to reveal behind the sheet: keep it open.
  if (!scene.available) sheet.expand();
  const topbar = createTopbar();
  const overview = createOverview();
  const houseList = createHouseList();
  const activity = createActivity();
  const detail = createDetail();
  const editor = createEditor();
  initFind();
  initTabs();
  initSceneTools();
  initModeToggle();
  initInfo();

  syncInset();
  // The overlay grows when the offline banner shows; reframe the overview below it.
  new ResizeObserver(() => syncInset()).observe(document.querySelector('.scene-overlay'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && st.selected && !document.querySelector('dialog[open]')) select(null);
  });
  setInterval(() => { topbar.render(); activity.render(); detail.update(); }, 30000);
  renderAll();

  // Deep links: "#6020" or "#glade-island" opens that card, on load and when the hash changes.
  window.addEventListener('hashchange', () => select(hashNode(), { from: 'link' }));
  if (hashNode()) select(hashNode(), { from: 'link' });

  // ---------------------------------------------------------------- rendering

  /**
   * Tells the scene which parts of the 3D view the UI covers, so the overview (and a focused
   * house) is framed between them: the floating overlay (view buttons, offline banner) at the
   * top and, on phones, the bottom sheet at rest (its peek, or its height while a card shows).
   */
  function syncInset() {
    const overlay = document.querySelector('.scene-overlay').getBoundingClientRect();
    const top = Math.max(0, overlay.bottom - $('scene').getBoundingClientRect().top);
    scene.setViewInset(SHEET.matches ? sheet.viewInset() : 0, top);
  }

  function renderAll() {
    topbar.render();
    overview.render();
    houseList.update();
    activity.render();
    detail.update();
    editor.render();
    const states = new Map();
    for (const id of st.nodes.keys()) states.set(id, effective(id));
    scene.applyState(states);
    syncScenePlug();
  }

  /**
   * Opens a node's card (null closes it). `from` is what asked: 'scene' (a tap on the map),
   * 'list', 'nav' (a neighbor link in the card), 'find' or 'link' (the address bar's hash).
   */
  function select(id, { from = 'scene' } = {}) {
    const next = id && model.nodes.has(id) ? id : null;
    const prev = st.selected;
    st.selected = next;
    scene.select(next);
    syncScenePlug();
    if (next) scene.focus(next);
    if (next !== prev) detail.open(next, { focusTitle: ['list', 'nav', 'find'].includes(from), previous: prev });
    houseList.markSelected(next);
    syncHash(next);
    // On phones the sheet rises until the whole "Where to plug in" block shows, or on a short
    // screen at least its ports (a neighbor link leaves a sheet the viewer expanded as is).
    // Without a 3D map it stays expanded.
    if (scene.available) sheet.showDetail(next && detail.plugBlock(), { core: '.ports', keepExpanded: from === 'nav' });
  }

  /**
   * The selected box's IN and OUT cables, emphasized and labelled on the map. Held back while the
   * first fetch is in flight (a live opt-out can move them); offline, the default list applies.
   */
  function syncScenePlug() {
    const id = st.selected;
    const info = id && (hasData() || st.loadError) && plugInfo(model, id, effective);
    if (info?.kind !== 'box') {
      scene.showPlug([]);
      return;
    }
    const tag = (nodeId) => {
      const box = boxOf(nodeId).toLowerCase();
      return `${model.nodes.get(nodeId).tag}${box ? ` · ${box}` : ''}`;
    };
    const paths = [{ port: 'in', ids: [info.in.id, ...info.in.passes, id], name: tag(info.in.id) }];
    if (!info.out.end) paths.push({ port: 'out', ids: [id, ...info.out.passes, info.out.id], name: tag(info.out.id) });
    scene.showPlug(paths);
  }

  // ---------------------------------------------------------------- deep links

  /** Node named by the address bar's hash, or null. */
  function hashNode() {
    try {
      return nodeIdForKey(model, decodeURIComponent(window.location.hash.slice(1)));
    } catch {
      return null; // malformed escape in the hash
    }
  }

  /** Keeps the hash on the open card (#6020) so the address can be shared; adds no history. */
  function syncHash(id) {
    const hash = id ? `#${model.nodes.get(id).key}` : '';
    const { location } = window;
    if (location.hash !== hash) window.history.replaceState(null, '', hash || location.pathname + location.search);
  }

  /** Shareable address of a node's card. */
  function linkTo(node) {
    return `${window.location.origin}${window.location.pathname}#${node.key}`;
  }

  // ---------------------------------------------------------------- top bar + banner

  function createTopbar() {
    const progressEl = $('progress');
    const freshEl = $('freshness');
    const banner = $('banner');
    return {
      render() {
        const cable = progress(model, model.cableIds, effective);
        const all = progress(model, model.allIds, effective);
        const n = (v) => (hasData() ? v : '–');
        progressEl.textContent = `Cable ${n(cable.cable)}/${cable.total} · `
          + `Boxes ${n(all.box)}/${all.participating} · Lights ${n(all.lights)}/${all.participating}`;

        if (st.fetchedAt) {
          freshEl.textContent = `Updated ${timeAgo(st.fetchedAt, Date.now())}${st.loadError ? ' · retrying' : ''}`;
        } else {
          freshEl.textContent = st.loadError ? 'Offline · retrying' : 'Loading…';
        }
        freshEl.dataset.state = st.loadError ? 'error' : st.fetchedAt ? 'ok' : 'loading';

        banner.hidden = !st.loadError;
        banner.textContent = hasData()
          ? `Can’t reach the tracker database — showing data from ${timeAgo(st.fetchedAt, Date.now())}. Retrying…`
          : 'Can’t reach the tracker database — showing layout only. Retrying…';
      },
    };
  }

  // ---------------------------------------------------------------- overview tab

  function createOverview() {
    const { chains } = model.data;
    const first = (ids) => model.nodes.get(ids[0]).tag;
    const last = (ids) => model.nodes.get(ids[ids.length - 1]).tag;
    const rows = [
      { key: 'right', title: RUN_LABELS.right, ids: chains.right.slice(1) },
      { key: 'left', title: RUN_LABELS.left, ids: chains.left.slice(1) },
      { key: 'islands', title: 'Islands', ids: model.islandIds },
    ].map((row) => {
      const sub = row.key === 'islands'
        ? row.ids.map((id) => model.nodes.get(id).tag).join(' · ')
        : `${row.ids.length} stops · ${first(row.ids)} → ${last(row.ids)}`;
      const meters = STAGES.map((stage) => {
        const fill = h('span', { class: 'meter-fill' });
        const value = h('span', { class: 'meter-value' });
        const bar = h('span', {
          class: 'meter-bar', role: 'progressbar', 'aria-valuemin': 0,
          'aria-label': `${row.title}: ${stage.label}`,
        }, fill);
        return { stage, fill, value, bar, el: h('div', { class: 'meter' }, h('span', { class: 'meter-label' }, stage.short), bar, value) };
      });
      const el = h('div', { class: 'run-row', dataset: { run: row.key } },
        h('div', { class: 'run-head' },
          h('span', { class: 'run-dot', 'aria-hidden': 'true' }),
          h('h3', { class: 'run-title' }, row.title),
          h('span', { class: 'run-sub' }, sub)),
        ...meters.map((m) => m.el));
      return { ...row, meters, el };
    });
    $('run-progress').replaceChildren(...rows.map((r) => r.el));

    const taskList = $('tasks');
    const taskRows = new Map();

    function renderTasks() {
      const tasks = st.tasks
        .filter((t) => !st.taskDeleting.has(t.id) && !st.taskDeleting.has(t.parent_id))
        .map((t) => (st.taskPending.has(t.id) ? { ...t, done: st.taskPending.get(t.id) } : t));
      const keep = new Set(tasks.map((t) => t.id));
      for (const [id, row] of taskRows) {
        if (!keep.has(id)) { row.el.remove(); taskRows.delete(id); }
      }
      // Sub-items sit under their parent. One whose parent is missing shows at the top level.
      const top = tasks.filter((t) => !keep.has(t.parent_id));
      placeRows(taskList, top, (task, row) => {
        const subs = tasks.filter((t) => t.parent_id === task.id);
        placeRows(row.subs, subs);
        row.subs.hidden = subs.length === 0;
        row.count.hidden = subs.length === 0;
        row.count.textContent = `${subs.filter((t) => t.done).length}/${subs.length}`;
        row.add.hidden = !st.editCode;
        row.add.setAttribute('aria-label', `Add a sub-item under “${task.label}”`);
      });
      const empty = $('tasks-empty');
      empty.hidden = tasks.length > 0;
      empty.textContent = placeholder('No checklist items yet.');
    }

    /** Puts one row per task into `list`, in order, reusing rows by task id. */
    function placeRows(list, tasks, extra) {
      tasks.forEach((task, i) => {
        let row = taskRows.get(task.id);
        if (!row) {
          row = buildTaskRow(task.id);
          taskRows.set(task.id, row);
        }
        row.label.textContent = task.label;
        row.box.checked = Boolean(task.done);
        row.box.disabled = !st.editCode || st.taskPending.has(task.id);
        row.del.hidden = !st.editCode;
        row.del.setAttribute('aria-label', `Delete “${task.label}”`);
        row.el.classList.toggle('is-done', Boolean(task.done));
        extra?.(task, row);
        if (list.children[i] !== row.el) list.insertBefore(row.el, list.children[i] ?? null);
      });
    }

    /** A checklist row. `count`, `add` and `subs` stay hidden unless the row is a top-level item. */
    function buildTaskRow(id) {
      const box = h('input', { type: 'checkbox', onchange: (e) => toggleTask(id, e.target.checked) });
      const label = h('span', { class: 'task-label' });
      const count = h('span', { class: 'task-count', hidden: true });
      const add = h('button', { type: 'button', class: 'icon-btn task-sub-add', hidden: true, onclick: () => addSubTask(id) }, '+');
      const del = h('button', { type: 'button', class: 'icon-btn task-delete', onclick: () => deleteTask(id) }, '✕');
      const subs = h('ul', { class: 'tasks task-subs', hidden: true });
      return {
        box, label, count, add, del, subs,
        el: h('li', { class: 'task' },
          h('div', { class: 'task-row' }, h('label', { class: 'task-check' }, box, label, count), add, del),
          subs),
      };
    }

    return {
      render() {
        for (const row of rows) {
          const p = progress(model, row.ids, effective);
          const values = { cable_run: [p.cable, p.total], box_connected: [p.box, p.participating], lights_up: [p.lights, p.participating] };
          for (const m of row.meters) {
            const [done, total] = values[m.stage.key];
            const shown = hasData() ? done : 0;
            m.fill.style.width = `${total ? (100 * shown) / total : 0}%`;
            m.value.textContent = `${hasData() ? done : '–'}/${total}`;
            m.bar.setAttribute('aria-valuemax', total);
            m.bar.setAttribute('aria-valuenow', shown);
          }
        }
        renderTasks();
      },
    };
  }

  // ---------------------------------------------------------------- houses tab

  function createHouseList() {
    const container = $('house-list');
    const search = $('search');
    const rows = new Map();
    const groups = model.groups.map((group) => {
      const count = h('span', { class: 'list-group-count' });
      const list = h('ul', { class: 'rows' });
      const el = h('section', { class: 'list-group', dataset: { group: group.key } },
        h('h3', { class: 'list-group-title' }, group.label, count), list);
      for (const id of group.ids) {
        const node = model.nodes.get(id);
        const chips = STAGES.map((stage) => h('span', { class: 'chip', dataset: { stage: stage.key } }));
        const sub = h('span', { class: 'row-sub' });
        const button = h('button', {
          type: 'button', class: 'row', dataset: { id }, onclick: () => select(id, { from: 'list' }),
        },
          h('span', { class: 'row-stop', 'aria-hidden': 'true' }, node.run === 'start' ? '★' : node.run ? String(node.stop) : '–'),
          h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, node.short), sub),
          h('span', { class: 'row-stages', 'aria-hidden': 'true' }, ...chips));
        const li = h('li', {}, button);
        list.append(li);
        rows.set(id, { node, li, button, chips, sub });
      }
      return { ...group, el, count };
    });
    container.replaceChildren(...groups.map((g) => g.el));
    search.addEventListener('input', filter);

    function filter() {
      const q = search.value.trim().toLowerCase();
      let any = false;
      for (const group of groups) {
        let visible = 0;
        for (const id of group.ids) {
          const row = rows.get(id);
          const show = !q || matchesQuery(row.node.search, q);
          row.li.hidden = !show;
          if (show) visible += 1;
        }
        group.el.hidden = visible === 0;
        group.count.textContent = q ? `${visible} of ${group.ids.length}` : String(group.ids.length);
        any ||= visible > 0;
      }
      $('house-empty').hidden = any;
    }

    filter();
    return {
      update() {
        for (const [id, row] of rows) {
          const s = effective(id);
          const status = nodeStatus(s);
          const out = status === 'out';
          row.button.dataset.status = status;
          row.chips.forEach((chip, i) => {
            const stage = STAGES[i];
            const on = Boolean(s?.[stage.key]);
            chip.hidden = out && stage.key !== 'cable_run';
            chip.dataset.on = s ? String(on) : 'unknown';
            chip.textContent = `${s ? (on ? '✓' : '○') : '?'} ${stage.short}`;
          });
          const note = s?.note?.trim();
          const box = boxOf(id);
          row.sub.textContent = [box, out ? 'Opted out — cable passes by' : note ? truncate(note, 60) : '']
            .filter(Boolean).join(' · ');
          row.sub.hidden = !row.sub.textContent;
          const stages = !s ? 'Status unknown'
            : out ? `Opted out. Cable run: ${yesNo(s.cable_run)}`
              : STAGES.map((stage) => `${stage.label}: ${yesNo(s[stage.key])}`).join('. ');
          row.button.setAttribute('aria-label',
            `${row.node.title}. ${box ? `${box}. ` : ''}${positionText(row.node)}. ${stages}.`);
        }
      },
      markSelected(id) {
        for (const [rowId, row] of rows) {
          if (rowId === id) row.button.setAttribute('aria-current', 'true');
          else row.button.removeAttribute('aria-current');
        }
      },
      focusRow(id) {
        rows.get(id)?.button.focus({ preventScroll: false });
      },
    };
  }

  // ---------------------------------------------------------------- find my house

  /**
   * "Find my house": a combobox pinned at the top of the panel. Typing lists matches; arrow keys
   * + Enter or a tap opens one, Enter on an exact house number jumps straight to it, and Escape
   * clears the field (a second Escape closes the open card).
   */
  function initFind() {
    const root = $('find');
    const input = $('find-input');
    const results = $('find-results');
    const list = $('find-list');
    const empty = $('find-empty');
    let matches = [];
    let active = -1;

    function setActive(i) {
      active = i;
      [...list.children].forEach((el, k) => el.setAttribute('aria-selected', String(k === i)));
      const option = list.children[i];
      if (option) {
        input.setAttribute('aria-activedescendant', option.id);
        option.scrollIntoView({ block: 'nearest' });
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    function render() {
      const q = input.value.trim();
      matches = findNodes(model, q);
      list.replaceChildren(...matches.map((node) => h('li', {
        id: `find-${node.id}`, class: 'find-option', role: 'option', 'aria-selected': 'false', dataset: { id: node.id },
      },
      h('span', { class: 'find-main' }, node.kind === 'house' ? node.key : node.tag),
      h('span', { class: 'find-sub' },
        [node.kind === 'house' ? node.geo.street : positionText(node), boxOf(node.id)].filter(Boolean).join(' · ')))));
      list.hidden = !matches.length;
      empty.textContent = q && !matches.length ? `No house or island matches “${q}”.` : '';
      empty.hidden = !empty.textContent;
      results.hidden = !q;
      input.setAttribute('aria-expanded', String(matches.length > 0));
      setActive(-1);
    }

    function close() {
      results.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      setActive(-1);
    }

    function choose(id) {
      input.value = '';
      render();
      select(id, { from: 'find' });
    }

    input.addEventListener('input', render);
    input.addEventListener('focus', () => { if (input.value.trim()) render(); });
    input.addEventListener('keydown', (e) => {
      const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
      if (step && matches.length) {
        e.preventDefault();
        if (results.hidden) render();
        setActive(active < 0 ? (step > 0 ? 0 : matches.length - 1) : (active + step + matches.length) % matches.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const q = input.value.trim().toLowerCase();
        const pick = matches[active] ?? (matches[0]?.key === q || matches.length === 1 ? matches[0] : null);
        if (pick) choose(pick.id);
      } else if (e.key === 'Escape' && input.value) {
        e.preventDefault();
        e.stopPropagation();
        input.value = '';
        render();
      }
    });
    // Pressing an option keeps focus in the field; the click then opens it.
    list.addEventListener('mousedown', (e) => e.preventDefault());
    list.addEventListener('click', (e) => {
      const option = e.target.closest('[role="option"]');
      if (option) choose(option.dataset.id);
    });
    root.addEventListener('focusout', (e) => {
      if (!root.contains(e.relatedTarget)) close();
    });
  }

  // ---------------------------------------------------------------- activity tab

  function createActivity() {
    const list = $('activity');

    function describe(entry) {
      const target = String(entry.target ?? '');
      if (target.startsWith('task:')) {
        const change = entry.field === 'added' ? 'added'
          : entry.field === 'deleted' ? 'removed' : `Done → ${yesNo(entry.new)}`;
        return [`Checklist “${truncate(target.slice(5), 48)}”`, change];
      }
      const node = model.nodes.get(target);
      const what = node ? node.short : target;
      if (entry.field === 'note') {
        return [what, entry.new ? `Note → “${truncate(String(entry.new), 60)}”` : 'Note cleared'];
      }
      return [what, `${FIELD_LABELS[entry.field] ?? entry.field} → ${yesNo(entry.new)}`];
    }

    return {
      render() {
        const t = now();
        list.replaceChildren(...st.log.map((entry) => {
          const [what, change] = describe(entry);
          const at = Date.parse(entry.at);
          return h('li', { class: 'activity-item' },
            h('span', { class: 'activity-who' }, entry.by || 'Someone'),
            ` · ${what} · ${change} · `,
            h('time', {
              datetime: entry.at, title: Number.isFinite(at) ? new Date(at).toLocaleString() : null,
            }, timeAgo(entry.at, t)));
        }));
        const empty = $('activity-empty');
        empty.hidden = st.log.length > 0;
        empty.textContent = placeholder('No edits yet.');
      },
    };
  }

  // ---------------------------------------------------------------- detail card

  function createDetail() {
    const section = $('detail');
    const tabsView = $('tabs-view');
    const body = $('panel-body');
    let view = null;          // elements of the open card
    let tabsScroll = 0;

    function open(id, { focusTitle, previous }) {
      if (!id) {
        const hadFocus = section.contains(document.activeElement);
        section.hidden = true;
        section.replaceChildren();
        tabsView.hidden = false;
        view = null;
        body.scrollTop = tabsScroll;
        if (hadFocus && previous) houseList.focusRow(previous);
        return;
      }
      if (!view) tabsScroll = body.scrollTop;
      view = build(model.nodes.get(id));
      section.hidden = false;
      tabsView.hidden = true;
      body.scrollTop = 0;
      update();
      if (focusTitle) view.title.focus({ preventScroll: true });
    }

    function build(node) {
      const v = { node, switches: new Map(), noteDirty: false, noteSaving: false, plugKey: '' };
      v.title = h('h2', { class: 'detail-title', id: 'detail-title', tabindex: '-1' }, node.title);
      v.box = h('p', { class: 'detail-box', hidden: true });
      v.plug = h('section', { class: 'plug', 'aria-labelledby': 'plug-title' });
      v.badge = h('p', { class: 'status-badge' });
      v.switchBox = h('div', { class: 'switches', role: 'group', 'aria-label': 'Setup stages' });
      v.hint = h('p', { class: 'hint' }, 'Tap Edit to make changes');
      v.noteText = h('p', { class: 'note-text' });
      v.noteInput = h('textarea', {
        id: 'note-input', class: 'note-input', maxlength: NOTE_MAX, rows: 3,
        placeholder: 'e.g. needs a longer cable run past the driveway',
        oninput: () => {
          v.noteDirty = v.noteInput.value !== (effective(node.id)?.note ?? '');
          updateNote();
        },
      });
      v.counter = h('span', { class: 'note-counter', 'aria-live': 'polite' });
      v.noteSave = h('button', { type: 'button', class: 'btn btn-gold btn-small', onclick: () => saveNote(node.id) }, 'Save note');
      v.noteEdit = h('div', { class: 'note-edit' }, v.noteInput, h('div', { class: 'note-foot' }, v.counter, v.noteSave));
      v.updated = h('p', { class: 'detail-updated' });
      v.copyUrl = h('input', { type: 'text', class: 'copy-url', readonly: true, 'aria-label': 'Link to this card' });
      v.copyFallback = h('p', { class: 'copy-fallback', hidden: true }, 'Copy this link:', v.copyUrl);

      // Neighbors along the run; update() marks the ones without a box, so this row never seems
      // to contradict the plug block when the cable skips an opted-out house.
      v.nav = node.links.map((link) => ({
        link,
        target: model.nodes.get(link.id),
        button: h('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: () => select(link.id, { from: 'nav' }) }),
        label: '',
      }));
      const links = v.nav.map((item) => item.button);

      section.replaceChildren(...[
        h('div', { class: 'detail-head' },
          h('div', { class: 'detail-heading' }, h('p', { class: 'detail-eyebrow' }, positionText(node)), v.title, v.box),
          h('button', {
            type: 'button', class: 'icon-btn', 'aria-label': 'Close details', onclick: () => select(null),
          }, '✕')),
        v.plug,
        node.kind === 'island'
          ? h('p', { class: 'detail-desc' }, node.geo.name === node.title ? node.geo.desc : `${node.geo.name}. ${node.geo.desc}`)
          : null,
        v.badge,
        h('div', { class: 'detail-actions' },
          links.length ? h('nav', { class: 'run-nav', 'aria-label': 'Neighbors on the cable run' }, ...links) : null,
          h('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: () => copyLink(v) },
            `Copy link to this ${node.kind === 'island' ? 'island' : 'house'}`)),
        v.copyFallback,
        v.hint,
        v.switchBox,
        h('div', { class: 'note' }, h('h3', { class: 'note-title' }, h('label', { for: 'note-input' }, 'Note')), v.noteText, v.noteEdit),
        v.updated,
      ].filter(Boolean));
      return v;
    }

    /** A node's name in plug instructions, with its box and whether it is the cable start. */
    const plugName = (id) => {
      const { tag, note } = withBox(id);
      return note ? `${tag} ${note}` : tag;
    };

    /** A neighbor in the plug block: tapping it opens that node's card. */
    const nodeLink = (id) => {
      const { tag, note } = withBox(id);
      return h('button', {
        type: 'button', class: 'node-link', dataset: { id }, onclick: () => select(id, { from: 'nav' }),
      }, tag, ...(note ? [' ', h('span', { class: 'node-link-note' }, note)] : []));
    };

    /**
     * One port's column under the diagram (whose OUT / IN and LEFT / RIGHT it sits under): where
     * its cable goes, and any detours. Screen readers, which skip the diagram, get the port named.
     */
    function portInfo(kind, side, link, cable) {
      const extra = [
        cable.passes?.length ? `passes ${cable.passes.map((id) => model.nodes.get(id).tag).join(', ')} (no box)` : '',
        cable.crossing ? 'crosses the street' : '',
      ].filter(Boolean).join(' · ');
      return h('div', { class: 'port', dataset: { port: kind } },
        h('p', { class: 'port-link' }, h('span', { class: 'sr-only' }, `${kind.toUpperCase()}, ${side} port: `), ...link),
        extra ? h('p', { class: 'port-extra' }, extra) : null);
    }

    /** "Where to plug in" footnote while the live sign-up list is loading or unreachable. */
    function plugNote() {
      if (hasData()) return null;
      return h('p', { class: 'plug-note', dataset: { state: st.loadError ? 'error' : 'loading' } }, st.loadError
        ? 'Based on the default sign-up list — live data isn’t available right now.'
        : 'Checking the live sign-up list…');
    }

    /** Contents of the "Where to plug in" block for `plugInfo()`'s answer. */
    function plugContent(info) {
      const title = h('h3', { class: 'plug-title', id: 'plug-title' }, 'Where to plug in');
      const note = plugNote();
      if (info.kind !== 'box') {
        const says = {
          start: () => ['Cable start — both runs begin here.'],
          offrun: () => ['Not on a cable run — no box.'],
          passby: () => (info.passTo
            ? ['No box here — the cable passes by from ', nodeLink(info.passFrom), ' to ', nodeLink(info.passTo), '.']
            : ['No box here — the cable ends at ', nodeLink(info.passFrom), ', before this house.']),
        }[info.kind]();
        return [h('div', { class: 'plug-head' }, title), h('p', { class: 'plug-says' }, ...says), note];
      }
      const { in: from, out: to } = info;
      return [
        h('div', { class: 'plug-head' }, title, h('span', { class: 'plug-facing' }, 'as you face the ports')),
        plugDiagram(Boolean(to.end)),
        h('div', { class: 'ports' },
          portInfo('out', 'left', to.end
            ? [h('strong', { class: 'port-empty' }, 'Leave empty'), h('span', { class: 'port-what' }, 'end of the run')]
            : [h('span', { class: 'port-what' }, 'cable to'), nodeLink(to.id)], to),
          portInfo('in', 'right', [h('span', { class: 'port-what' }, 'cable from'), nodeLink(from.id)], from)),
        h('p', { class: 'plug-sentence' }, to.end
          ? `Plug the cable from ${plugName(from.id)} into IN (right). Leave OUT (left) empty — end of the run.`
          : `Plug the cable from ${plugName(from.id)} into IN (right) and the cable to ${plugName(to.id)} into OUT (left).`),
        note,
      ];
    }

    async function copyLink(v) {
      const url = linkTo(v.node);
      try {
        await navigator.clipboard.writeText(url);
        toasts.show(`Link to ${v.node.short} copied.`);
      } catch {
        // No clipboard here (older browser, insecure page, permission denied): offer it to copy by hand.
        v.copyUrl.value = url;
        v.copyFallback.hidden = false;
        v.copyUrl.select();
      }
    }

    function fieldsFor(node, status) {
      const stages = status === 'out' ? ['cable_run'] : STAGES.map((s) => s.key);
      return node.kind === 'house' ? [...stages, 'participating'] : stages;
    }

    function syncSwitches(fields) {
      const current = [...view.switchBox.children].map((el) => el.dataset.field);
      if (current.join() === fields.join()) return;
      const focused = document.activeElement?.dataset?.field;
      view.switches.clear();
      view.switchBox.replaceChildren(...fields.map((field) => {
        const state = h('span', { class: 'switch-state' });
        const btn = h('button', {
          type: 'button', role: 'switch', class: 'switch', 'aria-checked': 'false',
          dataset: { field }, onclick: () => toggleStage(view.node.id, field),
        },
        h('span', { class: 'switch-label' }, FIELD_LABELS[field]),
        state,
        h('span', { class: 'switch-track', 'aria-hidden': 'true' }, h('span', { class: 'switch-thumb' })));
        view.switches.set(field, { btn, state });
        return btn;
      }));
      if (focused && view.switches.has(focused)) view.switches.get(focused).btn.focus();
    }

    function updateNote() {
      const s = effective(view.node.id);
      const editing = Boolean(st.editCode) && Boolean(s);
      const note = s?.note ?? '';
      view.noteText.hidden = editing;
      view.noteEdit.hidden = !editing;
      view.noteText.textContent = !s ? 'Unavailable while offline.' : note || 'No note.';
      view.noteText.classList.toggle('is-empty', !note);
      if (!view.noteDirty && view.noteInput.value !== note) view.noteInput.value = note;
      view.counter.textContent = `${view.noteInput.value.length}/${NOTE_MAX}`;
      view.noteSave.disabled = !view.noteDirty || view.noteSaving;
      view.noteSave.textContent = view.noteSaving ? 'Saving…' : 'Save note';
    }

    function update() {
      if (!view) return;
      const { node } = view;
      const s = effective(node.id);
      const status = nodeStatus(s);
      // Without live state the plug block falls back to the default sign-up list (and says so).
      const plug = plugInfo(model, node.id, effective);
      const plugKey = `${JSON.stringify(plug)}|${hasData() ? 'ok' : st.loadError ? 'error' : 'loading'}`;
      if (plugKey !== view.plugKey) {
        view.plugKey = plugKey;
        // A focused neighbor link is rebuilt too: focus its successor (same port and node if
        // it is still there, else the same port's), or the card title, rather than drop to <body>.
        const was = view.plug.contains(document.activeElement) ? document.activeElement : null;
        const port = was?.closest('[data-port]')?.dataset.port;
        view.plug.replaceChildren(...plugContent(plug).filter(Boolean));
        if (was) {
          const links = [...view.plug.querySelectorAll('.node-link')];
          const next = links.find((el) => el.dataset.id === was.dataset.id && el.closest('[data-port]')?.dataset.port === port)
            ?? links.find((el) => port && el.closest('[data-port]')?.dataset.port === port)
            ?? links.find((el) => el.dataset.id === was.dataset.id);
          (next ?? view.title).focus({ preventScroll: true });
        }
      }
      for (const item of view.nav) {
        const { link, target, button } = item;
        // A house the cable passes by (the start house is no box but the start of the cable).
        const noBox = target.kind === 'house' && target.run !== 'start'
          && !(effective(target.id)?.participating ?? target.defaultParticipating);
        const name = `${target.tag}${noBox ? ' (no box)' : ''}`;
        const text = node.run === 'start' ? `${RUN_LABELS[link.run]}: ${name} →`
          : link.rel === 'prev' ? `← ${name}` : `${name} →`;
        if (text === item.label) continue;
        item.label = text;
        const what = node.run === 'start' ? `First stop on the ${RUN_LABELS[link.run].toLowerCase()}`
          : link.rel === 'prev' ? 'Previous stop' : 'Next stop';
        button.textContent = text;
        button.setAttribute('aria-label', `${what}: ${target.title}${noBox ? ' (no box, the cable passes by)' : ''}`);
      }

      const box = boxOf(node.id);
      view.box.textContent = box;
      view.box.hidden = !box;

      view.badge.dataset.status = status;
      view.badge.textContent = statusText(node, status, s);

      syncSwitches(fieldsFor(node, status));
      for (const [field, sw] of view.switches) {
        const on = Boolean(s?.[field]);
        const busy = st.inflight.has(`${node.id}|${field}`);
        sw.btn.setAttribute('aria-checked', String(on));
        // aria-disabled rather than `disabled`: the switch stays focusable (keyboard focus
        // survives a save), and a tap in view mode can explain how to unlock editing.
        if (busy || !st.editCode || !s) sw.btn.setAttribute('aria-disabled', 'true');
        else sw.btn.removeAttribute('aria-disabled');
        sw.btn.toggleAttribute('data-busy', busy);
        sw.state.textContent = busy ? 'Saving…' : !s ? '—' : on ? 'Yes' : 'No';
      }
      view.hint.hidden = Boolean(st.editCode);
      updateNote();

      if (s) {
        const who = s.updated_by ? ` by ${s.updated_by}` : '';
        view.updated.textContent = `Last updated ${timeAgo(s.updated_at, now())}${who}`;
      } else {
        view.updated.textContent = '';
      }
    }

    return {
      open,
      update,
      plugBlock: () => view?.plug ?? null,
      noteState: () => view,
      refreshNote: () => view && updateNote(),
    };
  }

  // ---------------------------------------------------------------- edit mode + writes

  function createEditor() {
    const dialog = $('edit-dialog');
    const form = $('edit-form');
    const codeInput = $('code-input');
    const nameInput = $('name-input');
    const error = $('edit-error');
    const submit = $('edit-submit');

    $('edit-btn').addEventListener('click', () => {
      codeInput.value = '';
      nameInput.value = st.name;
      error.textContent = '';
      dialog.showModal();
      codeInput.focus();
    });
    $('edit-cancel').addEventListener('click', () => dialog.close());
    // Once accepted the code lives only in sessionStorage: never leave it in the form.
    dialog.addEventListener('close', () => { codeInput.value = ''; });
    $('lock-btn').addEventListener('click', () => {
      setEditCode(null);
      toasts.show('Editing locked.');
    });
    $('task-add').addEventListener('submit', (e) => {
      e.preventDefault();
      addTask();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = codeInput.value.trim();
      if (!code) {
        error.textContent = 'Enter the edit code.';
        codeInput.focus();
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Checking…';
      error.textContent = '';
      try {
        await api.checkCode(code);
        st.name = nameInput.value.trim().slice(0, 40);
        local.set(NAME_KEY, st.name);
        setEditCode(code);
        dialog.close();
        toasts.show('Editing unlocked. Changes save as you make them.');
      } catch (err) {
        error.textContent = UNLOCK_ERRORS[err?.code] ?? 'Something went wrong on the server. Try again.';
        codeInput.select();
      } finally {
        submit.disabled = false;
        submit.textContent = 'Unlock';
      }
    });

    return {
      render() {
        const editing = Boolean(st.editCode);
        $('edit-btn').hidden = editing;
        $('editing-chip').hidden = !editing;
        $('task-add').hidden = !editing;
        document.body.classList.toggle('is-editing', editing);
      },
    };
  }

  function setEditCode(code) {
    st.editCode = code || null;
    if (code) session.set(CODE_KEY, code);
    else session.remove(CODE_KEY);
    renderAll();
  }

  function writeFailed(err) {
    const code = err?.code ?? 'network';
    if (code === 'bad_code') {
      setEditCode(null);
      toasts.show('The edit code was not accepted, so editing is locked. Tap Edit to unlock again.', 'error');
      return;
    }
    toasts.show(`Couldn’t save — ${WRITE_ERRORS[code] ?? 'the server had a problem.'}`, 'error');
  }

  function wrote() {
    st.lastWriteAt = Date.now();
    refresh();
  }

  async function toggleStage(id, field) {
    const key = `${id}|${field}`;
    const current = effective(id);
    if (!st.editCode) {
      toasts.show('Tap Edit to make changes.');
      return;
    }
    if (!current) {
      toasts.show('Can’t change this while the tracker database is unreachable.');
      return;
    }
    if (st.inflight.has(key)) return;
    const value = !current[field];
    st.pending.set(id, { ...st.pending.get(id), [field]: value });
    st.inflight.add(key);
    renderAll();
    try {
      const node = await api.setStage(st.editCode, id, field, value, st.name);
      if (node?.id === id) st.nodes.set(id, node);
      wrote();
    } catch (err) {
      writeFailed(err);
    } finally {
      const rest = { ...st.pending.get(id) };
      delete rest[field];
      if (Object.keys(rest).length) st.pending.set(id, rest);
      else st.pending.delete(id);
      st.inflight.delete(key);
      renderAll();
    }
  }

  async function saveNote(id) {
    const view = detail.noteState();
    if (!st.editCode || !view || view.noteSaving) return;
    const text = view.noteInput.value.trim().slice(0, NOTE_MAX);
    view.noteSaving = true;
    detail.refreshNote();
    try {
      const node = await api.setNote(st.editCode, id, text, st.name);
      if (node?.id === id) st.nodes.set(id, node);
      view.noteDirty = false;
      toasts.show('Note saved.');
      wrote();
    } catch (err) {
      writeFailed(err);
    } finally {
      view.noteSaving = false;
      renderAll();
    }
  }

  async function toggleTask(taskId, done) {
    if (!st.editCode) return;
    st.taskPending.set(taskId, done);
    renderAll();
    try {
      const task = await api.setTask(st.editCode, taskId, done, st.name);
      st.tasks = st.tasks.map((t) => (t.id === taskId && task ? { ...t, ...task } : t));
      wrote();
    } catch (err) {
      writeFailed(err);
    } finally {
      st.taskPending.delete(taskId);
      renderAll();
    }
  }

  async function addTask() {
    const input = $('task-input');
    const button = $('task-add').querySelector('button');
    const label = input.value.trim();
    if (!st.editCode) return;
    if (!label) {
      input.focus();
      return;
    }
    input.disabled = true;
    button.disabled = true;
    try {
      const task = await api.addTask(st.editCode, label, st.name);
      if (task?.id && !st.tasks.some((t) => t.id === task.id)) st.tasks = [...st.tasks, task];
      input.value = '';
      wrote();
    } catch (err) {
      writeFailed(err);
    } finally {
      input.disabled = false;
      button.disabled = false;
      renderAll();
      if (st.editCode) input.focus();
    }
  }

  async function addSubTask(parentId) {
    const parent = st.tasks.find((t) => t.id === parentId);
    if (!st.editCode || !parent) return;
    const label = (window.prompt(`New sub-item under “${parent.label}”:`) ?? '').trim().slice(0, 120);
    if (!label) return;
    try {
      const task = await api.addTask(st.editCode, label, st.name, parentId);
      if (task?.id && !st.tasks.some((t) => t.id === task.id)) st.tasks = [...st.tasks, task];
      wrote();
    } catch (err) {
      writeFailed(err);
    } finally {
      renderAll();
    }
  }

  async function deleteTask(taskId) {
    const task = st.tasks.find((t) => t.id === taskId);
    const subs = st.tasks.filter((t) => t.parent_id === taskId).length;
    const also = subs ? ` and its ${subs} sub-item${subs === 1 ? '' : 's'}` : '';
    if (!st.editCode || !task || !window.confirm(`Delete “${task.label}”${also} from the checklist?`)) return;
    st.taskDeleting.add(taskId);
    renderAll();
    try {
      await api.deleteTask(st.editCode, taskId, st.name);
      st.tasks = st.tasks.filter((t) => t.id !== taskId && t.parent_id !== taskId);
      wrote();
    } catch (err) {
      writeFailed(err);
    } finally {
      st.taskDeleting.delete(taskId);
      renderAll();
    }
  }

  // ---------------------------------------------------------------- tabs, tools, mode

  function initTabs() {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const activate = (tab, focus) => {
      for (const t of tabs) {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        $(t.getAttribute('aria-controls')).hidden = !on;
      }
      if (focus) tab.focus();
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => activate(tab, false));
      tab.addEventListener('keydown', (e) => {
        const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          activate(tabs[e.key === 'Home' ? 0 : tabs.length - 1], true);
        } else if (step) {
          e.preventDefault();
          activate(tabs[(i + step + tabs.length) % tabs.length], true);
        }
      });
    });
  }

  function initSceneTools() {
    if (!scene.available) {
      document.querySelector('.scene-tools').hidden = true;
      return;
    }
    $('reset-view').addEventListener('click', () => scene.resetView());
    $('top-view').addEventListener('click', () => scene.topView());
  }

  /** The "Useful information" dialog: channel list and the SPT-1 cord how-to (static, in index.html). */
  function initInfo() {
    const dialog = $('info-dialog');
    $('info-btn').addEventListener('click', () => dialog.showModal());
    for (const id of ['info-close', 'info-done']) $(id).addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  }

  function initModeToggle() {
    const button = $('mode-toggle');
    const apply = (mode) => {
      button.setAttribute('aria-pressed', String(mode === 'night'));
      document.documentElement.dataset.mode = mode;
      scene.setMode(mode);
    };
    apply(local.get(MODE_KEY) === 'night' ? 'night' : 'day');
    button.addEventListener('click', () => {
      const mode = button.getAttribute('aria-pressed') === 'true' ? 'day' : 'night';
      local.set(MODE_KEY, mode);
      apply(mode);
    });
  }

  // ---------------------------------------------------------------- public

  return {
    select,
    setState(state, startedAt) {
      if (startedAt < st.lastWriteAt) return; // began before our last write landed; a newer fetch is queued
      st.nodes = new Map(state.nodes.map((n) => [n.id, n]));
      st.tasks = state.tasks;
      st.log = state.log;
      st.fetchedAt = Date.now();
      const serverNow = Date.parse(state.server_time);
      st.skew = Number.isFinite(serverNow) ? serverNow - st.fetchedAt : 0;
      st.loadError = null;
      renderAll();
    },
    setLoadError(err) {
      st.loadError = err ?? new Error('unknown');
      topbar.render();
      overview.render();
      activity.render();
      detail.update();     // "checking the live list" becomes "based on the default list"
      syncScenePlug();
    },
  };
}

// ------------------------------------------------------------------ toasts

function createToasts(container) {
  const showing = new Map();   // message → {el, timer}; a repeated message restarts its timer

  function expire(message, el) {
    return setTimeout(() => {
      showing.delete(message);
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 300);
    }, TOAST_MS);
  }

  return {
    show(message, kind = 'info') {
      const current = showing.get(message);
      if (current) {
        clearTimeout(current.timer);
        current.timer = expire(message, current.el);
        return;
      }
      const el = h('div', { class: 'toast', dataset: { kind }, role: kind === 'error' ? 'alert' : null }, message);
      container.append(el);
      showing.set(message, { el, timer: expire(message, el) });
    },
  };
}

// ------------------------------------------------------------------ phone bottom sheet

/**
 * Bottom sheet for narrow screens, at one of three heights: the "peek" (35% of the viewport),
 * "detail" (just tall enough to show a given element, the open card's "Where to plug in" block,
 * while leaving part of the map visible) and expanded. Drag the handle to move between them;
 * tap it (or Enter/Space) to expand or go back. Focusing a text field in the panel expands it.
 * Inert in the side-panel layouts.
 */
function createSheet(panel, handle, onLayout) {
  const SNAP_PX = 60;
  const MAP_MIN_PX = 140;    // the detail height never leaves less than this below the top bar
  const TEXT_FIELD = 'input, textarea';
  const body = $('panel-body');
  const overlay = document.querySelector('.scene-overlay');
  let mode = 'collapsed';    // 'collapsed' | 'detail' | 'expanded'
  let detailEl = null;
  let detailCore = null;     // selector of the part of detailEl that must show, room or not
  let drag = null;
  let suppressClick = false;
  // Viewport the peek is sized from. An on-screen keyboard shrinks only the height while a text
  // field has focus; the peek keeps its size then (the expanded sheet still fits what's left).
  let base = { w: window.innerWidth, h: window.innerHeight };

  const typing = () => Boolean(document.activeElement?.matches?.(TEXT_FIELD));
  // Everything above the map: the top bar and the "Useful information" strip.
  const header = () => document.querySelector('.layout')?.getBoundingClientRect().top ?? 0;
  const full = () => Math.max(120, window.innerHeight - header() - 12);
  const peek = () => Math.min(full(), Math.round(base.h * 0.35));
  /** Map kept clear between the floating overlay (view buttons, offline banner) and the sheet. */
  const mapKeep = () => Math.min(136, Math.max(96, Math.round(base.h * 0.15)));
  /**
   * Height that shows `detailEl` down to its bottom edge (as if scrolled to the top) while
   * mapKeep() of the map stays clear below the overlay. When not even its core (the plug block's
   * ports) fits that way, a short screen or the offline banner, the sheet rises to show the
   * core, as far as MAP_MIN_PX below the top bar.
   */
  const detail = () => {
    if (!detailEl?.isConnected) return peek();
    const contentTop = panel.getBoundingClientRect().top - body.scrollTop;
    const need = (el) => el.getBoundingClientRect().bottom - contentTop + 12;
    const roomy = window.innerHeight - (overlay?.getBoundingClientRect().bottom ?? header()) - mapKeep();
    const core = detailCore && detailEl.querySelector(detailCore);
    const cap = Math.max(roomy, core ? Math.min(need(core), full() - MAP_MIN_PX) : 0);
    return Math.round(Math.max(peek(), Math.min(need(detailEl), cap)));
  };
  const heights = { collapsed: peek, detail, expanded: full };
  const stops = () => (detailEl ? ['collapsed', 'detail', 'expanded'] : ['collapsed', 'expanded']);

  function apply() {
    if (!SHEET.matches) {
      panel.style.removeProperty('height');
      return;
    }
    panel.style.height = `${heights[mode]()}px`;
    panel.dataset.sheet = mode;
    handle.setAttribute('aria-expanded', String(mode === 'expanded'));
  }

  function set(next) {
    mode = next;
    apply();
    onLayout();
  }

  // The plug block can change size after the sheet fits it (live data arriving, say), and the
  // overlay grows with the offline banner: refit.
  const refit = new ResizeObserver(() => { if (mode === 'detail') set('detail'); });
  if (overlay) refit.observe(overlay);

  /** Brings the focused field (and its Save row) into view once the sheet has resized. */
  function revealFocused() {
    setTimeout(() => {
      const el = document.activeElement;
      if (panel.contains(el) && el.matches(TEXT_FIELD)) (el.closest('.note-edit') ?? el).scrollIntoView({ block: 'nearest' });
    }, 300);
  }

  handle.addEventListener('pointerdown', (e) => {
    suppressClick = false;
    if (!SHEET.matches) return;
    drag = { y: e.clientY, h: panel.getBoundingClientRect().height, moved: false };
    handle.setPointerCapture(e.pointerId);
    panel.classList.add('is-dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    if (Math.abs(dy) > 6) drag.moved = true;
    if (drag.moved) {
      const height = Math.min(full(), Math.max(peek() * 0.6, drag.h - dy));
      panel.style.height = `${height}px`;
    }
  });
  // A drag past SNAP_PX settles on the height nearest to where it was let go, in its direction.
  const endDrag = () => {
    if (!drag) return;
    panel.classList.remove('is-dragging');
    const { moved, h: startHeight } = drag;
    drag = null;
    if (!moved) return;
    suppressClick = true;
    const now = panel.getBoundingClientRect().height;
    const grew = now - startHeight;
    const ahead = stops().filter((m) => (grew > 0 ? heights[m]() > startHeight + 1 : heights[m]() < startHeight - 1));
    if (Math.abs(grew) <= SNAP_PX || !ahead.length) {
      apply();
      return;
    }
    set(ahead.reduce((a, b) => (Math.abs(heights[b]() - now) < Math.abs(heights[a]() - now) ? b : a)));
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  // Taps and Enter/Space toggle; the click that ends a drag is ignored.
  handle.addEventListener('click', () => {
    if (suppressClick) suppressClick = false;
    else set(mode === 'expanded' ? (detailEl ? 'detail' : 'collapsed') : 'expanded');
  });

  // Typing a note, a checklist item or a search needs the room (and the keyboard takes some).
  panel.addEventListener('focusin', (e) => {
    if (!SHEET.matches || !e.target.matches(TEXT_FIELD)) return;
    set('expanded');
    revealFocused();
  });

  window.addEventListener('resize', () => {
    const { innerWidth: w, innerHeight: h } = window;
    if (w !== base.w || h > base.h || !typing()) base = { w, h };
    apply();
    onLayout();
    if (SHEET.matches && typing()) revealFocused();
  });
  SHEET.addEventListener('change', () => { apply(); onLayout(); });
  apply();

  return {
    expand: () => set('expanded'),
    /**
     * Fits the sheet to `el` (the open card's plug block), or at least to its part matching
     * `core`; null drops back to the peek. With `keepExpanded`, an expanded sheet stays expanded.
     */
    showDetail(el, { core = null, keepExpanded = false } = {}) {
      if (detailEl) refit.unobserve(detailEl);
      detailEl = el;
      detailCore = core;
      if (el) refit.observe(el);
      if (!el) set(mode === 'detail' ? 'collapsed' : mode);
      else set(keepExpanded && mode === 'expanded' ? mode : 'detail');
    },
    /** Height of the map the sheet covers at rest: the detail height while fitted, else the peek. */
    viewInset: () => (mode === 'detail' ? detail() : peek()),
  };
}
