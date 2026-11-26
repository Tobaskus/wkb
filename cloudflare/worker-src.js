/**
 * Medaillenspiegel – Cloudflare Worker
 *
 * - Jede Minute (Cron Trigger) holt der Worker den Zeitplan des Wettkampfs von
 *   ergebnisse.leichtathletik.de und die Listen, die sich geändert haben (plus reihum
 *   ein Fünftel der übrigen, damit jede Liste spätestens nach 5 Minuten aktuell ist).
 * - Das Ergebnis liegt im KV-Speicher "DATEN" (Schlüssel daten:<ID>) und wird unter /daten.json ausgeliefert.
 * - Unter / liefert der Worker die Seite (Medaillenspiegel, Ergebnisse, Meldungen).
 *
 * Einstellungen (Cloudflare → Worker → Settings → Variables and Secrets):
 *   WETTKAMPF   Wettkampf-ID, z. B. 21235  (aus der Adresse auf ergebnisse.leichtathletik.de)
 * Bindung (Settings → Bindings): KV-Namespace mit dem Variablennamen DATEN
 * Zeitplan (Settings → Trigger Events → Cron Triggers):  * * * * *
 */

const BASIS = 'https://ergebnisse.leichtathletik.de';
const MAX_LISTEN_PRO_LAUF = 20;     // je Liste 2 Abrufe (Ergebnis + Meldung) -> max. 40 + Zeitplan
const ROTATION = 5;                 // jede Liste spätestens alle 5 Läufe (Minuten) neu holen
const MIN_SPEICHER_ABSTAND = 110;   // Sekunden zwischen zwei Schreibvorgängen (KV: 1000/Tag frei)
const BROWSER_CACHE = 30;           // Sekunden, die /daten.json an der Edge zwischengespeichert wird

const RE_VORLAUF = /vorl(ä|ae)uf|vorlauf|zwischenl(ä|ae)uf|zwischenlauf|halbfinal|qualifikation|ausscheidung/i;
const RE_RUNDE = /\s+(Vor\/Endkampf|Vorkampf|Endkampf|Finale|Endlauf|Vorl(ä|ae)ufe|Vorlauf|Zwischenl(ä|ae)ufe|Zwischenlauf|Halbfinale|Zeitl(ä|ae)ufe|Zeitlauf|L(ä|ae)ufe|Qualifikation|Ausscheidung|Entscheidung)$/i;
const RE_CODE = /^([MW]|[MW]J?U\d+|[MW]K?U\d+|[MW]\d+|X)$/;
const RE_STAFFEL = /staffel|\d+\s*x\s*\d+/i;
const RE_HOEHER = /sprung|wurf|sto(ß|ss)|kugel|speer|diskus|hammer|ball|kampf|punkte/i;

// ============================================================ Einstieg
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/daten.json') return datenAusliefern(request, env, ctx);
    if (url.pathname === '/aktualisieren' && url.searchParams.get('schluessel') && url.searchParams.get('schluessel') === env.SCHLUESSEL) {
      const bericht = await aktualisieren(env);
      return new Response(JSON.stringify(bericht, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(SEITE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
    }
    return new Response('Nicht gefunden', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(aktualisieren(env).then(b => console.log(JSON.stringify(b))));
  }
};

async function datenAusliefern(request, env, ctx) {
  const wid = wettkampf(env);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const schluessel = new Request(new URL(`/daten.json?wk=${wid}`, request.url).toString());
  if (cache) {
    const treffer = await cache.match(schluessel);
    if (treffer) return treffer;
  }
  const body = await env.DATEN.get(`daten:${wid}`);
  const antwort = new Response(body || JSON.stringify({ fehler: 'Noch keine Daten – der Worker holt sie in der nächsten Minute.' }), {
    status: body ? 200 : 503,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${BROWSER_CACHE}`,
               'access-control-allow-origin': '*' }
  });
  if (cache && body) ctx.waitUntil(cache.put(schluessel, antwort.clone()));
  return antwort;
}

function wettkampf(env) {
  const w = String(env.WETTKAMPF || '').trim().match(/(\d{3,9})\/?$/);
  if (!w) throw new Error('Variable WETTKAMPF fehlt (Wettkampf-ID, z. B. 21235)');
  return w[1];
}

// ============================================================ Aktualisieren
/*
 * Zustand im KV unter "zustand:<ID>": Zeitplan, Klassennamen und je Liste Status, Fingerabdrücke und Inhalt.
 * Ausgelieferte Daten unter "daten:<ID>". Beides wird nur geschrieben, wenn sich etwas geändert hat.
 */
async function aktualisieren(env) {
  const wid = wettkampf(env);
  const jetzt = Math.floor(Date.now() / 1000);
  const lauf = Math.floor(jetzt / 60);
  const alt = (await env.DATEN.get(`zustand:${wid}`, 'json')) || {};
  const z = {
    zeitplanHash: alt.zeitplanHash || '', titel: alt.titel || '', runden: alt.runden || [],
    namen: alt.namen || {}, namenZeit: alt.namenZeit || 0, listen: { ...(alt.listen || {}) }, gespeichert: alt.gespeichert || 0
  };
  let abrufe = 0, geaendert = false;

  // 1. Zeitplan – nur neu auswerten, wenn er sich geändert hat
  const zeitplanUrl = `${BASIS}/Competitions/Details/${wid}`;
  const zp = await holeRoh(zeitplanUrl); abrufe++;
  if (!zp) return { wid, fehler: 'Zeitplan nicht erreichbar' };
  if (zp.hash !== z.zeitplanHash) {
    const zeitplan = zp.text();
    z.titel = text((zeitplan.match(/<h1[^>]*>\s*<div style="flex: 1;">([\s\S]*?)<\/div>/) || [])[1]);
    z.runden = parseZeitplan(zeitplan);
    z.zeitplanHash = zp.hash;
    geaendert = true;
  }

  // 2. Klassennamen aus der Ergebnisübersicht (höchstens stündlich)
  if (jetzt - z.namenZeit > 3600) {
    const ov = await holeRoh(`${BASIS}/Competitions/Resultoverview/${wid}`); abrufe++;
    if (ov) {
      const namen = {};
      const menue = ov.text().match(/id="EventMenuHeader"[\s\S]*?<\/ul>/);
      for (const m of (menue ? menue[0] : '').matchAll(/<a href="#([^"]+)">([\s\S]*?)<\/a>/g)) namen[m[1]] = text(m[2]);
      if (JSON.stringify(namen) !== JSON.stringify(z.namen)) geaendert = true;
      z.namen = namen; z.namenZeit = jetzt;
    }
  }
  const alleNamen = [...new Set([...Object.values(z.namen), ...BEISPIEL_CODES.map(klassenName)])].sort((a, b) => b.length - a.length);

  // 3. Welche Listen werden diesmal geholt? Neue/geänderte zuerst, dann reihum
  //    (fertige Wettbewerbe – seit über 30 Minuten offiziell – nur alle 30 Läufe)
  const dringend = [], reihum = [];
  z.runden.forEach((w, i) => {
    const a = z.listen[w.id];
    if (!a || a.status !== w.status || a.fehler) { dringend.push(w.id); return; }
    const off = offiziellSeit(a.info);
    const fertig = off && Date.parse(off) / 1000 < jetzt - 1800;
    const takt = fertig ? 30 : ROTATION;
    if (i % takt === lauf % takt) reihum.push(w.id);
  });
  const holen = [...dringend, ...reihum].slice(0, MAX_LISTEN_PRO_LAUF);

  let ausgewertet = 0;
  await Promise.all(holen.map(async lid => {
    const w = z.runden.find(x => x.id === lid);
    const [erg, meld] = await Promise.all([holeRoh(w.url), holeRoh(`${BASIS}/Competitions/RegisterList/${lid}/${wid}`)]);
    const a = z.listen[lid];
    const [disziplin] = disziplinUndRunde(w.name, alleNamen);
    const neu = { ...(a || { info: '', klassen: {}, gesamt: null, meldungen: [], hashErg: '', hashMeld: '' }), status: w.status, fehler: false };
    if (erg) {
      if (erg.hash !== neu.hashErg) {
        const [info, bloecke] = parseErgebnisse(erg.text(), disziplin);
        [neu.klassen, neu.gesamt] = ergebnisseAufbereiten(bloecke);
        neu.info = info; neu.hashErg = erg.hash; ausgewertet++;
      }
    } else neu.fehler = true;
    if (meld) {
      if (meld.hash !== neu.hashMeld) {
        neu.meldungen = parseMeldungen(meld.text(), disziplin);
        neu.hashMeld = meld.hash; ausgewertet++;
      }
    } else neu.fehler = true;
    if (!a || a.status !== neu.status || a.fehler !== neu.fehler || a.hashErg !== neu.hashErg || a.hashMeld !== neu.hashMeld) geaendert = true;
    z.listen[lid] = neu;
  }));
  abrufe += holen.length * 2;

  // Listen, die nicht mehr im Zeitplan stehen, entfernen
  for (const lid of Object.keys(z.listen)) if (!z.runden.some(w => w.id === lid)) { delete z.listen[lid]; geaendert = true; }

  const bericht = { wid, runden: z.runden.length, geholt: holen.length, dringend: dringend.length, ausgewertet, abrufe, geaendert };
  if (!geaendert) return { ...bericht, gespeichert: false };

  // 4. Daten zusammenbauen und speichern (höchstens alle MIN_SPEICHER_ABSTAND Sekunden;
  //    beim ersten Befüllen sofort). Wird nicht gespeichert, erkennt der nächste Lauf die Änderung erneut.
  const neueListen = holen.some(lid => !(alt.listen || {})[lid]);
  if (!neueListen && jetzt - z.gespeichert < MIN_SPEICHER_ABSTAND) return { ...bericht, gespeichert: false, warteAufSpeichern: true };

  const daten = datenBauen(z, alleNamen, wid);
  const altDaten = await env.DATEN.get(`daten:${wid}`, 'json');
  const inhaltNeu = JSON.stringify({ ...daten, stand: null });
  const inhaltAlt = altDaten ? JSON.stringify({ ...altDaten, stand: null }) : null;
  z.gespeichert = jetzt;
  if (inhaltNeu !== inhaltAlt) {
    daten.stand = new Date(jetzt * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
    await env.DATEN.put(`daten:${wid}`, JSON.stringify(daten));
  }
  await env.DATEN.put(`zustand:${wid}`, JSON.stringify(z));
  return { ...bericht, gespeichert: true, datenNeu: inhaltNeu !== inhaltAlt };
}

function parseZeitplan(zeitplan) {
  const runden = [];
  const gesehen = new Set();
  const re = /<a href=(\/Competitions\/CurrentList\/(\d+)\/\d+)>\s*<div class="blockround"[\s\S]*?class="roundtime">([\s\S]*?)<\/div>[\s\S]*?class="mainname">([\s\S]*?)<\/div>[\s\S]*?class="typename">([\s\S]*?)<\/div>/g;
  for (const r of zeitplan.matchAll(re)) {
    const lid = r[2];
    if (gesehen.has(lid)) continue;
    gesehen.add(lid);
    const nach = zeitplan.slice(r.index + r[0].length, r.index + r[0].length + 600);
    const status = (nach.match(/class="roundstate ([^"]*)"/) || [])[1] || '';
    const haupt = text(r[4]);
    const runde = text(r[5]).replace(/\s*\(.*?\)\s*$/, '');
    runden.push({ id: lid, zeit: text(r[3]), haupt, name: (haupt + ' ' + runde).trim(), url: BASIS + r[1], status });
  }
  return runden;
}

function datenBauen(z, alleNamen, wid) {
  const liste = [];
  for (const r of z.runden) {
    const l = z.listen[r.id];
    if (!l) continue;   // noch nicht geholt – kommt im nächsten Lauf
    const [disziplin, runde] = disziplinUndRunde(r.name, alleNamen);
    liste.push({
      id: r.id, zeit: r.zeit, haupt: r.haupt, name: r.name, url: r.url,
      disziplin, runde, vorlauf: RE_VORLAUF.test(runde || r.name),
      info: l.info, offiziell: offiziellSeit(l.info), klassen: l.klassen, gesamt: l.gesamt, meldungen: l.meldungen
    });
  }
  // Meldungen nur in der ersten Runde (Finale nach Vorläufen enthält sonst dieselben Athleten)
  for (const w of liste) {
    w.meldungenZeigen = w.meldungen.length > 0 && (w.vorlauf || !liste.some(x => x.vorlauf && x.haupt === w.haupt));
  }
  const codes = new Set();
  for (const w of liste) {
    for (const [c, v] of Object.entries(w.klassen)) if (v.length) codes.add(c);
    for (const e of w.meldungen) if (e.klasse) codes.add(e.klasse);
  }
  const klassen = [...codes].sort((a, b) => vergleicheTupel(klassenSortierung(a), klassenSortierung(b)))
    .map(c => ({ code: c, name: z.namen[c] || klassenName(c) }));
  return { wettkampf: z.titel, quelle: `${BASIS}/Competitions/Details/${wid}`, stand: null, klassen, wettbewerbe: liste };
}

/** Holt eine Seite; liefert { hash, text() } (Fingerabdruck der Rohdaten, Text erst bei Bedarf) oder null */
async function holeRoh(url) {
  for (let versuch = 1; versuch <= 2; versuch++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 Medaillenspiegel' } });
      if (!r.ok) continue;
      const roh = await r.arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-1', roh))].map(b => b.toString(16).padStart(2, '0')).join('');
      return { hash, text: () => new TextDecoder().decode(roh) };
    } catch (e) { /* neuer Versuch */ }
  }
  return null;
}

// ============================================================ Hilfen
const ENTITAETEN = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', oacute: 'ó', ccedil: 'ç',
  ndash: '–', mdash: '—', shy: '­', iacute: 'í', ntilde: 'ñ', scaron: 'š', ccaron: 'č' };

function entschluesseln(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (ganz, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch (x) { return ganz; }
    }
    return ENTITAETEN[e] ?? ganz;
  });
}

function text(s) {
  return entschluesseln(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function firstline(block, col, nr = 0) {
  const re = new RegExp(`<div class="${col}">\\s*<div class="firstline">([\\s\\S]*?)</div>`, 'g');
  const m = [...block.matchAll(re)];
  return m[nr] ? text(m[nr][1]) : '';
}

function secondline(block, col) {
  const re = new RegExp(`<div class="${col}">\\s*<div class="firstline">[\\s\\S]*?</div>\\s*<div class="secondline">([\\s\\S]*?)</div>`);
  const m = block.match(re);
  return m ? text(m[1]) : '';
}

function istTeam(block, disziplin = '') {
  if (RE_STAFFEL.test(disziplin || '')) return true;
  const kopf = block.match(/class="blockheader">([\s\S]*?)<div class="entryline"/);
  if (!kopf) return true;
  const v = kopf[1].match(/<div class="col-2">[\s\S]*?class="secondline">([\s\S]*?)<\/div>/);
  if (!v) return true;
  return !text(v[1]).toLowerCase().includes('verein');
}

function klassenName(code) {
  let m = code.match(/^([MW])(K?)(J?)U(\d+)$/);
  if (m) return `${m[1] === 'M' ? 'Männliche' : 'Weibliche'} ${m[2] ? 'Kinder' : 'Jugend'} U${m[4]}`;
  m = code.match(/^([MW])(\d+)$/);
  if (m) return (+m[2] < 30 ? 'Jugend ' : 'Senioren ') + code;
  return { M: 'Männer', W: 'Frauen', X: 'Männer & Frauen' }[code] || code;
}

const BEISPIEL_CODES = ['M', 'W', 'X'];
for (const g of 'MW') {
  for (const k of 'JK') for (let n = 8; n < 24; n += 2) BEISPIEL_CODES.push(`${g}${k}U${n}`);
  for (let n = 6; n < 16; n++) BEISPIEL_CODES.push(`${g}${n}`);
}

function klassenSortierung(code) {
  const g = code.startsWith('M') ? 0 : 1;
  if (code === 'M' || code === 'W') return [0, 0, g];
  const m = code.match(/^[MW]K?J?U(\d+)$/) || code.match(/^[MW](\d+)$/);
  if (m) {
    const n = +m[1];
    if (n >= 30) return [1, n, g];
    return [2, /^[MW]\d+$/.test(code) ? -(n + 0.5) : -n, g];
  }
  return [3, 0, g];
}

function vergleicheTupel(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (typeof x === 'string' || typeof y === 'string') return String(x) < String(y) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function disziplinUndRunde(name, klassenNamen) {
  let runde = '';
  const m = name.match(RE_RUNDE);
  if (m) { runde = m[1]; name = name.slice(0, m.index); }
  const woerter = name.trim().split(/\s+/);
  for (let i = 1; i < woerter.length; i++) {
    const rest = woerter.slice(i).join(' ');
    if (RE_CODE.test(woerter[i].replace(/,+$/, '')) || klassenNamen.some(k => rest.startsWith(k))) {
      return [woerter.slice(0, i).join(' '), runde];
    }
  }
  return [name.trim(), runde];
}

/** '08.03.2026 14:10 Resultate Offiziell 14:04:23' -> '2026-03-08T14:04:23+01:00' (Zeit in Deutschland) */
function offiziellSeit(info) {
  const m = (info || '').match(/\bOffiziell\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  const d = (info || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m || !d) return null;
  const p = n => String(n).padStart(2, '0');
  const lokal = `${d[3]}-${d[2]}-${d[1]}T${p(m[1])}:${m[2]}:${p(m[3] || 0)}`;
  const versatz = berlinVersatz(Date.UTC(+d[3], +d[2] - 1, +d[1], +m[1], +m[2], +(m[3] || 0)));
  const h = Math.floor(Math.abs(versatz) / 60), min = Math.abs(versatz) % 60;
  return `${lokal}${versatz >= 0 ? '+' : '-'}${p(h)}:${p(min)}`;
}

/** Abstand Europe/Berlin zu UTC in Minuten für eine (als UTC gelesene) Ortszeit */
function berlinVersatz(alsUtc) {
  const teile = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(alsUtc));
  const t = Object.fromEntries(teile.map(x => [x.type, x.value]));
  const berlinAlsUtc = Date.UTC(+t.year, +t.month - 1, +t.day, +t.hour, +t.minute, +t.second);
  let versatz = Math.round((berlinAlsUtc - alsUtc) / 60000);
  // Ortszeit -> UTC: einmal nachkorrigieren (Sommer-/Winterzeit-Wechsel)
  const t2 = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', hourCycle: 'h23', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(alsUtc - versatz * 60000)).map(x => [x.type, x.value]));
  versatz = Math.round((Date.UTC(+t2.year, +t2.month - 1, +t2.day, +t2.hour, +t2.minute, +t2.second) - (alsUtc - versatz * 60000)) / 60000);
  return versatz;
}

function leistungZahl(s) {
  s = String(s || '').replace(/[^\d:,.]/g, '').replace(/,/g, '.');
  if (!/\d/.test(s)) return null;
  let wert = 0;
  for (const teil of s.split(':')) {
    if (!/^(\d+\.?\d*|\.\d+)$/.test(teil)) return null;
    wert = wert * 60 + parseFloat(teil);
  }
  return wert;
}

// ============================================================ Ergebnisliste
function parseErgebnisse(seite, disziplin = '') {
  const info = text((seite.match(/class="listheader">[\s\S]*?<div style="font-weight: normal;">([\s\S]*?)<\/div>/) || [])[1]);
  const bloecke = [];
  for (const teil of seite.split('<div class="runblock ').slice(1)) {
    const art = teil.split('"', 1)[0];
    let team = istTeam(teil, disziplin);
    const eintraege = [];
    for (const e of teil.split('<div class="entryline"').slice(1)) {
      const rang = firstline(e, 'col-1');
      const name1 = firstline(e, 'col-2');
      const zweite = secondline(e, 'col-2');
      team = team || zweite.includes(';');
      eintraege.push({
        rang: /^\d+$/.test(rang) ? parseInt(rang, 10) : null,
        name: name1,
        verein: team ? name1 : zweite,
        mitglieder: team ? zweite : '',
        lv: firstline(e, 'col-3'),
        jg: secondline(e, 'col-3'),
        ergebnis: firstline(e, 'col-4', 0),
        klasse: firstline(e, 'col-4', 1),
        team
      });
    }
    const k = art.match(/\bc-(\S+)/);
    bloecke.push({
      art: art.includes('roundblock') ? 'gesamt' : (art.includes('classblock') ? 'klasse' : 'lauf'),
      klasse: k ? k[1] : null,
      eintraege
    });
  }
  return [info, bloecke];
}

function ergebnisseAufbereiten(bloecke) {
  const g = bloecke.find(b => b.art === 'gesamt');
  const gesamt = g ? g.eintraege : [];
  let klassen = {};
  for (const b of bloecke) if (b.art === 'klasse' && b.klasse) klassen[b.klasse] = b.eintraege;
  const codes = [];
  for (const e of gesamt) if (e.klasse && !codes.includes(e.klasse)) codes.push(e.klasse);
  if (!Object.keys(klassen).length && gesamt.length) {
    if (codes.length <= 1) {
      klassen = { [codes.length ? codes[0] : '?']: gesamt };
    } else {   // keine Klassenblöcke: Klassenplätze aus dem Gesamtergebnis ableiten
      for (const c of codes) {
        const rest = []; let platz = 0, vorher = null, n = 0;
        for (let e of gesamt) {
          if (e.klasse !== c) continue;
          e = { ...e };
          if (e.rang !== null) {
            n++;
            if (e.rang !== vorher) platz = n;
            vorher = e.rang;
            e.rang = platz;
          }
          rest.push(e);
        }
        klassen[c] = rest;
      }
    }
  }
  const mehrere = Object.values(klassen).filter(v => v.length).length > 1;
  return [klassen, mehrere ? gesamt : null];
}

// ============================================================ Meldeliste
function parseMeldungen(seite, disziplin) {
  const i = seite.indexOf('<div class="registerblock"');
  if (i < 0) return [];
  const teil = seite.slice(i + '<div class="registerblock"'.length);
  let team = istTeam(teil, disziplin);
  const liste = [];
  for (const e of teil.split('<div class="entryline"').slice(1)) {
    const name1 = firstline(e, 'col-2');
    const zweite = secondline(e, 'col-2');
    team = team || zweite.includes(';');
    liste.push({
      bib: firstline(e, 'col-1'),
      name: name1,
      verein: team ? name1 : zweite,
      mitglieder: team ? zweite : '',
      lv: firstline(e, 'col-3'),
      jg: secondline(e, 'col-3'),
      meldewert: firstline(e, 'col-4'),
      klasse: firstline(e, 'col-5', 0),
      team
    });
  }
  // nach Meldewert (Lauf: kleiner besser, Sprung/Wurf: größer besser), bei Gleichstand nach Startnummer
  const hoeher = RE_HOEHER.test(disziplin);
  const schluessel = liste.map((e, idx) => {
    const w = leistungZahl(e.meldewert);
    const bib = /^\d+$/.test(e.bib) ? parseInt(e.bib, 10) : 1e9;
    return w === null ? [1, 0, bib, e.name, idx] : [0, hoeher ? -w : w, bib, e.name, idx];
  });
  return liste.map((e, idx) => idx).sort((a, b) => vergleicheTupel(schluessel[a], schluessel[b])).map(idx => liste[idx]);
}

// ============================================================ Seite (wird beim Bauen eingesetzt)
const SEITE = /*SEITE*/'';
