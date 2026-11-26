# Medaillenspiegel, Ergebnisse & Meldungen

Live-Ansicht für einen Wettkampf von [ergebnisse.leichtathletik.de](https://ergebnisse.leichtathletik.de):
Medaillenspiegel (je Altersklasse), Ergebnisse und Meldungen mit Filtern für Altersklasse, Disziplin, Verein und Name,
dazu eine Beamer-Ansicht für die Halle.

## Wettkampf und Design einstellen

In `.github/workflows/aktualisieren.yml` oben:

```yaml
ERGEBNIS_URL: https://ergebnisse.leichtathletik.de/Competitions/Resultoverview/21235   # oder nur die ID
DESIGN: standard        # standard, kfvl-so, sg-weissig
```

ändern und speichern. **Das ist alles** – der Rest läuft automatisch, nach 1–2 Minuten ist die Seite aktualisiert.

## Automatischer Betrieb

Der Workflow startet sich nach jedem Durchlauf selbst neu. Die Pause richtet sich nach dem Wettkampf:

| Betriebsart | Wann | Durchläufe |
|---|---|---|
| **ruhe** | vor dem Wettkampf, abends zwischen zwei Wettkampftagen | alle 30 Minuten (Meldungen aktuell halten) |
| **live** | am Wettkampftag ab 3 Std. vor dem ersten Wettbewerb | etwa alle 1–2 Minuten |
| **fertig** | alles seit einer Stunde offiziell oder Wettkampf vorbei | Schleife endet |

- Es werden nur Listen neu geholt, deren Status sich im Zeitplan geändert hat (z. B. „offiziell“);
  laufende Wettbewerbe zusätzlich alle 10 Minuten, fertige alle 30 Minuten.
- Veröffentlicht wird nur bei Änderungen – am Wettkampftag zusätzlich alle 9 Minuten ein Lebenszeichen.
  Bleibt es länger als 15 Minuten aus, zeigt die Seite einen Hinweis.
- Falls die Schleife doch abreißt: *Actions → Ergebnisse aktualisieren → Run workflow*
  (stündlich versucht GitHub das auch selbst, leider unzuverlässig).
- Ganz anhalten: *Actions → Ergebnisse aktualisieren → ⋯ → Disable workflow*.

## Seite

- `#medaillen`, `#ergebnisse`, `#meldungen` – die drei Reiter
- Klick auf einen Namen zeigt alle Ergebnisse bzw. Meldungen dieser Person
- `#beamer` – Vollbild-Ansicht für die Halle: Medaillenspiegel und neueste Ergebnisse im Wechsel
  (Doppelklick = Vollbild, Esc = zurück)
- Die Seite fragt jede Minute nur eine kleine Datei (`daten/version.json`) ab und lädt die Ergebnisse nur bei Änderungen.

## Designs

Das Standard-Design legt `DESIGN` im Workflow fest (siehe oben). Über die Adresse lässt sich trotzdem jedes Design aufrufen – praktisch zum Einbetten auf Vereins-/Verbandsseiten:

| Design | Adresse |
|---|---|
| Standard | `https://tobaskus.github.io/wkb/?design=standard` |
| KFVL Sächsische Schweiz-Osterzgebirge | `https://tobaskus.github.io/wkb/?design=kfvl-so` |
| SG Freital-Weißig 1861 | `https://tobaskus.github.io/wkb/?design=sg-weissig` |

Auch mit Reiter, z. B. `?design=kfvl-so#beamer`.

**Neues Design hinzufügen:** Logo nach `designs/<name>/logo.png` legen, in `index.html` im `<style>` einen Block
`:root[data-design="<name>"]{...}` mit den Farben anlegen (Vorlage: `kfvl-so`), in `DESIGNS` Logo, Name und Link eintragen
und den Namen im Workflow-Kommentar bei `DESIGN` ergänzen.

## Einstellungen

- Oben in `index.html` im Block `CONFIG`: Wertung nach Verein oder Landesverband, Wartezeit nach „offiziell“ (5 Min.),
  Abfrageintervall, Hinweis bei veralteten Daten, Beamer-Wechselzeit.
- Oben in `.github/workflows/aktualisieren.yml`: Pausen (`PAUSE_LIVE`, `PAUSE_RUHE`) und Lebenszeichen.

## Dateien

- `abholen.py` – holt und bereitet die Daten auf (`python abholen.py <ID> <ordner> --zustand zustand.json --modus modus.json`)
- `index.html` – die Seite
- `designs/` – Logos der Designs
- `.github/workflows/aktualisieren.yml` – der automatische Betrieb
