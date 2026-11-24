#!/usr/bin/env python3
"""Holt Meldungen und Ergebnisse eines Wettkampfs von ergebnisse.leichtathletik.de
und schreibt sie als kompakte JSON-Datei für den Medaillenspiegel.

Aufruf:  python abholen.py <Wettkampf-URL oder -ID> <Ausgabedatei.json>
         (jede Seite des Wettkampfs geht, z.B. .../Competitions/Resultoverview/18429)
"""
import html
import json
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ZEITZONE = ZoneInfo("Europe/Berlin")  # Zeitangaben auf ergebnisse.leichtathletik.de
UA = "Mozilla/5.0 Medaillenspiegel"
BASIS = "https://ergebnisse.leichtathletik.de"

VORLAUF = re.compile(r"vorl(ä|ae)uf|vorlauf|zwischenl(ä|ae)uf|zwischenlauf|halbfinal|qualifikation|ausscheidung", re.I)
RUNDE = re.compile(r"\s+(Vor/Endkampf|Vorkampf|Endkampf|Finale|Endlauf|Vorl(ä|ae)ufe|Vorlauf|Zwischenl(ä|ae)ufe|Zwischenlauf|"
                   r"Halbfinale|Zeitl(ä|ae)ufe|Zeitlauf|L(ä|ae)ufe|Qualifikation|Ausscheidung|Entscheidung)$", re.I)
CODE = re.compile(r"^([MW]|[MW]J?U\d+|[MW]K?U\d+|[MW]\d+|X)$")
# Staffeln erkennen (Kopfzeile der Meldeliste sagt bei Staffeln trotzdem "Verein")
STAFFEL = re.compile(r"staffel|\d+\s*x\s*\d+", re.I)
# Disziplinen, bei denen ein höherer Meldewert besser ist (Sprung, Wurf, Mehrkampf)
HOEHER_BESSER = re.compile(r"sprung|wurf|sto(ß|ss)|kugel|speer|diskus|hammer|ball|kampf|punkte", re.I)


# ---------------------------------------------------------------- Hilfen
def hole(url, versuche=3):
    for i in range(versuche):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            if i == versuche - 1:
                raise
            time.sleep(2 * (i + 1))


def text(s):
    s = re.sub(r"<[^>]+>", " ", s or "")
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def firstline(block, col, nr=0):
    treffer = re.findall(r'<div class="%s">\s*<div class="firstline">(.*?)</div>' % col, block, re.S)
    return text(treffer[nr]) if len(treffer) > nr else ""


def secondline(block, col):
    m = re.search(r'<div class="%s">\s*<div class="firstline">.*?</div>\s*<div class="secondline">(.*?)</div>' % col, block, re.S)
    return text(m.group(1)) if m else ""


def ist_team(block, disziplin=""):
    if STAFFEL.search(disziplin or ""):
        return True
    kopf = re.search(r'class="blockheader">(.*?)<div class="entryline"', block, re.S)
    verein = kopf and re.search(r'<div class="col-2">.*?class="secondline">(.*?)</div>', kopf.group(1), re.S)
    return not (verein and "verein" in text(verein.group(1)).lower())


def klassen_name(code):
    m = re.match(r"^([MW])(K?)(J?)U(\d+)$", code)
    if m:
        g = "Männliche" if m.group(1) == "M" else "Weibliche"
        return "%s %s U%s" % (g, "Kinder" if m.group(2) else "Jugend", m.group(4))
    m = re.match(r"^([MW])(\d+)$", code)
    if m:
        return ("Jugend %s" if int(m.group(2)) < 30 else "Senioren %s") % code
    return {"M": "Männer", "W": "Frauen", "X": "Männer & Frauen"}.get(code, code)


def klassen_sortierung(code):
    """Männer/Frauen, Senioren, dann Jugend absteigend (U20 … U8), Sonstiges zuletzt."""
    g = 0 if code.startswith("M") else 1
    if code in ("M", "W"):
        return (0, 0, g)
    m = re.match(r"^[MW]K?J?U(\d+)$", code) or re.match(r"^[MW](\d+)$", code)
    if m:
        n = int(m.group(1))
        if n >= 30:
            return (1, n, g)
        # Einzeljahrgänge (M13, W12) gehören zur nächsthöheren U-Klasse: U14, M13, M12, U12 …
        return (2, -(n + 0.5) if re.match(r"^[MW]\d+$", code) else -n, g)
    return (3, 0, g)


def disziplin_und_runde(name, klassen_namen):
    """'Weitsprung M, MJU20, MJU18 Vor/Endkampf' -> ('Weitsprung', 'Vor/Endkampf')"""
    runde = ""
    m = RUNDE.search(name)
    if m:
        runde = m.group(1)
        name = name[:m.start()]
    woerter = name.split()
    for i in range(1, len(woerter)):
        rest = " ".join(woerter[i:])
        if CODE.match(woerter[i].rstrip(",")) or any(rest.startswith(k) for k in klassen_namen):
            return " ".join(woerter[:i]), runde
    return name.strip(), runde


def offiziell_seit(info):
    """'08.03.2026 14:10 Resultate Offiziell 14:04:23' -> ISO-Zeitpunkt oder None"""
    m = re.search(r"\bOffiziell\s+(\d{1,2}):(\d{2})(?::(\d{2}))?", info)
    d = re.search(r"(\d{2})\.(\d{2})\.(\d{4})", info)
    if not m or not d:
        return None
    t = datetime(int(d.group(3)), int(d.group(2)), int(d.group(1)),
                 int(m.group(1)), int(m.group(2)), int(m.group(3) or 0), tzinfo=ZEITZONE)
    return t.isoformat()


def leistung_zahl(s):
    """'2:03,93' -> 123.93, '6,22' -> 6.22, sonst None"""
    s = re.sub(r"[^\d:,.]", "", s or "").replace(",", ".")
    if not re.search(r"\d", s):
        return None
    try:
        teile = [float(x) for x in s.split(":")]
    except ValueError:
        return None
    wert = 0.0
    for t in teile:
        wert = wert * 60 + t
    return wert


# ---------------------------------------------------------------- Ergebnisliste
def parse_ergebnisse(seite, disziplin=""):
    info = text((re.search(r'class="listheader">.*?<div style="font-weight: normal;">(.*?)</div>', seite, re.S) or [None, ""])[1])
    bloecke = []
    for teil in re.split(r'<div class="runblock ', seite)[1:]:
        art = teil.split('"', 1)[0]
        team = ist_team(teil, disziplin)
        eintraege = []
        for e in teil.split('<div class="entryline"')[1:]:
            rang = firstline(e, "col-1")
            name1 = firstline(e, "col-2")
            zweite = secondline(e, "col-2")
            team = team or ";" in zweite
            eintraege.append({
                "rang": int(rang) if rang.isdigit() else None,
                "name": name1,
                "verein": name1 if team else zweite,
                "mitglieder": zweite if team else "",
                "lv": firstline(e, "col-3"),
                "jg": secondline(e, "col-3"),
                "ergebnis": firstline(e, "col-4", 0),
                "klasse": firstline(e, "col-4", 1),
                "team": team,
            })
        m = re.search(r"\bc-(\S+)", art)
        bloecke.append({
            "art": "gesamt" if "roundblock" in art else ("klasse" if "classblock" in art else "lauf"),
            "klasse": m.group(1) if m else None,
            "eintraege": eintraege,
        })
    return info, bloecke


def ergebnisse_aufbereiten(bloecke):
    """-> (Ergebnis je Altersklasse, Gesamtergebnis oder None)"""
    gesamt = next((b["eintraege"] for b in bloecke if b["art"] == "gesamt"), [])
    klassen = {b["klasse"]: b["eintraege"] for b in bloecke if b["art"] == "klasse" and b["klasse"]}
    codes = []
    for e in gesamt:
        if e["klasse"] and e["klasse"] not in codes:
            codes.append(e["klasse"])
    if not klassen and gesamt:
        if len(codes) <= 1:
            klassen = {(codes[0] if codes else "?"): gesamt}
        else:  # keine Klassenblöcke: Klassenplätze aus dem Gesamtergebnis ableiten
            for c in codes:
                rest, platz, vorher, n = [], 0, None, 0
                for e in gesamt:
                    if e["klasse"] != c:
                        continue
                    e = dict(e)
                    if e["rang"] is not None:
                        n += 1
                        if e["rang"] != vorher:
                            platz = n
                        vorher = e["rang"]
                        e["rang"] = platz
                    rest.append(e)
                klassen[c] = rest
    mehrere = len([k for k, v in klassen.items() if v]) > 1
    return klassen, (gesamt if mehrere else None)


# ---------------------------------------------------------------- Meldeliste
def parse_meldungen(seite, disziplin):
    teil = seite.split('<div class="registerblock"', 1)
    if len(teil) < 2:
        return []
    teil = teil[1]
    team = ist_team(teil, disziplin)
    liste = []
    for e in teil.split('<div class="entryline"')[1:]:
        name1 = firstline(e, "col-2")
        zweite = secondline(e, "col-2")
        team = team or ";" in zweite
        liste.append({
            "bib": firstline(e, "col-1"),
            "name": name1,
            "verein": name1 if team else zweite,
            "mitglieder": zweite if team else "",
            "lv": firstline(e, "col-3"),
            "jg": secondline(e, "col-3"),
            "meldewert": firstline(e, "col-4"),
            "klasse": firstline(e, "col-5", 0),
            "team": team,
        })
    # nach Meldewert sortieren (Lauf: kleiner besser, Sprung/Wurf: größer besser), bei Gleichstand nach Startnummer
    hoeher = bool(HOEHER_BESSER.search(disziplin))

    def schluessel(e):
        w = leistung_zahl(e["meldewert"])
        bib = int(e["bib"]) if e["bib"].isdigit() else 10 ** 9
        if w is None:
            return (1, 0, bib, e["name"])
        return (0, -w if hoeher else w, bib, e["name"])

    liste.sort(key=schluessel)
    return liste


# ---------------------------------------------------------------- Ablauf
def main(eingabe, ausgabe):
    m = re.search(r"(\d{4,})/?$", eingabe.strip()) or re.search(r"/(\d{4,})(?:/|$)", eingabe)
    if not m:
        sys.exit("Wettkampf-ID nicht erkannt: " + eingabe)
    wid = m.group(1)

    zeitplan = hole("%s/Competitions/Details/%s" % (BASIS, wid))
    titel = text((re.search(r'<h1[^>]*>\s*<div style="flex: 1;">(.*?)</div>', zeitplan, re.S) or [None, ""])[1])

    # Klassennamen aus der Ergebnisübersicht (falls schon vorhanden)
    namen = {}
    try:
        ov = hole("%s/Competitions/Resultoverview/%s" % (BASIS, wid))
        menue = re.search(r'id="EventMenuHeader".*?</ul>', ov, re.S)
        for code, label in re.findall(r'<a href="#([^"]+)">(.*?)</a>', menue.group(0) if menue else "", re.S):
            namen[code] = text(label)
    except Exception:  # noqa: BLE001
        pass

    # Alle Runden aus dem Zeitplan
    runden = []
    for r in re.finditer(r'<a href=(/Competitions/CurrentList/(\d+)/\d+)>\s*<div class="blockround".*?class="roundtime">(.*?)</div>'
                         r'.*?class="mainname">(.*?)</div>.*?class="typename">(.*?)</div>', zeitplan, re.S):
        lid = r.group(2)
        if any(x["id"] == lid for x in runden):
            continue
        haupt = text(r.group(4))
        runde = re.sub(r"\s*\(.*?\)\s*$", "", text(r.group(5)))
        runden.append({"id": lid, "zeit": text(r.group(3)), "haupt": haupt,
                       "name": (haupt + " " + runde).strip(), "url": BASIS + r.group(1)})

    beispiel_codes = ["M", "W", "X"] + ["%s%sU%d" % (g, k, n) for g in "MW" for k in ("J", "K") for n in range(8, 24, 2)] \
        + ["%s%d" % (g, n) for g in "MW" for n in range(6, 16)]
    alle_namen = sorted(set(namen.values()) | {klassen_name(c) for c in beispiel_codes}, key=len, reverse=True)

    def lade(w):
        w["disziplin"], w["runde"] = disziplin_und_runde(w["name"], alle_namen)
        w["vorlauf"] = bool(VORLAUF.search(w["runde"] or w["name"]))
        try:
            info, bloecke = parse_ergebnisse(hole(w["url"]), w["disziplin"])
            w["info"] = info
            w["offiziell"] = offiziell_seit(info)
            w["klassen"], w["gesamt"] = ergebnisse_aufbereiten(bloecke)
        except Exception as e:  # noqa: BLE001
            w.update(info="", offiziell=None, klassen={}, gesamt=None, fehler=str(e))
        try:
            w["meldungen"] = parse_meldungen(hole("%s/Competitions/RegisterList/%s/%s" % (BASIS, w["id"], wid)), w["disziplin"])
        except Exception as e:  # noqa: BLE001
            w["meldungen"] = []
            w["fehler"] = str(e)
        return w

    with ThreadPoolExecutor(max_workers=6) as ex:
        liste = list(ex.map(lade, runden))

    # Meldungen nur in der ersten Runde zeigen (das Finale nach Vorläufen enthält sonst dieselben Athleten nochmal)
    for w in liste:
        w["meldungenZeigen"] = bool(w["meldungen"]) and (
            w["vorlauf"] or not any(x["vorlauf"] and x["haupt"] == w["haupt"] for x in liste))

    codes = set()
    for w in liste:
        codes.update(c for c, v in w["klassen"].items() if v)
        codes.update(e["klasse"] for e in w["meldungen"] if e["klasse"])
    klassen = [{"code": c, "name": namen.get(c) or klassen_name(c)} for c in sorted(codes, key=klassen_sortierung)]

    daten = {
        "wettkampf": titel,
        "quelle": "%s/Competitions/Details/%s" % (BASIS, wid),
        "stand": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "klassen": klassen,
        "wettbewerbe": liste,
    }
    with open(ausgabe, "w", encoding="utf-8") as f:
        json.dump(daten, f, ensure_ascii=False, separators=(",", ":"))

    n_erg = sum(len(v) for w in liste for v in w["klassen"].values())
    n_meld = sum(len(w["meldungen"]) for w in liste if w["meldungenZeigen"])
    fehler = [w["name"] for w in liste if w.get("fehler")]
    print("%s: %d Wettbewerbe, %d Meldungen, %d Ergebniszeilen, %d Fehler" % (titel, len(liste), n_meld, n_erg, len(fehler)))
    for f in fehler:
        print("  Fehler bei:", f)
    if not liste:
        sys.exit("Keine Wettbewerbe im Zeitplan gefunden.")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
