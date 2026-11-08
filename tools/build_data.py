#!/usr/bin/env python3
"""Build data/neighborhood.json and assets/aerial-2025.jpg from public county GIS data.

Sources (Hillsborough County, FL public GIS):
  - Parcels:        maps.hillsboroughcounty.org  InfoLayers/HC_ParcelsPublic/MapServer/0
  - Address points: gisdextweb1.hillsboroughcounty.org  CORPORATE/Site_Address_Points/MapServer/0
  - Road centerlines: maps.hillsboroughcounty.org  InfoLayers/infoLayers/MapServer/7
  - Aerial (2025):  maps.hillsboroughcounty.org  AerialsNew/Aerials_2025/ImageServer

Usage:
  pip install shapely pyproj
  python3 tools/build_data.py --fetch        # download raw data into tools/raw/ then build
  python3 tools/build_data.py                # rebuild from tools/raw/ cache

Owner names are never requested. Output coordinates are local meters:
x = east, y = north, origin at ORIGIN below.
"""
import argparse
import json
import math
import os
import sys
import urllib.parse
import urllib.request

from pyproj import Transformer
from shapely.geometry import LineString, Point, Polygon, shape
from shapely.ops import nearest_points, unary_union

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "tools", "raw")
OUT_JSON = os.path.join(ROOT, "data", "neighborhood.json")
OUT_AERIAL = os.path.join(ROOT, "assets", "aerial-2025.jpg")

# Scene bounds (WGS84) and the aerial export box (Web Mercator, as returned by the server).
BBOX_4326 = (-82.2342, 27.8370, -82.2297, 27.8426)
AERIAL_3857 = (-9154269.269792218, 3228438.661794318, -9153768.332083648, 3229143.7617442496)
AERIAL_SIZE = (1455, 2048)
ORIGIN = (-82.23195, 27.83980)  # lon, lat — roughly the middle of Palomaglade/Palomapark

OUR_STREETS = {"PALOMAGLADE": "Palomaglade Dr", "PALOMAPARK": "Palomapark Ln"}
CONFIDENTIAL_FOLIOS = {"0883532370": ("PALOMAGLADE", 6017)}  # parcel record masked by the county

# ---- Cable topology (from the show organizer) -------------------------------------------
# Both runs start at 6024 Palomaglade. Opted-out houses stay in the chain as "pass-by"
# nodes: the cable passes their frontage but they get no box.
HOME = "G6024"
RIGHT_CHAIN = (
    [HOME] + [f"G{n}" for n in range(6022, 6003, -2)]           # 6022 … 6004 (even side, north)
    + ["I-glade"]                                                 # cross street to cul-de-sac island
    + [f"G{n}" for n in (6003, 6005, 6007, 6009, 6011, 6013, 6015, 6017, 6019, 6021, 6023)]
    + [f"P{n}" for n in range(15318, 15301, -2)]                  # Palomapark inner side 15318 … 15302
)
LEFT_CHAIN = (
    [HOME] + [f"G{n}" for n in range(6026, 6039, 2)]             # 6026 … 6038 (even side, south)
    + ["I-front"]                                                 # cross to front (entrance) island
    + [f"G{n}" for n in (6043, 6041, 6039, 6037, 6035)]
    + [f"P{n}" for n in range(15327, 15304, -2)]                  # Palomapark outer side 15327 … 15305
    + ["I-park"]                                                  # ends at Palomapark island
)
OPTED_OUT = {"G6016", "G6032", "P15301"}
# Street crossings ("jumps over the street"): segment endpoints
CROSSINGS = {("G6004", "I-glade"), ("I-glade", "G6003"), ("G6038", "I-front"),
             ("I-front", "G6043"), ("P15305", "I-park")}

ISLANDS = {
    "I-front": {"name": "Front island", "legal": ["Tract A-8 Landscape", "Tract A-8 Median"],
                "street": "PALOMAGLADE", "theme": "star-wars",
                "desc": "Entrance island: Star Wars display, lights around the perimeter, several blow-ups. Light control box."},
    "I-glade": {"name": "Palomaglade cul-de-sac island", "legal": ["Tract A-21 Median"],
                "street": "PALOMAGLADE", "theme": "train-tree",
                "desc": "End of Palomaglade: train set around the island and a heavily lit tree. Control box."},
    "I-park": {"name": "Palomapark cul-de-sac island", "legal": ["Tract A-22 Median"],
               "street": "PALOMAPARK", "theme": "box",
               "desc": "End of Palomapark: control box where the left run ends."},
}

SQFT_TO_M2 = 0.09290304


def fetch(url, params, dest):
    q = urllib.parse.urlencode(params)
    req = urllib.request.Request(url + "?" + q, headers={"User-Agent": "palomaglade-light-show-map/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        f.write(r.read())
    print("fetched", os.path.basename(dest))


def fetch_all():
    os.makedirs(RAW, exist_ok=True)
    env = ",".join(str(v) for v in BBOX_4326)
    common = {"geometry": env, "geometryType": "esriGeometryEnvelope", "inSR": 4326,
              "spatialRel": "esriSpatialRelIntersects", "outSR": 4326, "f": "geojson", "where": "1=1"}
    fetch("https://maps.hillsboroughcounty.org/arcgis/rest/services/InfoLayers/HC_ParcelsPublic/MapServer/0/query",
          {**common, "outFields": "FOLIO,SITE_ADDR,str_num,str,tSTORIES,HEAT_AR,DOR_CODE,LEGAL2"},
          os.path.join(RAW, "parcels.geojson"))
    fetch("https://gisdextweb1.hillsboroughcounty.org/arcgis/rest/services/CORPORATE/Site_Address_Points/MapServer/0/query",
          {**common, "outFields": "AddrNum,RoadName,Status,Folio"}, os.path.join(RAW, "addrpts.geojson"))
    fetch("https://maps.hillsboroughcounty.org/arcgis/rest/services/InfoLayers/infoLayers/MapServer/7/query",
          {**common, "outFields": "STREET"}, os.path.join(RAW, "roads.geojson"))
    fetch("https://maps.hillsboroughcounty.org/arcgis/rest/services/AerialsNew/Aerials_2025/ImageServer/exportImage",
          {"bbox": ",".join(str(v) for v in AERIAL_3857), "bboxSR": 3857, "imageSR": 3857,
           "size": f"{AERIAL_SIZE[0]},{AERIAL_SIZE[1]}", "format": "jpg", "compressionQuality": 82, "f": "image"},
          OUT_AERIAL)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch", action="store_true")
    args = ap.parse_args()
    if args.fetch:
        fetch_all()

    to_local = Transformer.from_crs(
        "EPSG:4326", f"+proj=aeqd +lat_0={ORIGIN[1]} +lon_0={ORIGIN[0]} +datum=WGS84 +units=m", always_xy=True)
    merc_to_local = Transformer.from_crs(
        "EPSG:3857", f"+proj=aeqd +lat_0={ORIGIN[1]} +lon_0={ORIGIN[0]} +datum=WGS84 +units=m", always_xy=True)

    def L(lon, lat):
        x, y = to_local.transform(lon, lat)
        return (round(x, 2), round(y, 2))

    def poly_local(geom):
        g = shape(geom)
        polys = [g] if g.geom_type == "Polygon" else list(g.geoms)
        out = [Polygon([L(x, y) for x, y in p.exterior.coords]) for p in polys]
        return unary_union(out) if len(out) > 1 else out[0]

    parcels = json.load(open(os.path.join(RAW, "parcels.geojson")))["features"]
    addrpts = json.load(open(os.path.join(RAW, "addrpts.geojson")))["features"]
    roads = json.load(open(os.path.join(RAW, "roads.geojson")))["features"]

    # Road centerlines in local coords, merged per street
    street_lines = {}
    road_out = []
    for f in roads:
        name = f["properties"]["STREET"]
        g = f["geometry"]
        lines = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
        for coords in lines:
            pts = [L(x, y) for x, y in coords]
            street_lines.setdefault(name.split(" ")[0], []).append(LineString(pts))
            road_out.append({"street": name.title(), "ours": name.split(" ")[0] in OUR_STREETS,
                             "pts": [list(p) for p in pts]})
    street_geom = {k: unary_union(v) for k, v in street_lines.items()}
    # Dead-end points (cul-de-sac bulb centres): line endpoints that touch no other road line
    all_lines = [ln for v in street_lines.values() for ln in v]
    dead_ends = []
    for ln in all_lines:
        for e in (Point(ln.coords[0]), Point(ln.coords[-1])):
            if all(o is ln or o.distance(e) > 2.0 for o in all_lines):
                dead_ends.append(e)

    # Address points (current only)
    addr = {}
    for f in addrpts:
        p = f["properties"]
        if p.get("Status") != "Current" or not p.get("RoadName"):
            continue
        key = (p["RoadName"].upper().split(" ")[0], int(p["AddrNum"]))
        addr[key] = Point(L(*f["geometry"]["coordinates"]))

    houses, context, islands_geo = [], [], {k: [] for k in ISLANDS}
    for f in parcels:
        p = f["properties"]
        poly = poly_local(f["geometry"])
        folio = p.get("FOLIO")
        street = (p.get("str") or "").upper()
        num = int(p.get("str_num") or 0)
        if folio in CONFIDENTIAL_FOLIOS:
            street, num = CONFIDENTIAL_FOLIOS[folio]
        if p.get("DOR_CODE") != "0100" and street in OUR_STREETS:
            for iid, meta in ISLANDS.items():
                if meta["street"] == street and any((p.get("LEGAL2") or "").startswith(lg) for lg in meta["legal"]):
                    islands_geo[iid].append(poly)
            continue
        if p.get("DOR_CODE") not in ("0100", "0106") or num == 0:
            continue
        line = street_geom.get(street)
        apt = addr.get((street, num))
        if line is None:
            continue
        rec = house_geometry(poly, line, apt, p, street, num, dead_ends)
        if rec is None:
            continue
        if street in OUR_STREETS:
            houses.append(rec)
        else:
            context.append({k: rec[k] for k in ("center", "rot", "w", "d", "stories")})

    houses.sort(key=lambda h: (h["street"], h["num"]))
    ids = {h["id"] for h in houses}

    islands = []
    for iid, meta in ISLANDS.items():
        geo = unary_union(islands_geo[iid])
        c = geo.representative_point() if iid == "I-front" else geo.centroid
        islands.append({"id": iid, "name": meta["name"], "theme": meta["theme"], "desc": meta["desc"],
                        "center": [round(c.x, 2), round(c.y, 2)],
                        "poly": [list(map(lambda v: round(v, 2), xy)) for xy in
                                 (geo.exterior.coords if geo.geom_type == "Polygon" else
                                  max(geo.geoms, key=lambda g: g.area).exterior.coords)],
                        "area_m2": round(geo.area, 1), "box": [round(c.x, 2), round(c.y, 2)]})
        ids.add(iid)

    for chain in (RIGHT_CHAIN, LEFT_CHAIN):
        missing = [n for n in chain if n not in ids]
        if missing:
            sys.exit(f"chain references unknown nodes: {missing}")
    all_house_ids = {h["id"] for h in houses}
    covered = set(RIGHT_CHAIN) | set(LEFT_CHAIN)
    uncovered = sorted(all_house_ids - covered - OPTED_OUT)  # e.g. 15301 sits past the end of the left run
    if uncovered:
        sys.exit(f"houses not on any chain: {uncovered}")

    # Cable segments with polyline paths (front-yard cable points; corner via-points)
    node_pt = {h["id"]: h["cable"] for h in houses}
    node_pt.update({i["id"]: i["center"] for i in islands})
    lot_of = {h["id"]: Polygon(h["lot"]) for h in houses}
    junction = nearest_points(street_geom["PALOMAGLADE"], street_geom["PALOMAPARK"])[0]

    def corner_via(a, b):
        # Wrap the cable around the street corner: nearest lot vertex to the junction, 2.5 m inside the lot
        best = None
        for hid in (a, b):
            lot = lot_of[hid]
            for vx, vy in lot.exterior.coords:
                dd = junction.distance(Point(vx, vy))
                if best is None or dd < best[0]:
                    best = (dd, vx, vy, lot.centroid)
        _, vx, vy, c = best
        k = 2.5 / (math.hypot(c.x - vx, c.y - vy) or 1)
        return [round(vx + (c.x - vx) * k, 2), round(vy + (c.y - vy) * k, 2)]

    segments = []
    for chain_name, chain in (("right", RIGHT_CHAIN), ("left", LEFT_CHAIN)):
        for a, b in zip(chain, chain[1:]):
            path = [node_pt[a], node_pt[b]]
            if a[0] in "GP" and b[0] in "GP" and a[0] != b[0]:
                path = [node_pt[a], corner_via(a, b), node_pt[b]]
            segments.append({"chain": chain_name, "from": a, "to": b,
                             "crossing": (a, b) in CROSSINGS,
                             "length_m": round(LineString(path).length, 1), "path": path})

    # Aerial placement: corners of the Web Mercator box in local meters
    x0, y0 = merc_to_local.transform(AERIAL_3857[0], AERIAL_3857[1])
    x1, y1 = merc_to_local.transform(AERIAL_3857[2], AERIAL_3857[3])
    xa, ya = merc_to_local.transform(AERIAL_3857[0], AERIAL_3857[3])
    xb, yb = merc_to_local.transform(AERIAL_3857[2], AERIAL_3857[1])
    skew = max(abs(xa - x0), abs(xb - x1), abs(ya - y1), abs(yb - y0))

    out = {
        "meta": {
            "title": "Palomaglade Light Show",
            "origin_lonlat": ORIGIN,
            "units": "meters; x=east, y=north",
            "sources": "Hillsborough County GIS: parcels, site address points, road centerlines, 2025 aerials",
            "aerial_skew_m": round(skew, 2),
        },
        "aerial": {"url": "assets/aerial-2025.jpg", "xmin": round(x0, 2), "xmax": round(x1, 2),
                   "ymin": round(y0, 2), "ymax": round(y1, 2)},
        "home": HOME,
        "chains": {"right": RIGHT_CHAIN, "left": LEFT_CHAIN},
        "opted_out_default": sorted(OPTED_OUT),
        "houses": houses,
        "islands": islands,
        "segments": segments,
        "roads": road_out,
        "context_houses": context,
    }
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    tot = {c: round(sum(s["length_m"] for s in segments if s["chain"] == c)) for c in ("right", "left")}
    print(f"houses={len(houses)} islands={len(islands)} context={len(context)} segments={len(segments)} "
          f"cable_m={tot} aerial_skew_m={skew:.2f}")


def house_geometry(poly, line, apt, props, street, num, dead_ends):
    """Estimate a house footprint from the parcel, its street and the county address point."""
    front_on_lot, near_road = nearest_points(poly.exterior, line)
    ref = apt if (apt is not None and poly.buffer(1.0).contains(apt)) else poly.representative_point()
    # Inward normal (road -> lot). Lots on a cul-de-sac bulb face the bulb centre; all other
    # lots face perpendicular to the street at their nearest point.
    vx, vy = ref.x - near_road.x, ref.y - near_road.y
    if not any(near_road.distance(e) < 3.0 for e in dead_ends):
        comps = list(line.geoms) if line.geom_type == "MultiLineString" else [line]
        comp = min(comps, key=lambda c: c.distance(near_road))
        pr = comp.project(near_road)
        a, b = comp.interpolate(max(pr - 4, 0)), comp.interpolate(min(pr + 4, comp.length))
        tx0, ty0 = b.x - a.x, b.y - a.y
        if math.hypot(tx0, ty0) > 0.5:
            cand = (-ty0, tx0)
            if cand[0] * vx + cand[1] * vy < 0:
                cand = (ty0, -tx0)
            vx, vy = cand
    dist = math.hypot(vx, vy) or 1.0
    nx, ny = vx / dist, vy / dist
    tx, ty = -ny, nx
    stories = int(props.get("tSTORIES") or 0) or 2
    heated = float(props.get("HEAT_AR") or 0) or 2700.0
    foot_m2 = (heated / stories + 520.0) * SQFT_TO_M2          # + garage
    w = math.sqrt(foot_m2 * 1.25)
    d = foot_m2 / w
    # Clamp width to the lot frontage near the house
    pd = 7.5 + d / 2
    probe = LineString([(front_on_lot.x + nx * pd - tx * 40, front_on_lot.y + ny * pd - ty * 40),
                        (front_on_lot.x + nx * pd + tx * 40, front_on_lot.y + ny * pd + ty * 40)])
    inter = poly.intersection(probe)
    if not inter.is_empty and inter.length > 0:
        w = min(w, max(9.0, inter.length - 3.5))
        d = max(d, foot_m2 / w * 0.9)
    setback = 7.5
    lat = (ref.x - front_on_lot.x) * tx + (ref.y - front_on_lot.y) * ty if apt is not None else 0.0
    depth_from_front = max(setback + d / 2, ((ref.x - front_on_lot.x) * nx + (ref.y - front_on_lot.y) * ny))
    cx = front_on_lot.x + nx * depth_from_front + tx * lat
    cy = front_on_lot.y + ny * depth_from_front + ty * lat
    # Cable point: 2 m inside the front lot line, in line with the house
    kx = front_on_lot.x + nx * 2.0 + tx * lat * 0.5
    ky = front_on_lot.y + ny * 2.0 + ty * lat * 0.5
    if not poly.contains(Point(kx, ky)):
        kx, ky = front_on_lot.x + nx * 2.0, front_on_lot.y + ny * 2.0
    rot = math.atan2(ny, nx)  # angle of the inward normal (front faces -n)
    prefix = "G" if street == "PALOMAGLADE" else ("P" if street == "PALOMAPARK" else "X")
    return {
        "id": f"{prefix}{num}",
        "num": num,
        "street": OUR_STREETS.get(street, street.title()),
        "side": "odd" if num % 2 else "even",
        "center": [round(cx, 2), round(cy, 2)],
        "rot": round(rot, 4),
        "w": round(w, 2), "d": round(d, 2), "stories": stories,
        "cable": [round(kx, 2), round(ky, 2)],
        "lot": [[round(x, 2), round(y, 2)] for x, y in poly.exterior.coords] if prefix != "X" else None,
    }


if __name__ == "__main__":
    main()
