#!/usr/bin/env python3
"""
snmpy_scanner.py — Fast SNMP printer scanner using snmpy library
=================================================================
Uses snmpy's GETBULK for 10-50x faster OID walk vs net-snmp nodejs.
Called from Node.js agent via child_process.

Usage:
  python snmpy_scanner.py <ip> <community> --walk <base_oid>
  python snmpy_scanner.py <ip> <community> --get <oid1> <oid2>...
  python snmpy_scanner.py <ip> <community> --probe
  python snmpy_scanner.py <ip> <community> --probe-phased  # NDJSON streaming

Output: JSON (--probe) or NDJSON (--probe-phased) to stdout
"""

import sys, json, time, ipaddress, re
from collections import defaultdict
from snmpy import SnmpClient, SnmpVersion

# Standard printer OIDs (from comprehensive doc)
OIDS = {
    # Device Info
    "sysDescr": "1.3.6.1.2.1.1.1.0",
    "sysObjectID": "1.3.6.1.2.1.1.2.0",
    "sysName": "1.3.6.1.2.1.1.5.0",
    "sysLocation": "1.3.6.1.2.1.1.6.0",
    "sysUptime": "1.3.6.1.2.1.1.3.0",
    # Device MIB
    "prtGeneralDeviceModel": "1.3.6.1.2.1.43.5.1.1.16.1",
    "prtGeneralDeviceSerial": "1.3.6.1.2.1.43.5.1.1.17.1",
    "prtGeneralDeviceID": "1.3.6.1.2.1.43.5.1.1.18.1",
    "hrDeviceStatus": "1.3.6.1.2.1.25.3.2.1.5.1",
    
    # Counter
    "prtMarkerTable": "1.3.6.1.2.1.43.10.2",
    "prtMarkerLifeCount": "1.3.6.1.2.1.43.10.2.1.4",
    "prtMarkerColorant": "1.3.6.1.2.1.43.10.2.1.7",
    "prtMarkerTech": "1.3.6.1.2.1.43.10.2.1.2",
    
    # Supplies
    "prtMarkerSuppliesTable": "1.3.6.1.2.1.43.11.1.1",
    "prtMarkerSuppliesDesc": "1.3.6.1.2.1.43.11.1.1.6",
    "prtMarkerSuppliesType": "1.3.6.1.2.1.43.11.1.1.2",
    "prtMarkerSuppliesClass": "1.3.6.1.2.1.43.11.1.1.5",
    "prtMarkerSuppliesLevel": "1.3.6.1.2.1.43.11.1.1.9",
    "prtMarkerSuppliesMaxCap": "1.3.6.1.2.1.43.11.1.1.8",
    "prtMarkerSuppliesUnit": "1.3.6.1.2.1.43.11.1.1.7",
    
    # Input Trays
    "prtInputTable": "1.3.6.1.2.1.43.8.2.1",
    "prtInputMediaName": "1.3.6.1.2.1.43.8.2.1.16",
    "prtInputCurrentLevel": "1.3.6.1.2.1.43.8.2.1.10",
    "prtInputMaxCapacity": "1.3.6.1.2.1.43.8.2.1.9",
    
    # Alerts
    "prtAlertTable": "1.3.6.1.2.1.43.18.1.1",
    "prtAlertText": "1.3.6.1.2.1.43.18.1.1.8",
    "prtAlertSeverity": "1.3.6.1.2.1.43.18.1.1.4",
    
    # Jobs
    "prtJobTable": "1.3.6.1.2.1.43.6.2",
    "prtJobName": "1.3.6.1.2.1.43.6.2.1.3",
    "prtJobOwner": "1.3.6.1.2.1.43.6.2.1.4",
    "prtJobTotalPages": "1.3.6.1.2.1.43.6.2.1.6",
}


def parse_v(val, default=None):
    """Convert snmpy value to Python primitive"""
    if val is None:
        return default
    t = type(val).__name__
    if t in ('SnmpInteger', 'SnmpCounter32', 'SnmpGauge32', 'SnmpCounter64', 'SnmpTimeTicks'):
        return val.value
    elif t == 'SnmpOctetString':
        try:
            s = val.value.decode('utf-8').replace('\x00', '')
            return s
        except:
            return str(val.value)
    elif t == 'SnmpObjectIdentifier':
        return '.'.join(str(x) for x in val.value)
    elif t == 'SnmpIpAddress':
        return str(ipaddress.IPv4Address(val.value))
    elif t in ('SnmpNoSuchObject', 'SnmpNoSuchInstance', 'SnmpEndOfMibView'):
        return None
    return str(val)


def walk_table(client, base_oid, timeout_ms=15000):
    """Fast table walk using snmpy bulk_walk"""
    start = time.time()
    results = {}
    
    try:
        raw = client.bulk_walk(base_oid)
        for oid, val in raw.items():
            results[oid] = parse_v(val)
    except Exception as e:
        return {"error": str(e), "results": {}}
    
    return {"results": results, "count": len(results), "time_ms": round((time.time()-start)*1000)}


def group_by_index(results):
    """Group OID results by table index"""
    grouped = {}
    for oid, val in results.items():
        parts = oid.split('.')
        if len(parts) < 2:
            continue
        # Use last 2 segments as composite key (handles colorant.subindex)
        idx = '.'.join(parts[-2:]) if len(parts) >= 6 else parts[-1]
        col = '.'.join(parts[:-2]) if len(parts) >= 6 else '.'.join(parts[:-1])
        if idx not in grouped:
            grouped[idx] = {}
        grouped[idx][col] = val
    return grouped

def um_to_mm(val):
    if val is None: return None
    try:
        v = int(val)
        if v < 100: return None  # Error codes: -2, -3, -1, 0-99 are invalid
        return v // 1000
    except: return None

def infer_paper_size_str(w_um, h_um):
    """Infer paper size name from dimensions in micrometers"""
    w = um_to_mm(w_um)
    h = um_to_mm(h_um)
    if not w or not h: return None
    sizes = {
        (210, 297): "A4", (297, 210): "A4-L",
        (148, 210): "A5", (210, 148): "A5-L",
        (105, 148): "A6", (148, 105): "A6-L",
        (297, 420): "A3", (420, 297): "A3-L",
        (257, 364): "B4", (364, 257): "B4-L",
        (182, 257): "B5", (257, 182): "B5-L",
        (215, 330): "Legal", (330, 215): "Legal-L",
        (216, 279): "Letter", (279, 216): "Letter-L",
        (250, 353): "B4", (353, 250): "B4-L",
        (176, 250): "B5", (250, 176): "B5-L",
        (114, 162): "Postcard",
        (100, 148): "Postcard",
        (320, 450): "SRA3", (450, 320): "SRA3-L",
        (229, 324): "8.5x14", (324, 229): "8.5x14-L",
        (210, 140): "A5-R",
    }
    # Try exact match
    if (w, h) in sizes: return sizes[(w, h)]
    # Try tolerance ±2mm
    for (sw, sh), name in sizes.items():
        if abs(w - sw) <= 2 and abs(h - sh) <= 2:
            return name
        if abs(w - sh) <= 2 and abs(h - sw) <= 2:
            return name
    # Try common ISO A-series
    if w and h:
        ratio = max(w, h) / min(w, h) if min(w, h) > 0 else 0
        if 1.41 <= ratio <= 1.42:  # sqrt(2)
            if max(w, h) >= 420: return f"A{max(1, round(297/min(w,h)*2))}"
            if min(w, h) >= 297: return f"A{round(297/min(w,h)*2)}"
    return f"{w}x{h}mm"


def deep_walk(client, base_oid, timeout_ms=30000):
    """Full subtree walk — returns flat {oid: value} dict.
       Falls back to bulk_walk then manual GETNEXT if empty."""
    start = time.time()
    
    # Try bulk_walk first
    try:
        raw = client.bulk_walk(base_oid)
        if raw:
            results = {}
            for oid, val in raw.items():
                results[oid] = parse_v(val)
            if results:
                return results, round((time.time()-start)*1000)
    except:
        pass
    
    # Manual GETNEXT walk as fallback
    results = {}
    try:
        next_oid = base_oid
        while True:
            raw = client.get_next(next_oid)
            if raw is None:
                break
            for oid, val in raw.items():
                if not oid.startswith(base_oid):
                    return results, round((time.time()-start)*1000)
                results[oid] = parse_v(val)
                next_oid = oid
    except:
        pass
    
    return results, round((time.time()-start)*1000)


def find_vendor_counters(vendor_raw, result):
    """
    Universal auto-detect BW/Color counters from raw vendor OIDs.
    NO hardcoded OIDs — purely heuristic:
      1. Find integer OIDs that look like page counters (monotonically increasing, large values).
      2. Try sum pair matching against prtMarkerTable total.
      3. Fallback: estimate from supplies (color toner presence).
    """
    counters = {}
    total_pages = result.get("total_pages", 0) or sum(
        int(c["life_count"]) for c in result.get("counters", []) if c.get("life_count")
    )

    # Strategy 1: Find ALL integer OIDs that look like page counters
    # Page counters are: large (500+), positive, not timestamps (< 1B usually)
    candidates = []
    for oid, val in vendor_raw.items():
        try:
            v = int(val)
            if v > 500 and v < 50000000:  # reasonable page range
                candidates.append((oid, v))
        except:
            pass

    # Sort by value descending
    candidates.sort(key=lambda x: -x[1])

    # Strategy 2: Best pair sum matching
    if total_pages > 0 and len(candidates) >= 2:
        # Best match = pair whose sum is closest to total_pages
        best_pair = None
        best_diff = None
        for i in range(min(30, len(candidates))):
            for j in range(i + 1, min(30, len(candidates))):
                s = candidates[i][1] + candidates[j][1]
                diff = abs(s - total_pages)
                pct = diff / max(total_pages, 1)
                if pct < best_diff if best_diff is not None else (pct < 0.5):
                    best_diff = pct
                    best_pair = (candidates[i], candidates[j])
        if best_pair and best_diff < 0.5:
            larger = max(best_pair[0][1], best_pair[1][1])
            smaller = min(best_pair[0][1], best_pair[1][1])
            counters["bw"] = larger
            counters["color"] = smaller
            append_vendor_counter(result, "auto_bw", larger, "black", best_pair[0][0] if best_pair[0][1] >= best_pair[1][1] else best_pair[1][0])
            append_vendor_counter(result, "auto_clr", smaller, "color", best_pair[1][0] if best_pair[1][1] <= best_pair[0][1] else best_pair[0][0])
            return counters

    # Strategy 3: Single counter + color detection → split 70/30
    if total_pages > 0 and len(candidates) >= 1:
        # If only 1 big counter found, assume it's total and split
        toners = result.get("supplies", {}).get("toners", [])
        has_color_toner = any("cyan" in (t.get("description","")).lower() or
                              "magenta" in (t.get("description","")).lower() or
                              "yellow" in (t.get("description","")).lower()
                              for t in toners)
        if has_color_toner:
            counters["bw"] = int(total_pages * 0.7)
            counters["color"] = total_pages - counters["bw"]
            result["vendor_counters_estimated"] = True
            return counters

    return counters


def append_vendor_counter(result, idx, val, colorant, oid):
    """Append a vendor counter entry to result["counters"]"""
    result["counters"].append({
        "index": "vendor_" + idx, "life_count": val,
        "colorant": colorant, "tech": "vendor",
        "vendor_oid": oid,
    })

def probe_printer_deep(client):
    """Deep comprehensive probe — exhaustively walk ALL reachable data"""
    result = {
        "device": {}, "counters": [], "supplies": {"toners": [], "waste": [], "others": []},
        "trays": [], "alerts": [], "jobs": [],
        "raw_oids": {},  # Full dump of ALL discovered OIDs
        "walk_stats": {},
    }
    
    # Step 1: Basic device info (GETs)
    for name, oid in [("sysDescr", OIDS["sysDescr"]), ("sysObjectID", OIDS["sysObjectID"]),
                       ("sysName", OIDS["sysName"]), ("sysLocation", OIDS["sysLocation"]),
                       ("sysUptime", OIDS["sysUptime"]),
                       ("model_raw", OIDS["prtGeneralDeviceModel"]),
                       ("serial", OIDS["prtGeneralDeviceSerial"]),
                       ("deviceID", OIDS["prtGeneralDeviceID"])]:
        val = client.get(oid)
        if val is not None:
            result["device"][name] = parse_v(val)
    
    # Extract model from sysDescr or hrDeviceDescr fallback if prtGeneralDeviceModel failed
    model_raw = result["device"].get("model_raw", "")
    sys_descr = result["device"].get("sysDescr", "")
    if not model_raw:
        # Try hrDeviceDescr from the walk (HP inkjets have model here)
        hr_raw = result["raw_oids"].get("hrDeviceTable", {})
        hr_model = None
        for oid, val in hr_raw.items():
            if oid.endswith(".3.1"):  # hrDeviceDescr.1
                hr_model = val
                break
        if hr_model:
            result["device"]["model"] = hr_model
        elif sys_descr:
            # Extract model pattern from sysDescr (e.g. "RICOH IM C2010", "Xerox WorkCentre 7525")
            patterns = [
                r'\b(IM\s+[A-Z][\d]+[A-Za-z\d\-]*)\b',
                r'\b(MP\s+[\d]+[A-Za-z\d\-]*)\b',
                r'\b(WorkCentre[\s\d]+[A-Za-z\d\-]*)\b',
                r'\b(AltaLink[\s\d]+[A-Za-z\d\-]*)\b',
                r'\b(LaserJet[\s\d]+[A-Za-z\d\-]*)\b',
                r'\b(PageWide[\s\d]+[A-Za-z\d\-]*)\b',
                r'\b(OfficeJet[\s\d]+[A-Za-z\d\-]*)\b',
                r'\b(ApeosPort[\s\d]+[A-Za-z\d\-]*)\b',
                r'\b([A-Z]+[\d]+[A-Za-z\d\-]*)\b',  # Generic: letters+digits
            ]
            for pat in patterns:
                m = re.search(pat, sys_descr)
                if m:
                    result["device"]["model"] = m.group(1).strip()
                    break
    else:
        result["device"]["model"] = model_raw
    
    # Step 2: Deep walk ALL standard printer MIB subtrees
    printer_trees = {
        "prtMarkerTable": "1.3.6.1.2.1.43.10.2",
        "prtMarkerSuppliesTable": "1.3.6.1.2.1.43.11.1.1",
        "prtInputTable": "1.3.6.1.2.1.43.8.2.1",
        "prtOutputTable": "1.3.6.1.2.1.43.9.2.1",
        "prtAlertTable": "1.3.6.1.2.1.43.18.1.1",
        "prtJobTable": "1.3.6.1.2.1.43.6.2",
        "prtGeneralTable": "1.3.6.1.2.1.43.5.1.1",
        "prtConsoleTable": "1.3.6.1.2.1.43.16.5.1.2",
        "prtCoverTable": "1.3.6.1.2.1.43.13.4.1",
        "prtLocalizationTable": "1.3.6.1.2.1.43.17.6.1",
        "prtMediumTable": "1.3.6.1.2.1.43.12.1.1",
        "hrDeviceTable": "1.3.6.1.2.1.25.3.2.1",
        "hrStorageTable": "1.3.6.1.2.1.25.2.3.1",
        "ifTable": "1.3.6.1.2.1.2.2.1",
        "ipTable": "1.3.6.1.2.1.4.20.1",
    }
    
    for name, subtree in printer_trees.items():
        try:
            raw, ms = deep_walk(client, subtree)
            result["raw_oids"][name] = raw
            result["walk_stats"][name] = {"count": len(raw), "time_ms": ms}
        except:
            result["walk_stats"][name] = {"count": 0, "error": str(sys.exc_info()[1])}
    
    # Step 3: Walk vendor subtree — use sysObjectID parent as base (narrower, faster)
    sys_obj_id = result["device"].get("sysObjectID", "")
    vendor_base = None
    if sys_obj_id:
        # Strip last component of sysObjectID to get device-class subtree
        oid_parts = str(sys_obj_id).strip(".").split(".")
        if len(oid_parts) > 2:
            vendor_base = ".".join(oid_parts[:-1])
    
    if vendor_base:
        try:
            vendor_raw, ms = deep_walk(client, vendor_base)
            result["raw_oids"]["vendor"] = vendor_raw
            result["walk_stats"]["vendor"] = {"count": len(vendor_raw), "time_ms": ms}
        except:
            result["walk_stats"]["vendor"] = {"count": 0, "error": str(sys.exc_info()[1])}
    
    # Step 4: Parse structured data from raw_oids
    # Counters from prtMarkerTable
    markers = result["raw_oids"].get("prtMarkerTable", {})
    if markers:
        grouped = group_by_index(markers)
        for idx, row in grouped.items():
            life = row.get("1.3.6.1.2.1.43.10.2.1.4", 0)
            colorant = row.get("1.3.6.1.2.1.43.10.2.1.7", "unknown")
            tech = row.get("1.3.6.1.2.1.43.10.2.1.2", "")
            result["counters"].append({
                "index": idx, "life_count": life, "colorant": colorant, "tech": tech
            })
    
    # Supplies — Tier 1: prtMarkerSuppliesTable (standard Printer MIB, laser printers)
    supplies_raw = result["raw_oids"].get("prtMarkerSuppliesTable", {})
    if supplies_raw:
        grouped = group_by_index(supplies_raw)
        for idx, row in sorted(grouped.items()):
            desc = ""
            level = None
            max_cap = None
            sup_type = None
            sup_class = None
            for col_oid, val in row.items():
                if col_oid.endswith(".6"): desc = val
                elif col_oid.endswith(".9"): level = val
                elif col_oid.endswith(".8"): max_cap = val
                elif col_oid.endswith(".2"): sup_type = val
                elif col_oid.endswith(".5"): sup_class = val
            
            if not desc:
                continue
            
            pct = None
            if level is not None and max_cap and int(max_cap) > 0:
                lv = int(level)
                mc = int(max_cap)
                if lv >= 0:
                    # Some printers (HP inkjet/PageWide) report pages-remaining
                    # (e.g. 3603, 20800, >32700) instead of a percentage.
                    # max_cap <= 100 does NOT mean level is a valid percent —
                    # only accept values that are actually 0-100.
                    if mc <= 100 and lv <= 100:
                        pct = min(100, max(0, lv))
                    elif mc > 100:
                        pct = min(100, max(0, round((lv / mc) * 100)))
                    # else: level is pages-remaining → leave None for JS estimation
            # Non-original chip: keep empty for JS estimation
            if level is not None and int(level) < 0:
                pct = None
            
            item = {"index": idx, "description": desc, "percentage": pct, "level_raw": level, "max_capacity": max_cap}
            
            sc = str(sup_class) if sup_class else ""
            sd = str(desc).lower()
            if sc == "4" or "waste" in sd:
                result["supplies"]["waste"].append(item)
            elif sc in ("3", "8") or "toner" in sd or "ink" in sd or "cartridge" in sd or any(k in sd for k in ("black toner", "cyan toner", "magenta toner", "yellow toner", "imaging unit")):
                # sup_class 9 = drum/other consumable → exclude from toner list
                result["supplies"]["toners"].append(item)
            else:
                result["supplies"]["others"].append(item)
    
    # Supplies — Tier 2: prtMediumTable fallback (HP inkjets & PageWide)
    # Column 4 = media description (e.g. "cyan ink"), Column 5 = remaining %
    if not result["supplies"]["toners"]:
        medium_raw = result["raw_oids"].get("prtMediumTable", {})
        if medium_raw:
            medium_grouped = group_by_index(medium_raw)
            for idx, row in sorted(medium_grouped.items()):
                desc = ""
                pct_raw = None
                for col_oid, val in row.items():
                    if col_oid.endswith(".4"): desc = val
                    elif col_oid.endswith(".5"): pct_raw = val
                if not desc:
                    continue
                sd = str(desc).lower()
                if any(k in sd for k in ("ink", "toner", "black", "cyan", "magenta", "yellow")):
                    pct = 0
                    if pct_raw is not None:
                        try:
                            pct = min(100, max(0, int(pct_raw)))
                        except:
                            pass
                    result["supplies"]["toners"].append({
                        "index": idx, "description": desc, "percentage": pct,
                        "level_raw": pct_raw, "max_capacity": None, "source": "prtMediumTable"
                    })
    
    # Supplies — Tier 3: Vendor-specific HP host-resource cartridge OIDs
    # HP uses 1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.2 subtree for remaining cartridge levels
    if not result["supplies"]["toners"]:
        vendor_raw = result["raw_oids"].get("vendor", {})
        hp_cart_oids = {}
        for oid, val in vendor_raw.items():
            if ".4.2.1.4.1.2." in oid:
                hp_cart_oids[oid] = val
        if hp_cart_oids:
            color_map = {"3": "Black Cartridge", "4": "Black Cartridge",
                         "5": "Cyan Cartridge", "6": "Yellow Cartridge", "7": "Magenta Cartridge"}
            for oid, val in hp_cart_oids.items():
                parts = oid.split(".")
                last = parts[-1] if parts else ""
                if last in color_map:
                    try:
                        pct = min(100, max(0, int(val))) if val is not None else 0
                    except:
                        pct = 0
                    result["supplies"]["toners"].append({
                        "index": last, "description": color_map[last],
                        "percentage": pct, "level_raw": val, "max_capacity": 100,
                        "source": "hp_cartridge"
                    })
    
    # Supplies — Tier 4: Synthetic auto-create when NO supply data at all
    # Uses marker count to guess toner types, sets level=-2 for JS estimation
    if not result["supplies"]["toners"]:
        has_color = any(int(c.get("colorant", 0)) > 0 for c in result["counters"])
        toner_count = max(len(result["counters"]), 4 if has_color else 1)
        toner_colors = ["Black", "Cyan", "Magenta", "Yellow"][:toner_count]
        if toner_count == 1:
            toner_colors = ["Black"]
        for i, color in enumerate(toner_colors):
            result["supplies"]["toners"].append({
                "index": str(i + 1), "description": f"{color} Toner",
                "percentage": None, "level_raw": -2, "max_capacity": None,
                "source": "synthetic",
            })
        result["supplies"]["synthetic"] = True
        # Also create synthetic waste container — estimated from page count
        total_pages_synth = sum(int(c.get("life_count", 0)) for c in result["counters"] if c.get("life_count"))
        if total_pages_synth > 0:
            # Typical waste container holds ~10% of total page volume
            # If device has < 5000 pages, waste < 50% (still room)
            # If > 50000 pages, waste likely full
            est_waste_pct = min(100, max(0, round(total_pages_synth / 500)))
            result["supplies"]["waste"].append({
                "index": "synthetic", "description": "Waste Toner (Est.)",
                "percentage": est_waste_pct, "level_raw": est_waste_pct,
                "max_capacity": 100, "source": "synthetic",
            })
    
    # Trays from prtInputTable
    trays_raw = result["raw_oids"].get("prtInputTable", {})
    if trays_raw:
        grouped = group_by_index(trays_raw)
        for idx, row in sorted(grouped.items()):
            tray = {"index": idx}
            for col_oid, val in row.items():
                if col_oid.endswith(".13"): tray["name"] = val  # Tray 1, Bypass
                elif col_oid.endswith(".12"): tray["media_name"] = val  # Plain 2, iso-a4-white
                elif col_oid.endswith(".10"): tray["sheets"] = val
                elif col_oid.endswith(".9"): tray["max_capacity"] = val
                elif col_oid.endswith(".4"): tray["dim_x_um"] = val  # media dim feed dir
                elif col_oid.endswith(".5"): tray["dim_y_um"] = val  # media dim y
                elif col_oid.endswith(".20"): tray["weight_gm2"] = val  # actual weight
                elif col_oid.endswith(".8"): tray["weight_rating"] = val  # weight rating
                elif col_oid.endswith(".21"): tray["media_type"] = val  # bond, stationery
                elif col_oid.endswith(".22"): tray["media_color"] = val  # white, blue
            # Only compute dims from valid measurements (skip -2, -3 error codes)
            dx = tray.get("dim_x_um")
            dy = tray.get("dim_y_um")
            try:
                dx_valid = int(dx) > 100 if dx else False
                dy_valid = int(dy) > 100 if dy else False
            except:
                dx_valid = dy_valid = False
            if dx_valid and dy_valid:
                w = um_to_mm(dx)
                h = um_to_mm(dy)
                if w and h:
                    tray["dimensions_mm"] = f"{w}x{h}"
                    tray["size_name"] = infer_paper_size_str(dx, dy)
            result["trays"].append(tray)
    
    # Alerts from prtAlertTable
    alerts_raw = result["raw_oids"].get("prtAlertTable", {})
    if alerts_raw:
        grouped = group_by_index(alerts_raw)
        for idx, row in sorted(grouped.items()):
            text = ""
            severity = 0
            for col_oid, val in row.items():
                if col_oid.endswith(".8"): text = val
                elif col_oid.endswith(".4"): severity = val
            if text:
                result["alerts"].append({"index": idx, "text": text, "severity": severity})
    
    # Jobs from prtJobTable
    jobs_raw = result["raw_oids"].get("prtJobTable", {})
    if jobs_raw:
        grouped = group_by_index(jobs_raw)
        for idx, row in sorted(grouped.items()):
            name = ""
            pages = 0
            for col_oid, val in row.items():
                if col_oid.endswith(".3"): name = val
                elif col_oid.endswith(".6"): pages = val
            if name or pages:
                result["jobs"].append({"index": idx, "name": name, "pages": pages})
    
    # ===== Counters: multi-tier detection =====
    sys_obj_id = result["device"].get("sysObjectID", "")
    std_markers = len(result["counters"])
    total_bw, total_color, total_pages = 0, 0, 0

    # Tier 1: Direct GET known vendor OIDs (proven, per-brand tests)
    # These OIDs were verified accurate across multiple printer generations.
    known_pairs = [
        # Ricoh (tested: IM C2010, IM C3010, SP series)
        (".367.", "1.3.6.1.4.1.367.3.2.1.2.19.5.1.9.22",
                 "1.3.6.1.4.1.367.3.2.1.2.19.5.1.9.21"),
        # HP LaserJet & PageWide (tested: M402, M454, M507, M527, PageWide Pro)
        (".4.1.11", "1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.2.6.0",
                   "1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.2.7.0"),
        # Canon (tested: imageRUNNER series)
        (".4.1.1602", "1.3.6.1.4.1.1602.1.11.1.3.1.4.109",
                     "1.3.6.1.4.1.1602.1.11.1.3.1.4.106"),
    ]
    known_bw, known_color = None, None
    for prefix, bw_oid, clr_oid in known_pairs:
        if str(sys_obj_id).startswith(prefix) or prefix in str(sys_obj_id):
            try:
                bw_v = parse_v(client.get(bw_oid))
                clr_v = parse_v(client.get(clr_oid))
                if bw_v is not None and clr_v is not None:
                    known_bw = int(bw_v)
                    known_color = int(clr_v)
                    if known_bw > 0 or known_color > 0:
                        break
            except: pass
    
    if known_bw is not None and known_color is not None and (known_bw > 0 or known_color > 0):
        result["total_bw"] = known_bw or 0
        result["total_color"] = known_color or 0
        result["total_pages"] = result["total_bw"] + result["total_color"]
        result["counter_source"] = "vendor_known"
    else:
        # Tier 2: Xerox/Fuji sub-unit table (standard MIB, proven format)
        xerox_bw, xerox_color = 0, 0
        xerox_prefixes = [".253.", ".253", ".297.", ".297"]
        if any(p in str(sys_obj_id) for p in xerox_prefixes):
            try:
                raw, _ = deep_walk(client, "1.3.6.1.4.1.253.8.53.13.2.1.6")
                for oid, val in raw.items():
                    parts = oid.split(".")
                    if "101" in parts and "20" in parts:
                        try:
                            vi = int(val) if val is not None else 0
                            if parts[-1] == "1" and vi > 0: xerox_bw = vi
                            elif parts[-1] == "2" and vi > 0: xerox_color = vi
                        except: pass
            except: pass
        if xerox_bw > 0 and xerox_color > 0:
            result["total_bw"] = xerox_bw
            result["total_color"] = xerox_color
            result["total_pages"] = xerox_bw + xerox_color
            result["counter_source"] = "vendor_discovered"
        else:
            # Tier 3: Auto-detect from vendor subtree (sysObjectID parent walk)
            vendor_raw = result["raw_oids"].get("vendor", {})
            if vendor_raw:
                vc = find_vendor_counters(vendor_raw, result)
                if vc.get("bw") and vc.get("color"):
                    result["total_bw"] = int(vc["bw"])
                    result["total_color"] = int(vc["color"])
                    result["total_pages"] = result["total_bw"] + result["total_color"]
                    result["counter_source"] = "vendor_discovered"
            
            # Tier 4: prtMarkerTable colorant-split (standard Printer MIB)
            if "total_bw" not in result:
                for c in result["counters"]:
                    count = int(c["life_count"]) if c["life_count"] else 0
                    cl = str(c["colorant"]).lower() if c["colorant"] else ""
                    if cl in ("black", "bk", "", "0"):
                        total_bw += count
                    else:
                        total_color += count
                if total_bw > 0 or total_color > 0:
                    result["total_bw"] = total_bw
                    result["total_color"] = total_color
                    result["total_pages"] = total_bw + total_color
                    result["counter_source"] = "total_only" if total_color == 0 else "standard"
                else:
                    # No counters found at all
                    result["total_pages"] = 0
                    result["total_bw"] = 0
                    result["total_color"] = 0
                    result["counter_source"] = "none"
    
    return result


def detect_vendor(sys_descr, sys_object_id):
    """Detect printer vendor from sysDescr and sysObjectID"""
    desc_upper = (sys_descr or "").upper()
    oid = str(sys_object_id or "")
    
    vendors = [
        (("canon", "1.3.6.1.4.1.1602"), "canon"),
        (("brother", "1.3.6.1.4.1.2435"), "brother"),
        (("ricoh", "1.3.6.1.4.1.367"), "ricoh"),
        (("epson", "1.3.6.1.4.1.1248"), "epson"),
        (("kyocera", "1.3.6.1.4.1.1347"), "kyocera"),
        (("hp", "hewlett", "1.3.6.1.4.1.11"), "hp"),
        (("konica", "minolta", "1.3.6.1.4.1.18334"), "konicaminolta"),
        (("sharp", "1.3.6.1.4.1.2383"), "sharp"),
        (("toshiba", "1.3.6.1.4.1.5005"), "toshiba"),
        (("fuji","xerox", "fuji xerox", "1.3.6.1.4.1.253", "1.3.6.1.4.1.128", "1.3.6.1.4.1.297"), "xerox"),
    ]
    
    for keywords, vendor in vendors:
        kws = keywords if isinstance(keywords, tuple) else (keywords,)
        for kw in kws:
            if kw in desc_upper or oid.startswith(kw):
                return vendor
            if kw.startswith("1.") and oid.startswith(kw):
                return vendor
    return "unknown"


def is_printer(sys_descr):
    """Check if device is a printer"""
    if not sys_descr:
        return False
    kw = ("printer", "mfp", "mfc", "mfcp", "copier", "laserjet", "pagewide",
          "officejet", "workforce", "imagerunner", "taskalfa", "ecosys", "bizhub",
          "ricoh", "canon", "brother", "hp ", "hp-", "epson", "kyocera", "xerox",
          "fuji", "apeosport", "workcentre", "altalink", "versalink", "b9105",
          "multifunction", "digital copier", "smart device", "laser writer",
          "sharp", "toshiba", "konicaminolta", "e-studio")
    # Also check sysObjectID against known printer vendors
    desc = str(sys_descr).lower()
    return any(k in desc for k in kw)


def emit_phase(phase, data):
    """Emit a JSON line for a probe phase (NDJSON streaming)."""
    data["phase"] = phase
    sys.stdout.write(json.dumps(data, default=str) + "\n")
    sys.stdout.flush()

def probe_phased(client, args, sys_descr, sys_obj_id):
    """Phased probe — emits NDJSON per phase for progressive streaming."""
    vendor = detect_vendor(sys_descr, sys_obj_id)
    
    # Phase 1: Identity (fast GETs, no walking)
    identity = {}
    for name, oid in [("sysDescr", OIDS["sysDescr"]), ("sysObjectID", OIDS["sysObjectID"]),
                       ("sysName", OIDS["sysName"]), ("sysLocation", OIDS["sysLocation"]),
                       ("sysUptime", OIDS["sysUptime"]),
                       ("model_raw", OIDS["prtGeneralDeviceModel"]),
                       ("serial", OIDS["prtGeneralDeviceSerial"]),
                       ("deviceID", OIDS["prtGeneralDeviceID"])]:
        val = client.get(oid)
        if val is not None:
            identity[name] = parse_v(val)
    # Try hrDeviceDescr for model name (HP inkjets, some lasers) — GET instead of walk
    try:
        hr_desc = client.get("1.3.6.1.2.1.25.3.2.1.3.1")
        if hr_desc is not None:
            identity["hrDeviceDescr"] = parse_v(hr_desc)
    except:
        pass
    # Extract model from hrDeviceDescr or sysDescr if prtGeneralDeviceModel failed
    model_raw = identity.get("model_raw", "")
    if not model_raw and identity.get("hrDeviceDescr"):
        identity["model"] = identity["hrDeviceDescr"]
    elif not model_raw and identity.get("sysDescr"):
        patterns = [
            r'\b(IM\s+[A-Z][\d]+[A-Za-z\d\-]*)\b',
            r'\b(MP\s+[\d]+[A-Za-z\d\-]*)\b',
            r'\b(WorkCentre[\s\d]+[A-Za-z\d\-]*)\b',
            r'\b(AltaLink[\s\d]+[A-Za-z\d\-]*)\b',
            r'\b(ApeosPort[\s\d]+[A-Za-z\d\-]*)\b',
            r'\b(LaserJet[\s\d]+[A-Za-z\d\-]*)\b',
            r'\b(PageWide[\s\d]+[A-Za-z\d\-]*)\b',
            r'\b(OfficeJet[\s\d]+[A-Za-z\d\-]*)\b',
            r'\b(DeskJet[\s\d]+[A-Za-z\d\-]*)\b',
            r'\b([A-Z]+[\d]+[A-Za-z\d\-]*)\b',
        ]
        for pat in patterns:
            m = re.search(pat, identity["sysDescr"])
            if m:
                identity["model"] = m.group(1).strip()
                break
    else:
        identity["model"] = model_raw
    
    emit_phase("identity", {
        "ip": args.ip, "vendor": vendor,
        "model": identity.get("model", ""),
        "serial": identity.get("serial", ""),
        "hostname": identity.get("sysName", args.ip),
        "location": identity.get("sysLocation", ""),
        "descr": identity.get("sysDescr", ""),
        "sys_object_id": identity.get("sysObjectID", ""),
        "uptime_ticks": identity.get("sysUptime"),
        "is_printer": is_printer(identity.get("sysDescr", "")),
    })
    
    # Phase 2: Counters (walk prtMarkerTable)
    counters_raw = {}
    try:
        raw, ms = deep_walk(client, "1.3.6.1.2.1.43.10.2")
        counters_raw = raw
    except:
        pass
    total_bw, total_color, total_pages = 0, 0, 0
    markers = []
    if counters_raw:
        grouped = group_by_index(counters_raw)
        for idx, row in sorted(grouped.items()):
            life = row.get("1.3.6.1.2.1.43.10.2.1.4", 0)
            colorant = row.get("1.3.6.1.2.1.43.10.2.1.7", "")
            tech = row.get("1.3.6.1.2.1.43.10.2.1.2", "")
            markers.append({"idx": idx, "life": life, "colorant": colorant, "tech": tech})
            total_pages += int(life) if life else 0
            cl = str(colorant).lower() if colorant else ""
            if cl in ("black", "bk", "", "0"):
                total_bw += int(life) if life else 0
            else:
                total_color += int(life) if life else 0
    
    # Counters: known OIDs > Xerox subunit > marker colorant-split (NO estimation)
    sys_oid = identity.get("sysObjectID", "")
    bw_v, clr_v = 0, 0

    # Tier 1: Direct GET known vendor OIDs (proven per-brand)
    known_pairs = [
        (".367.", "1.3.6.1.4.1.367.3.2.1.2.19.5.1.9.22",
                 "1.3.6.1.4.1.367.3.2.1.2.19.5.1.9.21"),
        (".4.1.11", "1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.2.6.0",
                   "1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.2.7.0"),
        (".4.1.1602", "1.3.6.1.4.1.1602.1.11.1.3.1.4.109",
                     "1.3.6.1.4.1.1602.1.11.1.3.1.4.106"),
    ]
    for prefix, bw_oid, clr_oid in known_pairs:
        if str(sys_oid).startswith(prefix) or prefix in str(sys_oid):
            try:
                r1 = client.get(bw_oid)
                r2 = client.get(clr_oid)
                if r1 is not None and r2 is not None:
                    x, y = int(parse_v(r1)), int(parse_v(r2))
                    if x > 0 or y > 0:
                        bw_v, clr_v = x, y
                        break
            except: pass

    # Tier 2: Xerox/Fuji sub-unit table (standard MIB)
    xerox_prefixes = [".253.", ".253", ".297.", ".297"]
    if bw_v == 0 and clr_v == 0 and any(p in str(sys_oid) for p in xerox_prefixes):
        try:
            raw, _ = deep_walk(client, "1.3.6.1.4.1.253.8.53.13.2.1.6")
            for oid, val in raw.items():
                parts = oid.split(".")
                if "101" in parts and "20" in parts:
                    try:
                        vi = int(val) if val is not None else 0
                        if parts[-1] == "1" and vi > 0: bw_v = vi
                        elif parts[-1] == "2" and vi > 0: clr_v = vi
                    except: pass
        except: pass

    # Apply best available split
    if bw_v > 0 or clr_v > 0:
        total_bw, total_color = bw_v, clr_v
        total_pages = total_bw + total_color
    # else: keep marker-derived total_bw/total_color (NO estimation)
    
    if not markers:
        total_pages, total_bw = 0, 0  # No SNMP data
    
    emit_phase("counters", {"bw": total_bw, "color": total_color, "total": total_pages, "markers": len(markers)})
    
    # Phase 3: Supplies (toner + waste)
    toners, waste = [], []
    try:
        raw, ms = deep_walk(client, "1.3.6.1.2.1.43.11.1.1")
        if raw:
            grouped = group_by_index(raw)
            for idx, row in sorted(grouped.items()):
                desc = ""
                level = None
                max_cap = None
                sup_class = None
                for col_oid, val in row.items():
                    if col_oid.endswith(".6"): desc = val
                    elif col_oid.endswith(".9"): level = val
                    elif col_oid.endswith(".8"): max_cap = val
                    elif col_oid.endswith(".5"): sup_class = val  # sup_class: 3=toner,4=waste,8=ink
                if not desc: continue
                pct = None
                if level is not None and max_cap and int(max_cap) > 0:
                    lv, mc = int(level), int(max_cap)
                    if lv >= 0:
                        pct = min(100, max(0, lv if mc <= 100 else round((lv / mc) * 100)))
                # Handle non-original chip (level=-2): keep as None → will be estimated in JS
                if level is not None and int(level) < 0:
                    pct = None  # non-original chip, JS will estimate
                item = {"desc": desc, "pct": pct, "level": level, "max": max_cap, "sup_class": sup_class}
                sd = str(desc).lower()
                sc = str(sup_class) if sup_class else ""
                # Classify by sup_class first (standardized), then description keywords
                if sc == "4" or "waste" in sd:
                    waste.append(item)
                elif sc in ("3", "8") and "drum" not in sd:
                    toners.append(item)
                elif "toner" in sd or "ink" in sd or "cartridge" in sd:
                    # But NOT drum cartridge
                    if "drum" not in sd:
                        toners.append(item)
                # Catch-all for consumable keywords (only if no sup_class conflict)
                elif not sc and any(k in sd for k in ("black","cyan","magenta","yellow")) and "drum" not in sd:
                    toners.append(item)
    except:
        pass
    # Synthetic waste fallback for printers with no supply table at all
    if not toners or not waste:
        total_p = total_bw + total_color
        if not waste and total_p > 0:
            est_waste = min(100, max(0, round(total_p / 500)))
            waste.append({"desc": "Waste Toner (Est.)", "pct": est_waste, "level": est_waste, "max": 100, "source": "synthetic"})
    emit_phase("supplies", {"toners": toners, "waste": waste})
    
    # Phase 4: Trays, Alerts, Jobs (optional detail)
    try:
        raw, _ = deep_walk(client, "1.3.6.1.2.1.43.8.2.1")
        trays = []
        if raw:
            grouped = group_by_index(raw)
            for idx, row in sorted(grouped.items()):
                t = {"idx": idx}
                for co, v in row.items():
                    if co.endswith(".13"): t["name"] = v
                    elif co.endswith(".12"): t["media_name"] = v
                    elif co.endswith(".10"): t["sheets"] = v
                    elif co.endswith(".9"): t["max"] = v
                    elif co.endswith(".4"): t["dx"] = v
                    elif co.endswith(".5"): t["dy"] = v
                    elif co.endswith(".20"): t["weight"] = v
                    elif co.endswith(".22"): t["color"] = v
                dx, dy = t.get("dx"), t.get("dy")
                try:
                    dx_ok = int(dx) > 100 if dx else False
                    dy_ok = int(dy) > 100 if dy else False
                except:
                    dx_ok = dy_ok = False
                if dx_ok and dy_ok:
                    w, h = um_to_mm(dx), um_to_mm(dy)
                    if w and h:
                        t["dims"] = f"{w}x{h}mm"
                        t["size"] = infer_paper_size_str(dx, dy)
                trays.append(t)
    except:
        trays = []
    
    try:
        raw, _ = deep_walk(client, "1.3.6.1.2.1.43.18.1.1")
        alerts = []
        if raw:
            grouped = group_by_index(raw)
            for idx, row in sorted(grouped.items()):
                text, sev = "", 0
                for co, v in row.items():
                    if co.endswith(".8"): text = v
                    elif co.endswith(".4"): sev = v
                if text: alerts.append({"text": text, "severity": sev})
    except:
        alerts = []
    
    try:
        raw, _ = deep_walk(client, "1.3.6.1.2.1.43.6.2")
        jobs = []
        if raw:
            grouped = group_by_index(raw)
            for idx, row in sorted(grouped.items()):
                name, pages = "", 0
                for co, v in row.items():
                    if co.endswith(".3"): name = v
                    elif co.endswith(".6"): pages = v
                if name or pages: jobs.append({"name": name, "pages": pages})
    except:
        jobs = []
    
    emit_phase("detail", {"trays": trays, "alerts": alerts, "jobs": jobs})
    
    # Phase 5: Done
    emit_phase("complete", {"timestamp": time.time()})


def main():
    import argparse
    parser = argparse.ArgumentParser(description="snmpy printer scanner")
    parser.add_argument("ip", help="Printer IP address")
    parser.add_argument("--community", default="public", help="SNMP community")
    parser.add_argument("--timeout", type=float, default=3.0, help="SNMP timeout")
    parser.add_argument("--retries", type=int, default=2, help="SNMP retries")
    parser.add_argument("--walk", metavar="OID", help="Walk an OID subtree")
    parser.add_argument("--get", nargs="+", metavar="OID", help="GET one or more OIDs")
    parser.add_argument("--probe", action="store_true", help="Full printer probe")
    parser.add_argument("--probe-phased", action="store_true", help="Phased probe via NDJSON")
    parser.add_argument("--deep", action="store_true", help="Deep exhaustive probe")
    args = parser.parse_args()
    
    try:
        client = SnmpClient(
            host=args.ip,
            community=args.community,
            version=SnmpVersion.V2C,
            timeout=args.timeout,
            retries=args.retries,
        )
    except Exception as e:
        print(json.dumps({"error": f"SNMP init failed: {e}"}))
        sys.exit(1)
    
    with client:
        if args.walk:
            result = walk_table(client, args.walk)
            print(json.dumps(result, indent=2, default=str))
        
        elif args.get:
            result = {}
            for oid in args.get:
                val = client.get(oid)
                result[oid] = parse_v(val)
            print(json.dumps(result, indent=2, default=str))
        
        elif args.probe:
            # Quick sysDescr check
            sys_descr = parse_v(client.get(OIDS["sysDescr"]))
            sys_obj_id = parse_v(client.get(OIDS["sysObjectID"]))
            
            if not sys_descr:
                print(json.dumps({"error": "No SNMP response", "printer": False}))
                sys.exit(0)
            
            vendor = detect_vendor(sys_descr, sys_obj_id)
            is_printer_dev = is_printer(sys_descr)
            
            result = probe_printer_deep(client)
            result["vendor"] = vendor
            result["is_printer"] = is_printer_dev
            result["ip"] = args.ip
            result["hostname"] = result["device"].get("sysName", args.ip)
            result["model"] = result["device"].get("model", "")
            result["serial"] = result["device"].get("serial", "")
            
            print(json.dumps(result, indent=2, default=str))
        
        elif args.probe_phased:
            sys_descr = parse_v(client.get(OIDS["sysDescr"]))
            sys_obj_id = parse_v(client.get(OIDS["sysObjectID"]))
            if not sys_descr:
                emit_phase("identity", {"ip": args.ip, "vendor": "unknown", "is_printer": False, "error": "No SNMP response"})
                emit_phase("complete", {"timestamp": time.time()})
                sys.exit(0)
            probe_phased(client, args, sys_descr, sys_obj_id)
        
        else:
            print(json.dumps({"error": "Specify --walk, --get, --probe, or --probe-phased"}))


if __name__ == "__main__":
    main()
