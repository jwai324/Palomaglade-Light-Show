/**
 * model.js — read-only model derived from data/neighborhood.json.
 * Indexes houses and islands as "nodes", records each node's place on the cable runs,
 * and holds the status/progress helpers shared by the scene and the UI.
 */

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

/**
 * Status bucket of a node state: 'unknown' (no DB data), 'out' (opted out),
 * 'none' | 'partial' | 'done' (participating, 0 / 1–2 / 3 stages complete).
 */
export function nodeStatus(state) {
  if (!state) return 'unknown';
  if (!state.participating) return 'out';
  const done = stagesDone(state);
  if (done === 0) return 'none';
  return done === STAGES.length ? 'done' : 'partial';
}

export function stagesDone(state) {
  return STAGES.reduce((n, s) => n + (state[s.key] ? 1 : 0), 0);
}

/** Builds the node index, run positions and list groups from the layout data. */
export function buildModel(data) {
  const optedOut = new Set(data.opted_out_default);
  const nodes = new Map();
  const runFields = () => ({ run: null, stop: 0, runLength: 0, links: [] });

  for (const h of data.houses) {
    const street = STREET_SHORT[h.street] ?? h.street;
    nodes.set(h.id, {
      ...runFields(),
      id: h.id, kind: 'house', geo: h,
      title: `${h.num} ${h.street}`,
      short: `${h.num} ${street}`,
      tag: String(h.num),
      search: `${h.num} ${h.street} ${street}`.toLowerCase(),
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
      title: tag,
      short: tag,
      tag,
      search: `${tag} ${ISLAND_LABELS[i.theme] ?? ''} ${i.name} ${i.desc} island`.toLowerCase(),
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
