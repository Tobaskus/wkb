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
const SEITE = "<!doctype html>\n<html lang=\"de\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Medaillenspiegel Live</title>\n<style>\n:root{\n  --bg:#f5f6f8;--card:#fff;--text:#1b1f24;--muted:#5d6670;--line:#e2e5ea;--row:#fafbfc;--accent:#c8102e;\n  --gold:#d4a514;--silver:#9aa3ad;--bronze:#b06a35;\n}\n@media (prefers-color-scheme: dark){\n  :root:not([data-theme=\"light\"]){--bg:#121417;--card:#1b1e22;--text:#e8eaed;--muted:#9aa2ab;--line:#2c3036;--row:#202429;--accent:#ff4d5e;}\n}\n:root[data-theme=\"dark\"]{--bg:#121417;--card:#1b1e22;--text:#e8eaed;--muted:#9aa2ab;--line:#2c3036;--row:#202429;--accent:#ff4d5e;}\n*{box-sizing:border-box}\nbody{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif}\n.wrap{max-width:900px;margin:0 auto;padding:16px}\nh1{font-size:1.35rem;margin:0 0 2px}\n.ort{font-size:1rem;font-weight:600;margin-bottom:2px}\nh2{font-size:1rem;margin:0}\n.sub{color:var(--muted);font-size:.85rem;margin-bottom:12px}\n.nav{display:flex;gap:4px;overflow-x:auto;box-shadow:inset 0 -2px 0 var(--line);margin-bottom:14px}\n.nav a{padding:8px 14px;text-decoration:none;color:var(--muted);font-weight:600;border-bottom:2px solid transparent;white-space:nowrap}\n.nav a.on{color:var(--text);border-color:var(--accent)}\n.filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:14px}\n.filters label{display:block;font-size:.78rem;color:var(--muted);margin-bottom:3px}\n.filters input{width:100%;font:inherit;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text)}\n.filters select{width:100%;font:inherit;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text)}\n.hint{color:var(--muted);font-size:.82rem;margin:-4px 0 12px}\n.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:6px 14px 10px;margin-bottom:12px}\n.card-head{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline;padding:8px 0 4px}\n.card-head small{color:var(--muted)}\n.tag{display:inline-block;font-size:.72rem;padding:1px 7px;border-radius:999px;background:var(--row);border:1px solid var(--line);color:var(--muted);margin-left:6px;vertical-align:middle}\n.tbl-wrap{overflow-x:auto}\ntable{width:100%;border-collapse:collapse}\nth,td{padding:8px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}\ntbody tr:last-child td{border-bottom:none}\nth{font-size:.78rem;color:var(--muted);font-weight:600}\ntd.n,th.n{text-align:center;width:56px}\ntd.r,th.r{text-align:right}\ntd.name{white-space:normal;min-width:150px}\ntd.wrap{white-space:normal}\ntd small,.muted{color:var(--muted)}\ntbody tr.main{cursor:pointer}\ntbody tr.main:hover{background:var(--row)}\ntbody tr.flash{animation:fl 2.5s}\n@keyframes fl{0%{background:#ffe58a55}100%{background:transparent}}\n.m{display:inline-block;width:22px;height:22px;border-radius:50%;line-height:22px;text-align:center;font-size:.72rem;font-weight:700;color:#fff}\n.m.g{background:var(--gold)}.m.s{background:var(--silver)}.m.b{background:var(--bronze)}\ntd.g{font-weight:700}\ntr.detail td{background:var(--row);white-space:normal;font-size:.86rem}\n.det{display:grid;gap:3px}\n.det div{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}\n.det small{color:var(--muted)}\n.empty{color:var(--muted);padding:14px 0}\n@media (max-width:560px){.nav a{padding:8px 9px}th,td{padding:6px 5px}td.n,th.n{width:38px}.hide-sm{display:none}}\n</style>\n</head>\n<body>\n<div class=\"wrap\">\n  <h1 id=\"title\">Medaillenspiegel</h1>\n  <div class=\"ort\" id=\"datumOrt\"></div>\n  <div class=\"sub\" id=\"stand\">Lade Ergebnisse…</div>\n  <nav class=\"nav\">\n    <a href=\"#medaillen\" id=\"navMed\">Medaillenspiegel</a>\n    <a href=\"#ergebnisse\" id=\"navErg\">Ergebnisse</a>\n    <a href=\"#meldungen\" id=\"navMeld\">Meldungen</a>\n  </nav>\n  <section id=\"viewMed\">\n    <div class=\"card\">\n      <div class=\"tbl-wrap\">\n        <table>\n          <thead><tr>\n            <th class=\"n\">#</th><th id=\"colName\">Verein</th>\n            <th class=\"n\"><span class=\"m g\">G</span></th>\n            <th class=\"n\"><span class=\"m s\">S</span></th>\n            <th class=\"n\"><span class=\"m b\">B</span></th>\n            <th class=\"n\">Σ</th>\n          </tr></thead>\n          <tbody id=\"medBody\"></tbody>\n        </table>\n      </div>\n    </div>\n  </section>\n  <section id=\"viewErg\" hidden>\n    <div class=\"filters\">\n      <div><label for=\"selKlasse\">Altersklasse</label><select id=\"selKlasse\"></select></div>\n      <div><label for=\"selDisz\">Disziplin</label><select id=\"selDisz\"></select></div>\n      <div><label for=\"selVerein\">Verein</label><select id=\"selVerein\"></select></div>\n      <div><label for=\"suche\">Name</label><input id=\"suche\" type=\"search\" placeholder=\"z. B. Wegner oder Till Wegner\" autocomplete=\"off\"></div>\n    </div>\n    <div id=\"ergListe\"></div>\n  </section>\n</div>\n\n<script>\n(() => {\n  // ===================== EINSTELLUNGEN =====================\n  // Welcher Wettkampf abgeholt wird, steht beim Cloudflare Worker in der Variable WETTKAMPF.\n  const CONFIG = {\n    // Daten vom Cloudflare Worker (gleiche Adresse wie diese Seite)\n    quelle: 'daten.json',\n    // Wie oft der Browser nachschaut, in Sekunden (0 = aus)\n    interval: 60,\n    // Wertung: 'club' = nach Verein, 'lv' = nach Landesverband\n    mode: 'club',\n    // Vorläufe auf der Ergebnisseite anzeigen? (zählen nie für Medaillen)\n    vorlaeufeZeigen: true,\n    // Ergebnisse erst übernehmen, wenn sie seit so vielen Minuten offiziell sind\n    wartezeitMinuten: 5\n  };\n  // =========================================================\n\n  const GESAMT = '__gesamt__', ALLE = '__alle__';\n\n  const $ = id => document.getElementById(id);\n  const esc = s => String(s ?? '').replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\n  const medal = r => `<span class=\"m ${r === 1 ? 'g' : r === 2 ? 's' : 'b'}\">${r}</span>`;\n  const store = { get(k){ try { return localStorage.getItem('msp_' + k); } catch (e) { return null; } },\n                  set(k, v){ try { localStorage.setItem('msp_' + k, v); } catch (e) {} } };\n\n  let data = null, open = new Set(), prevTotals = null;\n  let klasse = store.get('klasse') || ALLE;\n  let disziplin = store.get('disziplin') || ALLE;\n  let verein = store.get('verein') || ALLE;\n  let suche = '';\n  // Suche: Groß/Klein und Akzente egal, alle Wörter müssen vorkommen (Reihenfolge egal: \"Till Wegner\" findet \"Wegner Till\")\n  const norm = t => String(t || '').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/ß/g, 'ss');\n  const passtZurSuche = e => {\n    const woerter = norm(suche).split(/\\s+/).filter(Boolean);\n    const text = norm(e.name + ' ' + (e.mitglieder || ''));\n    return woerter.every(w => text.includes(w));\n  };\n  const klassenName = code => (data.klassen.find(k => k.code === code) || {}).name || code;\n  // Kurzform für Titel: MJU18, W, M13, X …\n  const kurz = code => code;\n  // Klassen immer in der Reihenfolge von data.klassen (M, W, MJU20, …)\n  const sortCodes = codes => codes.slice().sort((a, b) => {\n    const i = c => { const x = data.klassen.findIndex(k => k.code === c); return x < 0 ? 999 : x; };\n    return i(a) - i(b);\n  });\n  const klassenCodes = w => sortCodes(Object.keys(w.klassen).filter(c => w.klassen[c].length));\n  const titelKlasse = (w, code) => `${w.disziplin} ${kurz(code)}`;\n  // nur Ergebnisse, die seit mindestens CONFIG.wartezeitMinuten offiziell sind\n  const freigegeben = w => !!w.offiziell && Date.now() - new Date(w.offiziell).getTime() >= CONFIG.wartezeitMinuten * 60000;\n\n  // ---------- Medaillen ----------\n  function saetze() {\n    // je Wettbewerb und Altersklasse ein Medaillensatz: {titel, eintraege}\n    const out = [];\n    data.wettbewerbe.forEach(w => {\n      if (w.vorlauf || !freigegeben(w)) return;\n      klassenCodes(w).forEach(c => out.push({ titel: titelKlasse(w, c), eintraege: w.klassen[c] }));\n    });\n    return out;\n  }\n\n  function spiegel() {\n    const table = {};\n    saetze().forEach(({ titel, eintraege }) => eintraege.forEach(en => {\n      if (!en.rang || en.rang > 3) return;\n      const key = (CONFIG.mode === 'lv' ? en.lv : en.verein) || '(unbekannt)';\n      const t = table[key] || (table[key] = { name: key, g: 0, s: 0, b: 0, items: [] });\n      t[en.rang === 1 ? 'g' : en.rang === 2 ? 's' : 'b']++;\n      t.items.push({ r: en.rang, en, titel });\n    }));\n    const rows = Object.values(table).sort((a, b) =>\n      b.g - a.g || b.s - a.s || b.b - a.b || a.name.localeCompare(b.name, 'de'));\n    rows.forEach((r, i) => {\n      const p = rows[i - 1];\n      r.pos = p && p.g === r.g && p.s === r.s && p.b === r.b ? p.pos : i + 1;\n    });\n    return rows;\n  }\n\n  function renderMedaillen() {\n    $('colName').textContent = CONFIG.mode === 'lv' ? 'Landesverband' : 'Verein';\n    const totals = {};\n    const rows = spiegel();\n    $('medBody').innerHTML = rows.map(r => {\n      const sig = `${r.g}/${r.s}/${r.b}`;\n      totals[r.name] = sig;\n      const changed = prevTotals && prevTotals[r.name] !== sig;\n      let h = `<tr class=\"main${changed ? ' flash' : ''}\" data-k=\"${esc(r.name)}\">\n        <td class=\"n\">${r.pos}</td><td class=\"name\">${esc(r.name)}</td>\n        <td class=\"n g\">${r.g}</td><td class=\"n\">${r.s}</td><td class=\"n\">${r.b}</td><td class=\"n\"><b>${r.g + r.s + r.b}</b></td></tr>`;\n      if (open.has(r.name)) {\n        h += `<tr class=\"detail\"><td></td><td colspan=\"5\"><div class=\"det\">${r.items.slice().sort((a, b) => a.r - b.r).map(it =>\n          `<div>${medal(it.r)} <span>${esc(it.titel)}</span>\n           <small>${esc(it.en.team ? 'Staffel' : it.en.name)}${CONFIG.mode === 'lv' && !it.en.team ? ' (' + esc(it.en.verein) + ')' : ''} · ${esc(it.en.ergebnis)}</small></div>`).join('')}</div></td></tr>`;\n      }\n      return h;\n    }).join('') || `<tr><td colspan=\"6\" class=\"empty\">Noch keine Medaillen vergeben.</td></tr>`;\n    prevTotals = totals;\n  }\n\n  // ---------- Ergebnisse & Meldungen (gleicher Aufbau, gleiche Filter) ----------\n  const ARTEN = {\n    erg: {\n      // Wettbewerbe, die angezeigt werden\n      wettbewerbe: () => data.wettbewerbe.filter(w => freigegeben(w) && (CONFIG.vorlaeufeZeigen || !w.vorlauf)),\n      codes: w => klassenCodes(w),\n      proKlasse: (w, c) => w.klassen[c] || [],\n      gesamt: w => w.gesamt,\n      gesamtOption: 'Gesamtwertungen (gemeinsame Wettbewerbe)',\n      gesamtKommentar: 'Gesamtwertung über alle Altersklassen',\n      leer: 'Noch keine Ergebnisse.'\n    },\n    meld: {\n      wettbewerbe: () => data.wettbewerbe.filter(w => w.meldungenZeigen),\n      codes: w => sortCodes([...new Set(w.meldungen.map(e => e.klasse).filter(Boolean))]),\n      proKlasse: (w, c) => w.meldungen.filter(e => e.klasse === c),\n      gesamt: w => new Set(w.meldungen.map(e => e.klasse)).size > 1 ? w.meldungen : null,\n      gesamtOption: 'Gemeinsame Wettbewerbe (alle Klassen zusammen)',\n      gesamtKommentar: 'alle Altersklassen zusammen',\n      leer: 'Noch keine Meldungen.'\n    }\n  };\n\n  function optionen(sel, liste, wert) {\n    $(sel).innerHTML = liste.map(([v, l]) => `<option value=\"${esc(v)}\"${v === wert ? ' selected' : ''}>${esc(l)}</option>`).join('');\n  }\n\n  function renderListe(art) {\n    const A = ARTEN[art];\n    const liste = A.wettbewerbe();\n\n    // Altersklassen-Auswahl\n    const vorhanden = new Set();\n    liste.forEach(w => A.codes(w).forEach(c => vorhanden.add(c)));\n    const optK = [[ALLE, 'Alle Altersklassen']];\n    data.klassen.forEach(k => vorhanden.has(k.code) && optK.push([k.code, k.name]));\n    vorhanden.forEach(c => { if (!optK.some(o => o[0] === c)) optK.push([c, c]); });\n    if (liste.some(w => A.gesamt(w))) optK.push([GESAMT, A.gesamtOption]);\n    let kl = optK.some(o => o[0] === klasse) ? klasse : ALLE;\n    optionen('selKlasse', optK, kl);\n\n    // Karten (Wettbewerb × Klasse)\n    let karten = [];\n    if (kl === GESAMT) {\n      liste.forEach(w => { const g = A.gesamt(w); if (g) karten.push({ w, code: GESAMT, eintraege: g }); });\n    } else {\n      const codes = kl === ALLE ? optK.map(o => o[0]).filter(c => c !== ALLE && c !== GESAMT) : [kl];\n      codes.forEach(c => liste.forEach(w => {\n        const e = A.proKlasse(w, c);\n        if (e.length) karten.push({ w, code: c, eintraege: e });\n      }));\n    }\n\n    // Disziplin-Auswahl (nur Disziplinen der gewählten Klasse)\n    const diszs = [...new Set(karten.map(k => k.w.disziplin))];\n    const di = diszs.includes(disziplin) ? disziplin : ALLE;\n    optionen('selDisz', [[ALLE, 'Alle Disziplinen'], ...diszs.map(d => [d, d])], di);\n    if (di !== ALLE) karten = karten.filter(k => k.w.disziplin === di);\n\n    // Vereins-Auswahl (gewählter Verein bleibt immer drin)\n    const vereine = new Set();\n    karten.forEach(k => k.eintraege.forEach(e => e.verein && vereine.add(e.verein)));\n    if (verein !== ALLE) vereine.add(verein);\n    optionen('selVerein', [[ALLE, 'Alle Vereine'], ...[...vereine].sort((a, b) => a.localeCompare(b, 'de')).map(v => [v, v])], verein);\n    if (verein !== ALLE) karten = karten\n      .map(k => ({ ...k, eintraege: k.eintraege.filter(e => e.verein === verein) }))\n      .filter(k => k.eintraege.length);\n\n    // Namenssuche\n    if (suche.trim()) karten = karten\n      .map(k => ({ ...k, eintraege: k.eintraege.filter(passtZurSuche) }))\n      .filter(k => k.eintraege.length);\n\n    $('ergListe').innerHTML = karten.map(({ w, code, eintraege }) => {\n      const gemeinsam = code === GESAMT;\n      const titel = gemeinsam ? `${w.disziplin} ${A.codes(w).map(kurz).join(', ')}` : titelKlasse(w, code);\n      const andere = A.codes(w).filter(c => c !== code);\n      const kommentar = gemeinsam ? A.gesamtKommentar : (andere.length ? 'aus gemeinsamem Wettbewerb mit ' + andere.map(kurz).join(', ') : '');\n      const gesamtzahl = gemeinsam ? null : A.proKlasse(w, code).length;\n      return art === 'erg' ? ergebnisKarte(w, titel, eintraege, kommentar, gemeinsam)\n                           : meldeKarte(w, titel, eintraege, kommentar, gemeinsam, gesamtzahl);\n    }).join('') || `<div class=\"empty\">${suche.trim() ? 'Kein Treffer für „' + esc(suche.trim()) + '“ in der aktuellen Auswahl.'\n      : verein !== ALLE ? 'Nichts für diesen Verein in der aktuellen Auswahl.' : A.leer}</div>`;\n  }\n\n  const personZelle = e => e.team\n    ? `${esc(e.verein)}${e.mitglieder ? `<br><small>${esc(e.mitglieder)}</small>` : ''}`\n    : `${esc(e.name)}${e.jg ? ` <small>(${esc(e.jg)})</small>` : ''}<br><small>${esc(e.verein)}</small>`;\n\n  function kartenRahmen(titel, tag, meta, kommentar, kopf, rows) {\n    return `<div class=\"card\">\n      <div class=\"card-head\"><h2>${esc(titel)}${tag}</h2><small>${esc(meta)}</small></div>\n      ${kommentar ? `<div class=\"hint\" style=\"margin:0 0 4px\">${esc(kommentar)}</div>` : ''}\n      <div class=\"tbl-wrap\"><table><thead><tr>${kopf}</tr></thead><tbody>${rows}</tbody></table></div></div>`;\n  }\n\n  function ergebnisKarte(w, titel, eintraege, kommentar, mitKlasse) {\n    const rows = eintraege.map(e => {\n      // Medaillen-Symbol nur in der Klassenwertung (Gesamtwertung und Vorläufe geben keine Medaillen)\n      const platz = e.rang ? (!w.vorlauf && !mitKlasse && e.rang <= 3 ? medal(e.rang) : e.rang) : '–';\n      return `<tr><td class=\"n\">${platz}</td><td class=\"name\">${personZelle(e)}</td>\n        ${mitKlasse ? `<td class=\"hide-sm\">${esc(kurz(e.klasse))}</td>` : ''}\n        <td class=\"r\"><b>${esc(e.ergebnis)}</b></td></tr>`;\n    }).join('');\n    return kartenRahmen(titel, w.vorlauf ? '<span class=\"tag\">Vorlauf – keine Medaillen</span>' : '',\n      [w.runde, w.zeit && w.zeit + ' Uhr'].filter(Boolean).join(' · '), kommentar,\n      `<th class=\"n\">Pl.</th><th>Name / Verein</th>${mitKlasse ? '<th class=\"hide-sm\">Klasse</th>' : ''}<th class=\"r\">Leistung</th>`, rows);\n  }\n\n  function meldeKarte(w, titel, eintraege, kommentar, mitKlasse, anzahl) {\n    const rows = eintraege.map(e => `<tr><td class=\"n\">${esc(e.bib || '–')}</td><td class=\"name\">${personZelle(e)}</td>\n        ${mitKlasse ? `<td class=\"hide-sm\">${esc(kurz(e.klasse))}</td>` : ''}\n        <td class=\"r\"><b>${esc(e.meldewert || '–')}</b></td></tr>`).join('');\n    const n = anzahl ?? eintraege.length;\n    return kartenRahmen(titel, '',\n      [n + (n === 1 ? ' Meldung' : ' Meldungen'), w.zeit && w.zeit + ' Uhr'].filter(Boolean).join(' · '), kommentar,\n      `<th class=\"n\">Nr.</th><th>Name / Verein</th>${mitKlasse ? '<th class=\"hide-sm\">Klasse</th>' : ''}<th class=\"r\">Meldewert</th>`, rows);\n  }\n\n  // ---------- Ansicht / Laden ----------\n  const SEITEN = { med: 'Medaillenspiegel', erg: 'Ergebnisse', meld: 'Meldungen' };\n  // '08. Mrz 2026 Volksbank-Hallenkreismeisterschaft 2026 - Dresden' -> Name, Datum, Ort\n  const MONATE = { Jan: 'Januar', Feb: 'Februar', Mrz: 'März', Apr: 'April', Mai: 'Mai', Jun: 'Juni', Jul: 'Juli',\n                   Aug: 'August', Sep: 'September', Okt: 'Oktober', Nov: 'November', Dez: 'Dezember' };\n  function kopf(t) {\n    const m = (t || '').match(/^(.*?\\b\\d{4})\\s+(.+?)(?:\\s+-\\s+((?:(?!\\s-\\s).)+))?$/);\n    if (!m) return { name: t, datum: '', ort: '' };\n    const datum = m[1].replace(/\\b(Jan|Feb|Mrz|Apr|Mai|Jun|Jul|Aug|Sep|Okt|Nov|Dez)\\b\\.?/g, x => MONATE[x.replace('.', '')]);\n    return { name: m[2], datum, ort: m[3] || '' };\n  }\n\n  function view() { return location.hash === '#ergebnisse' ? 'erg' : location.hash === '#meldungen' ? 'meld' : 'med'; }\n\n  function render() {\n    const v = view();\n    $('viewMed').hidden = v !== 'med';\n    $('viewErg').hidden = v === 'med';\n    $('navMed').classList.toggle('on', v === 'med');\n    $('navErg').classList.toggle('on', v === 'erg');\n    $('navMeld').classList.toggle('on', v === 'meld');\n    if (!data) return;\n    const k = kopf(data.wettkampf);\n    $('title').textContent = k.name;\n    $('datumOrt').textContent = [k.datum, k.ort].filter(Boolean).join(' · ');\n    document.title = SEITEN[v] + ' – ' + k.name;\n    if (v === 'med') renderMedaillen(); else renderListe(v);\n  }\n\n  async function load() {\n    // Beispieldatei: Daten sind direkt in der Seite eingebettet (kein Abruf nötig)\n    if (window.EINGEBETTETE_DATEN) {\n      data = window.EINGEBETTETE_DATEN;\n      render();\n      $('stand').textContent = 'Beispiel – Datenstand: ' + new Date(data.stand).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' Uhr';\n      return;\n    }\n    try {\n      const res = await fetch(CONFIG.quelle + '?t=' + Date.now(), { cache: 'no-store' });\n      if (!res.ok) throw new Error('HTTP ' + res.status);\n      data = await res.json();\n      render();\n      const t = new Date(data.stand);\n      $('stand').textContent = 'Letzte Änderung: ' + t.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' Uhr';\n    } catch (e) {\n      console.warn('Medaillenspiegel: Laden fehlgeschlagen:', e.message);\n      if (!data) $('stand').textContent = 'Ergebnisse konnten nicht geladen werden – neuer Versuch folgt.';\n    }\n  }\n\n  async function loop() {\n    await load();\n    if (CONFIG.interval > 0 && !window.EINGEBETTETE_DATEN) setTimeout(loop, CONFIG.interval * 1000);\n  }\n\n  window.addEventListener('hashchange', render);\n  $('selKlasse').onchange = e => { klasse = e.target.value; store.set('klasse', klasse); render(); };\n  $('selDisz').onchange = e => { disziplin = e.target.value; store.set('disziplin', disziplin); render(); };\n  $('suche').oninput = e => { suche = e.target.value; render(); };\n  $('selVerein').onchange = e => { verein = e.target.value; store.set('verein', verein); render(); };\n  $('medBody').onclick = e => {\n    const tr = e.target.closest('tr.main'); if (!tr) return;\n    const k = tr.dataset.k; open.has(k) ? open.delete(k) : open.add(k); render();\n  };\n\n  render();\n  loop();\n})();\n</script>\n</body>\n</html>\n";
