# Medaillenspiegel bei Cloudflare einrichten

Alles geht im Browser, ohne Programme. Dauer: etwa 15 Minuten. Kosten: keine (kostenloser Tarif).

Benötigt wird nur die Datei **`worker.js`** aus diesem Ordner.

## 1. Konto anlegen
Auf **dash.cloudflare.com** kostenlos registrieren (E-Mail bestätigen). Eine eigene Domain ist nicht nötig.

## 2. Worker anlegen
1. Links **Workers & Pages** (bzw. **Compute → Workers & Pages**) → **Create** → **Create Worker** („Hello World“).
2. Namen vergeben, z. B. `medaillenspiegel` → **Deploy**.
3. **Edit code** → den gesamten Beispielcode löschen → Inhalt von `worker.js` einfügen → **Deploy**.

## 3. Speicher anlegen und verbinden
1. Links **Storage & Databases → KV** (bzw. **Workers KV**) → **Create** → Name `medaillenspiegel-daten` → **Create**.
2. Zurück zum Worker → **Settings → Bindings** → **Add** → **KV namespace**
   - Variable name: **`DATEN`** (genau so, Großbuchstaben)
   - KV namespace: `medaillenspiegel-daten` → **Save/Deploy**.

## 4. Wettkampf eintragen
Worker → **Settings → Variables and Secrets** → **Add**
- Type: **Text**, Variable name: **`WETTKAMPF`**, Value: die Wettkampf-ID, z. B. **`21235`**
  (die Zahl am Ende der Adresse auf ergebnisse.leichtathletik.de) → **Deploy**.

## 5. Jede Minute aktualisieren
Worker → **Settings → Trigger Events** (bzw. **Triggers**) → **Add** → **Cron Triggers**
→ Zeitplan „Every minute“ bzw. **`* * * * *`** → **Add/Deploy**.

## 6. Fertig
Die Adresse steht oben beim Worker, z. B. `https://medaillenspiegel.DEINNAME.workers.dev`.
Die ersten Daten sind nach 1–3 Minuten da (vorher steht dort „Ergebnisse konnten nicht geladen werden“).

**Anderer Wettkampf:** nur die Variable `WETTKAMPF` ändern (Schritt 4). Nach 1–3 Minuten erscheint der neue Wettkampf.

**Nach der Saison / Pause:** Cron Trigger (Schritt 5) entfernen – dann ruft der Worker nichts mehr ab.

## In WebsiteBaker einbinden
Neue Seite anlegen, Typ **„Wrapper“** (falls vorhanden) mit der Worker-Adresse – oder in einer
WYSIWYG-Seite im Editor auf **„Quellcode“** schalten und einfügen:

```html
<iframe src="https://medaillenspiegel.DEINNAME.workers.dev/" title="Medaillenspiegel"
        style="width:100%;height:1600px;border:0" loading="lazy"></iframe>
```

## Wie es funktioniert
- Jede Minute holt der Worker den Zeitplan und die Listen, deren Status sich geändert hat
  (z. B. „offiziell“) – das wird sofort übernommen. Laufende Wettbewerbe werden zusätzlich alle
  5 Minuten geprüft, fertige alle 30 Minuten.
- Unveränderte Seiten erkennt er am Fingerabdruck und wertet sie nicht neu aus (spart Rechenzeit).
- Gespeichert wird nur bei Änderungen, höchstens alle 2 Minuten (kostenloser Speicher: 1000 Schreibvorgänge/Tag).
- Die Seite holt die Daten jede Minute neu; Ergebnisse erscheinen erst 5 Minuten nach „offiziell“.

## Für Änderungen am Code
`worker-src.js` (Abruf und Aufbereitung) und `index.html` (Seite) bearbeiten, dann
`python3 build.py` – das erzeugt `worker.js` mit eingebauter Seite.
