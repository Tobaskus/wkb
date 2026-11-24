# Medaillenspiegel, Ergebnisse & Meldungen

Live-Ansicht für einen Wettkampf von [ergebnisse.leichtathletik.de](https://ergebnisse.leichtathletik.de):
Medaillenspiegel (je Altersklasse), Ergebnisse und Meldungen mit Filtern für Altersklasse, Disziplin, Verein und Name.

## So funktioniert es

- `.github/workflows/aktualisieren.yml` läuft alle 5 Minuten (GitHub startet oft etwas später),
  holt mit `abholen.py` Zeitplan, Meldelisten und Ergebnislisten ab und veröffentlicht
  `index.html` + `daten/ergebnisse.json` über GitHub Pages.
- Die Seite lädt die Daten jede Minute neu. Ergebnisse erscheinen erst, wenn sie seit
  mindestens 5 Minuten offiziell sind.

## Anderen Wettkampf einstellen

In `.github/workflows/aktualisieren.yml` die Zeile `ERGEBNIS_URL:` ändern
(jede Seite des Wettkampfs oder nur die Wettkampf-ID).

## Weitere Einstellungen

Oben in `index.html` im Block `CONFIG`: Wertung nach Verein oder Landesverband,
Wartezeit nach „offiziell“, Aktualisierungsintervall, Vorläufe anzeigen.

## Nach dem Wettkampf

Unter *Actions → Ergebnisse aktualisieren → ⋯ → Disable workflow* abschalten.
