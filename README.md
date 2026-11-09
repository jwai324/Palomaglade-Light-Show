# Palomaglade Light Show — Setup Map

A 3D map of Palomaglade Dr and Palomapark Ln (Lithia, FL) that shows how far setup has gotten for the neighborhood Christmas light show. It covers each Ethernet cable segment, each house's box, and each house's lights/props, plus a short show checklist.

- **View:** anyone with the link. The site is not indexed by search engines.
- **Edit:** tap **Edit** and enter the shared code. The server checks the code; it is never in this repo.

## What's on the map

| Item | Meaning |
|---|---|
| Orange cable | **Right run**: 6024 → 6022…6004 → Glade cul-de-sac island → 6003…6023 → Palomapark inner side 15318…15302 (31 stops) |
| Blue cable | **Left run**: 6024 → 6026…6038 → front (entrance) island → 6043…6035 → Palomapark outer side 15327…15305 → Palomapark island (26 stops) |
| Arched cable | Street crossing |
| Solid vs dashed cable | Laid vs not laid yet. A segment counts as laid when the house or island it runs **to** is marked *Cable run*. |
| House color | Green = all 3 stages done · amber = 1–2 done · off-white = not started · grey = opted out (cable passes by, no box) |
| Small box at a house | Its connection box (green = connected) |
| Islands | Front: Star Wars display + control box · Glade: train + lit tree + box · Park: box at the end of the left run |

The house count is 56: 34 on Palomaglade and 22 on Palomapark. Three are opted out by default: 6016, 6032 and 15301. 15301 is past the end of the left run.

## How to update progress (SOP)
1. Open the site and tap **Edit**. Enter the code, and optionally your name, which appears in Activity.
2. Tap a house or island on the map, or find it in the **Houses** tab.
3. Flip **Cable run**, **Box connected** or **Lights/props up**. Add a note if useful (280 characters max).
4. To change participation, use the **Participating** switch on that house.
5. Use the **Overview** tab to tick off checklist items, such as "Music streaming website up and running".
6. Tap **Lock** when you're done. Editing also locks when the tab closes.

Eight wrong codes from one device in 15 minutes lock editing for 15 minutes. Sixty wrong codes from everyone combined in 15 minutes do the same.

## Architecture

```
Static site on Vercel (no build step)          Supabase project "tideline", schema "lightshow"
index.html, css/, js/, vendor/three ── RPC ──▶  public.lightshow_* functions (SECURITY DEFINER)
data/neighborhood.json (layout)                 lightshow.nodes / tasks / edit_log / auth_failures / settings
assets/aerial-2025.jpg (ground)                 (tables not exposed to the API; RLS on, no policies)
```

- **`js/`:** `main.js` boots the page, `api.js` calls the database, `scene.js` draws the Three.js map, `ui.js` runs the panels and edit mode, and `model.js` holds the shared run order and progress counts. `fallback.js` shows a message when the 3D map can't load.
- **`supabase/`:**
  - `schema.sql` creates the schema and the functions the site calls.
  - `seed.sql` loads the starting rows.
  - Both are already applied to the `tideline` Supabase project.
- **`tools/build_data.py`:** regenerates `data/neighborhood.json` and the aerial image from public Hillsborough County GIS data (parcels, address points, road centerlines, 2025 aerials). Owner names are never downloaded.

## Admin tasks

**Change the edit code** — run in the Supabase SQL editor for `tideline`:
```sql
insert into lightshow.settings(key, value)
values ('edit_code_hash', extensions.crypt('NEW-CODE', extensions.gen_salt('bf', 8)))
on conflict (key) do update set value = excluded.value;
```

**Reset all progress for a new season:**
```sql
update lightshow.nodes set cable_run = false, box_connected = false, lights_up = false, note = '';
update lightshow.tasks set done = false;
```

**Rebuild map data** (only needed if lots or streets change):
```bash
pip install shapely pyproj && python3 tools/build_data.py --fetch
```
Then run `supabase/seed.sql` again for any new house IDs.

**Run locally:**
```bash
python3 -m http.server 8765
```
Then open http://localhost:8765.

## Known limits
- **House shapes are estimates.** County data has no building outlines, so each house is a box sized from heated square footage and placed at the county address point. Positions are accurate to within a few meters.
- **The edit code is short.** It is checked on the server and rate-limited, but 4 digits is still guessable over days. A longer code is cheap insurance; see "Change the edit code".
- **Free-tier pausing.** `tideline` is on Supabase's free plan, which pauses a project after about a week with no activity. If the site shows "showing layout only" after the off-season, restore the project from the Supabase dashboard.
