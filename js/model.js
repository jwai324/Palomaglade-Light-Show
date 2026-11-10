/**
 * model.js — read-only model derived from data/neighborhood.json.
 * Indexes houses and islands as "nodes", records each node's place on the cable runs,
 * and holds the status, progress, search and "where to plug in" helpers shared by the scene
 * and the UI.
 */

import { BOX_NUMBERS } from './boxes.js';

export const STAGES = [
  { key: 'cable_run', label: 'Cable run', short: 'Cable' },
  { key: 'box_connected', label: 'Box connected', short: 'Box' },
  { key: 'lights_up', label: 'Lights/props up', short: 'Lights' },
];

export const FIELD_LABELS = {
  participating: 'Participating',
  cable_run: 'Cable run',
  box_connected: 'Box connected',
  lights_up: 'Lights/props up',
  note: 'Note',
};

export const RUN_LABELS = { right: 'Right run', left: 'Left run' };

const STREET_SHORT = { 'Palomaglade Dr': 'Palomaglade', 'Palomapark Ln': 'Palomapark' };
const ISLAND_TAGS = { 'I-front': 'Front island', 'I-glade': 'Glade island', 'I-park': 'Park island' };

/** Map labels of the islands, by theme (shown in the 3D view and matched by the search). */
export const ISLAND_LABELS = {
  'star-wars': 'Front island · Star Wars display',
  'train-tree': 'Glade island · Train + lit tree',
  box: 'Park island · end of left run',
};

/** The two stages that color a house. Lights/props add Christmas lights to it instead. */
export const WIRING_STAGES = STAGES.filter((s) => s.key !== 'lights_up');

/**
 * Status bucket of a node state: 'unknown' (no DB data), 'out' (opted out),
 * 'none' | 'partial' | 'done' (participating, 0 / 1 / 2 wiring stages complete: cable run and
 * box connected). Lights up does not change the bucket; the scene draws lights for it.
 */
export function nodeStatus(state) {
  if (!state) return 'unknown';
  if (!state.participating) return 'out';
  const done = wiringDone(state);
  if (done === 0) return 'none';
  return done === WIRING_STAGES.length ? 'done' : 'partial';
}

export function stagesDone(state) {
  return STAGES.reduce((n, s) => n + (state[s.key] ? 1 : 0), 0);
}

/**
 * "Box 12", "Boxes 1–4" (consecutive numbers) or "Boxes 5, 9" for a node's box numbers,
 * or '' when it has none. Whether the node has a box at all (participation) is the caller's call.
 */
export function boxText(node) {
  const n = node.boxes;
  if (!n.length) return '';
  if (n.length === 1) return `Box ${n[0]}`;
  const consecutive = n.every((v, i) => i === 0 || v === n[i - 1] + 1);
  return `Boxes ${consecutive ? `${n[0]}–${n[n.length - 1]}` : n.join(', ')}`;
}

export function wiringDone(state) {
  return WIRING_STAGES.reduce((n, s) => n + (state[s.key] ? 1 : 0), 0);
}

/** Short status line for a node's card, by bucket. */
export function statusText(node, status, state) {
  switch (status) {
    case 'unknown': return 'Status unknown — the tracker database can’t be reached';
    case 'out': return node.run ? 'Opted out — cable passes by, no box' : 'Opted out — no box';
    case 'none': return 'Participating · not started';
    case 'partial': return state.cable_run ? 'Cable run · box not connected yet' : 'Box connected · cable not run yet';
    default: return state.lights_up ? 'Cable run + box connected · lights up' : 'Cable run + box connected · lights not up yet';
  }
}

/**
 * Ids of the nodes whose Christmas lights have power: the cable runs unbroken from the start
 * house's connected box out along the chain, through a connected box at every stop that has one
 * (islands and participating houses), to a connected box at this node. A segment counts as laid
 * when the node it runs to has cable_run; an unconnected box breaks the chain past it, while the
 * cable passes opted-out houses untouched. Nothing is powered until the start house's own box is
 * connected. `get(id)` returns the node state or undefined (unknown nodes break the chain).
 */
export function poweredIds(data, get) {
  const out = new Set();
  const home = get(data.home);
  if (home?.participating && home.box_connected) out.add(data.home);
  const optedOut = new Set(data.opted_out_default);
  const islands = new Set(data.islands.map((i) => i.id));
  for (const chain of Object.values(data.chains)) {
    let live = out.has(data.home);
    for (const id of chain.slice(1)) {
      if (!live) break;
      const s = get(id);
      if (!s?.cable_run) break;
      const hasBox = islands.has(id) || (s.participating ?? !optedOut.has(id));
      if (!hasBox) continue;
      if (!s.box_connected) break;
      out.add(id);
    }
  }
  return out;
}

/** Builds the node index, run positions and list groups from the layout data. */
export function buildModel(data) {
  const optedOut = new Set(data.opted_out_default);
  const nodes = new Map();
  const runFields = () => ({ run: null, stop: 0, runLength: 0, links: [] });
  const boxes = (id) => BOX_NUMBERS[id] ?? [];
  // Lets "Find my house" and the Houses search match "box 12" (or just "12").
  const boxWords = (id) => (BOX_NUMBERS[id] ? ` box ${BOX_NUMBERS[id].join(' ')}` : '');

  for (const h of data.houses) {
    const street = STREET_SHORT[h.street] ?? h.street;
    nodes.set(h.id, {
      ...runFields(),
      id: h.id, kind: 'house', geo: h,
      key: String(h.num),
      title: `${h.num} ${h.street}`,
      short: `${h.num} ${street}`,
      tag: String(h.num),
      boxes: boxes(h.id),
      search: `${h.num} ${h.street} ${street}${boxWords(h.id)}`.toLowerCase(),
      defaultParticipating: !optedOut.has(h.id),
    });
  }
  for (const i of data.islands) {
    // Cards, lists, Overview and Activity use the map label's short name ("Glade island");
    // the detail card also shows the full name from the data.
    const tag = ISLAND_TAGS[i.id] ?? i.name;
    nodes.set(i.id, {
      ...runFields(),
      id: i.id, kind: 'island', geo: i,
      key: tag.toLowerCase().replace(/\s+/g, '-'),
      title: tag,
      short: tag,
      tag,
      boxes: boxes(i.id),
      search: `${tag} ${ISLAND_LABELS[i.theme] ?? ''} ${i.name} ${i.desc} island${boxWords(i.id)}`.toLowerCase(),
      defaultParticipating: true,
    });
  }

  for (const [run, ids] of Object.entries(data.chains)) {
    ids.forEach((id, i) => {
      const node = nodes.get(id);
      if (i === 0) {
        node.run = 'start';
        node.links.push({ rel: 'next', run, id: ids[1] });
        return;
      }
      node.run = run;
      node.stop = i;
      node.runLength = ids.length - 1;
      node.links.push({ rel: 'prev', run, id: ids[i - 1] });
      if (i < ids.length - 1) node.links.push({ rel: 'next', run, id: ids[i + 1] });
    });
  }

  const chainIds = [...new Set(Object.values(data.chains).flat())];
  const onChain = new Set(chainIds);
  // Every cable segment ends at one of these (a segment is laid when its `to` node has
  // cable_run), so "Cable n/N" counts segments: the start house is the end of none.
  const cableIds = chainIds.filter((id) => id !== data.home);
  const offRun = data.houses.filter((h) => !onChain.has(h.id)).sort((a, b) => a.num - b.num);

  const groups = [
    { key: 'start', label: 'Cable start', ids: [data.home] },
    { key: 'right', label: RUN_LABELS.right, ids: data.chains.right.slice(1) },
    { key: 'left', label: RUN_LABELS.left, ids: data.chains.left.slice(1) },
    { key: 'off', label: 'Not on a run', ids: offRun.map((h) => h.id) },
  ];

  return {
    data,
    nodes,
    groups,
    // Deep-link keys ("6020", "glade-island") → node id.
    keys: new Map([...nodes.values()].map((node) => [node.key, node.id])),
    // "from>to" of every chain link that jumps over the street.
    crossings: new Set(data.segments.filter((s) => s.crossing).map((s) => `${s.from}>${s.to}`)),
    homeId: data.home,
    chainIds,
    cableIds,
    allIds: [...nodes.keys()],
    islandIds: data.islands.map((i) => i.id),
  };
}

/** True when every whitespace-separated word of `query` occurs somewhere in `text`. */
export function matchesQuery(text, query) {
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => text.includes(word));
}

/**
 * Up to `limit` nodes matching `query` for "Find my house": the exact house number (or island
 * key) first, then the node with that box number ("12" or "box 12"), then keys starting with
 * the query, then any other match, each in data order.
 */
export function findNodes(model, query, limit = 8) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const box = q.match(/^(?:box\s*)?(\d{1,3})$/);
  const boxNum = box ? Number(box[1]) : null;
  const rank = (node) => (node.key === q ? 0 : node.boxes.includes(boxNum) ? 1 : node.key.startsWith(q) ? 2 : 3);
  return [...model.nodes.values()]
    .filter((node) => matchesQuery(node.search, q))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, limit);
}

/** Node id for a deep-link key such as "6020" or "glade-island", or null. */
export function nodeIdForKey(model, key) {
  return model.keys.get(String(key).trim().toLowerCase()) ?? null;
}

/**
 * Where the Ethernet cable plugs into node `id`'s box. Cable flows outward from the start house
 * along each chain. A node has a box if it is an island or a participating house (`get(id)` is
 * the live state; without one the default sign-up list applies); the cable passes by the rest.
 * Every box takes the cable from the nearest box upstream (or the start) in its IN port and sends
 * it on to the nearest box downstream from its OUT port. Returns one of
 *   {kind: 'start'} · {kind: 'offrun'} · {kind: 'passby', passFrom, passTo (null past the last box)}
 *   {kind: 'box', in: {id, passes, crossing}, out: {id, passes, crossing} | {end: true}}
 * where `passes` lists the opted-out houses the cable skips (in cable order) and `crossing` is
 * true when it jumps over the street on the way.
 */
export function plugInfo(model, id, get) {
  const node = model.nodes.get(id);
  if (!node) return null;
  if (node.run === 'start') return { kind: 'start' };
  if (!node.run) return { kind: 'offrun' };
  const chain = model.data.chains[node.run];
  const hasBox = (i) => {
    const n = model.nodes.get(chain[i]);
    return n.kind === 'island' || (get(n.id)?.participating ?? n.defaultParticipating);
  };
  const cable = (from, to) => ({
    passes: chain.slice(from + 1, to),
    crossing: chain.slice(from, to).some((a, k) => model.crossings.has(`${a}>${chain[from + k + 1]}`)),
  });

  const at = node.stop;
  let up = at - 1;
  while (up > 0 && !hasBox(up)) up -= 1;
  let down = at + 1;
  while (down < chain.length && !hasBox(down)) down += 1;
  const end = down === chain.length;

  if (!hasBox(at)) return { kind: 'passby', passFrom: chain[up], passTo: end ? null : chain[down] };
  return {
    kind: 'box',
    in: { id: chain[up], ...cable(up, at) },
    out: end ? { end: true } : { id: chain[down], ...cable(at, down) },
  };
}

/** "Right run · stop 7 of 31", "Cable start · both runs begin here", … */
export function positionText(node) {
  if (node.run === 'start') return 'Cable start · both runs begin here';
  if (node.run) return `${RUN_LABELS[node.run]} · stop ${node.stop} of ${node.runLength}`;
  return 'Not on a run · past the end of the left run';
}

/**
 * Stage counts over a set of node ids. `get(id)` returns the node state or undefined.
 * Cable counts every node; boxes and lights count participating nodes only.
 * Unknown nodes fall back to their default participation for the denominators.
 */
export function progress(model, ids, get) {
  const out = { total: ids.length, known: 0, cable: 0, participating: 0, box: 0, lights: 0 };
  for (const id of ids) {
    const s = get(id);
    if (!s) {
      if (model.nodes.get(id).defaultParticipating) out.participating += 1;
      continue;
    }
    out.known += 1;
    if (s.cable_run) out.cable += 1;
    if (s.participating) {
      out.participating += 1;
      if (s.box_connected) out.box += 1;
      if (s.lights_up) out.lights += 1;
    }
  }
  return out;
}
