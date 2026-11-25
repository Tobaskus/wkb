# Medaillenspiegel, Ergebnisse & Meldungen

Live-Ansicht für einen Wettkampf von [ergebnisse.leichtathletik.de](https://ergebnisse.leichtathletik.de):
Medaillenspiegel (je Altersklasse), Ergebnisse und Meldungen mit Filtern für Altersklasse, Disziplin, Verein und Name.

## So funktioniert es

- `.github/workflows/aktualisieren.yml` holt mit `abholen.py` Zeitplan, Meldelisten und Ergebnislisten ab
  und veröffentlicht `index.html` + `daten/ergebnisse.json` über GitHub Pages.
- Die Seite lädt die Daten jede Minute neu. Ergebnisse erscheinen erst, wenn sie seit
  mindestens 5 Minuten offiziell sind.

## Live-Modus am Wettkampftag

GitHub startet zeitgesteuerte Läufe sehr unzuverlässig. Deshalb am Wettkampftag einmal von Hand starten:

1. *Actions → Ergebnisse aktualisieren → Run workflow*
2. Bei „Wie viele Stunden automatisch aktualisieren?“ die Dauer eintragen (Standard 12)
3. *Run workflow*

Der Workflow startet sich danach nach jedem Durchlauf selbst neu (etwa alle 2–3 Minuten), bis die Zeit um ist.

**Vorzeitig stoppen:** *Actions → Ergebnisse aktualisieren → ⋯ → Disable workflow*
(vor dem nächsten Wettkampf wieder *Enable workflow*).

## Anderen Wettkampf einstellen

In `.github/workflows/aktualisieren.yml` die Zeile `ERGEBNIS_URL:` ändern
(jede Seite des Wettkampfs oder nur die Wettkampf-ID).

## Weitere Einstellungen

Oben in `index.html` im Block `CONFIG`: Wertung nach Verein oder Landesverband,
Wartezeit nach „offiziell“, Aktualisierungsintervall, Vorläufe anzeigen.

Die Pause zwischen zwei Durchläufen steht in der Workflow-Datei bei `PAUSE_SEKUNDEN`.
