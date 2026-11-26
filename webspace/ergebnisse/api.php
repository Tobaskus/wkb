<?php
/**
 * Medaillenspiegel – Datenquelle für index.html
 *
 * Holt Zeitplan, Meldelisten und Ergebnislisten eines Wettkampfs von
 * ergebnisse.leichtathletik.de, bereitet sie auf und liefert sie als JSON.
 * Die Daten werden im Ordner "cache" zwischengespeichert, damit der DLV-Server
 * nicht bei jedem Seitenaufruf abgefragt wird.
 *
 * Aufruf:  api.php            -> Standard-Wettkampf (siehe unten)
 *          api.php?wk=21235   -> bestimmter Wettkampf
 *
 * Voraussetzungen: PHP 7.4 oder neuer, Ordner "cache" beschreibbar.
 */

// ===================== EINSTELLUNGEN =====================
const WETTKAMPF_STANDARD = 21235;   // Wettkampf-ID aus der Adresse auf ergebnisse.leichtathletik.de
const CACHE_SEKUNDEN     = 60;      // so lange bekommen alle Besucher dieselben Daten
const LISTE_MAX_ALTER    = 300;     // einzelne Listen spätestens nach so vielen Sekunden neu holen
const PARALLEL           = 6;       // gleichzeitige Abrufe beim DLV-Server
// =========================================================

const BASIS = 'https://ergebnisse.leichtathletik.de';
const UA    = 'Mozilla/5.0 Medaillenspiegel';

const RE_VORLAUF = '/vorl(ä|ae)uf|vorlauf|zwischenl(ä|ae)uf|zwischenlauf|halbfinal|qualifikation|ausscheidung/iu';
const RE_RUNDE   = '/\s+(Vor\/Endkampf|Vorkampf|Endkampf|Finale|Endlauf|Vorl(ä|ae)ufe|Vorlauf|Zwischenl(ä|ae)ufe|Zwischenlauf|Halbfinale|Zeitl(ä|ae)ufe|Zeitlauf|L(ä|ae)ufe|Qualifikation|Ausscheidung|Entscheidung)$/iu';
const RE_CODE    = '/^([MW]|[MW]J?U\d+|[MW]K?U\d+|[MW]\d+|X)$/u';
const RE_STAFFEL = '/staffel|\d+\s*x\s*\d+/iu';
const RE_HOEHER  = '/sprung|wurf|sto(ß|ss)|kugel|speer|diskus|hammer|ball|kampf|punkte/iu';

// ---------------------------------------------------------------- Einstieg
if (PHP_SAPI !== 'cli' || realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    if (PHP_SAPI === 'cli') {
        // Test auf der Kommandozeile:  php api.php 18429
        $wid = isset($argv[1]) && ctype_digit($argv[1]) ? $argv[1] : (string)WETTKAMPF_STANDARD;
        echo json_encode(neu_aufbauen($wid, []), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }
    ausliefern();
}

function ausliefern()
{
    $wid = isset($_GET['wk']) && preg_match('/^\d{3,9}$/', $_GET['wk']) ? $_GET['wk'] : (string)WETTKAMPF_STANDARD;
    $ordner = __DIR__ . '/cache';
    if (!is_dir($ordner)) @mkdir($ordner, 0755, true);
    $datei = "$ordner/wk-$wid.json";
    $zustand = "$ordner/wk-$wid-listen.json";

    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');

    $alt = is_file($datei) ? @file_get_contents($datei) : false;
    if ($alt !== false && time() - filemtime($datei) < CACHE_SEKUNDEN) {
        echo $alt;
        return;
    }

    // Nur ein Aufruf gleichzeitig baut neu auf, alle anderen bekommen den letzten Stand
    $sperre = @fopen("$ordner/wk-$wid.lock", 'c');
    $gesperrt = $sperre && flock($sperre, LOCK_EX | LOCK_NB);
    if (!$gesperrt) {
        if ($alt !== false) { echo $alt; return; }
        if ($sperre) flock($sperre, LOCK_EX);          // erster Aufruf überhaupt: warten
        $neu = @file_get_contents($datei);
        echo $neu !== false ? $neu : json_encode(['fehler' => 'Noch keine Daten']);
        return;
    }

    // Letzten Stand sofort ausliefern und danach im Hintergrund aktualisieren (wenn der Server das kann)
    $hintergrund = $alt !== false && function_exists('fastcgi_finish_request');
    if ($hintergrund) {
        echo $alt;
        fastcgi_finish_request();
    }
    ignore_user_abort(true);
    @set_time_limit(120);

    try {
        $listen = is_file($zustand) ? (json_decode(@file_get_contents($zustand), true) ?: []) : [];
        $daten = neu_aufbauen($wid, $listen);
        // "stand" (= letzte Änderung) nur weiterschalten, wenn sich wirklich etwas geändert hat
        if ($alt !== false) {
            $vorher = json_decode($alt, true);
            if (is_array($vorher) && isset($vorher['stand'])) {
                $a = $vorher; unset($a['stand']);
                $b = json_decode(json_encode($daten, JSON_UNESCAPED_UNICODE), true); unset($b['stand']);
                if ($a == $b) $daten['stand'] = $vorher['stand'];
            }
        }
        $json = json_encode($daten, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        schreiben($datei, $json);
        schreiben($zustand, json_encode($GLOBALS['__listen_neu'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        if (!$hintergrund) echo $json;
    } catch (Throwable $e) {
        error_log('Medaillenspiegel: ' . $e->getMessage());
        if (!$hintergrund) {
            if ($alt !== false) { @touch($datei); echo $alt; }   // alter Stand, nächster Versuch nach CACHE_SEKUNDEN
            else { http_response_code(502); echo json_encode(['fehler' => 'DLV-Seite nicht erreichbar']); }
        }
    } finally {
        flock($sperre, LOCK_UN);
        fclose($sperre);
    }
}

function schreiben($datei, $inhalt)
{
    $tmp = $datei . '.' . getmypid() . '.tmp';
    if (@file_put_contents($tmp, $inhalt) !== false) @rename($tmp, $datei);
}

// ---------------------------------------------------------------- Abruf
/** Holt mehrere Adressen parallel. Liefert [url => html|null]. */
function hole_viele(array $urls)
{
    $ergebnis = [];
    $offen = array_values(array_unique($urls));
    if (!function_exists('curl_multi_init')) {
        foreach ($offen as $u) $ergebnis[$u] = hole_einzeln($u);
        return $ergebnis;
    }
    for ($versuch = 1; $versuch <= 3 && $offen; $versuch++) {
        $fehlgeschlagen = [];
        foreach (array_chunk($offen, PARALLEL) as $gruppe) {
            $mh = curl_multi_init();
            $handles = [];
            foreach ($gruppe as $u) {
                $ch = curl_init($u);
                curl_setopt_array($ch, [
                    CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true,
                    CURLOPT_TIMEOUT => 45, CURLOPT_CONNECTTIMEOUT => 15,
                    CURLOPT_USERAGENT => UA, CURLOPT_ENCODING => '',
                ]);
                curl_multi_add_handle($mh, $ch);
                $handles[$u] = $ch;
            }
            do {
                $status = curl_multi_exec($mh, $laufend);
                if ($laufend) curl_multi_select($mh, 1.0);
            } while ($laufend && $status === CURLM_OK);
            foreach ($handles as $u => $ch) {
                $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                $inhalt = curl_multi_getcontent($ch);
                if ($code === 200 && is_string($inhalt) && $inhalt !== '') $ergebnis[$u] = $inhalt;
                else $fehlgeschlagen[] = $u;
                curl_multi_remove_handle($mh, $ch);
                curl_close($ch);
            }
            curl_multi_close($mh);
        }
        $offen = $fehlgeschlagen;
        if ($offen) sleep(2 * $versuch);
    }
    foreach ($offen as $u) $ergebnis[$u] = null;
    return $ergebnis;
}

function hole_einzeln($url)
{
    $ctx = stream_context_create(['http' => ['header' => 'User-Agent: ' . UA, 'timeout' => 45]]);
    for ($i = 0; $i < 3; $i++) {
        $r = @file_get_contents($url, false, $ctx);
        if ($r !== false && $r !== '') return $r;
        sleep(2 * ($i + 1));
    }
    return null;
}

// ---------------------------------------------------------------- Hilfen
function text($s)
{
    $s = preg_replace('/<[^>]+>/u', ' ', (string)$s);
    $s = html_entity_decode($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return trim(preg_replace('/[\s\x{00A0}]+/u', ' ', $s));
}

function firstline($block, $col, $nr = 0)
{
    preg_match_all('/<div class="' . preg_quote($col, '/') . '">\s*<div class="firstline">(.*?)<\/div>/su', $block, $m);
    return isset($m[1][$nr]) ? text($m[1][$nr]) : '';
}

function secondline($block, $col)
{
    return preg_match('/<div class="' . preg_quote($col, '/') . '">\s*<div class="firstline">.*?<\/div>\s*<div class="secondline">(.*?)<\/div>/su', $block, $m)
        ? text($m[1]) : '';
}

function ist_team($block, $disziplin = '')
{
    if (preg_match(RE_STAFFEL, (string)$disziplin)) return true;
    if (!preg_match('/class="blockheader">(.*?)<div class="entryline"/su', $block, $kopf)) return true;
    if (!preg_match('/<div class="col-2">.*?class="secondline">(.*?)<\/div>/su', $kopf[1], $v)) return true;
    return mb_stripos(text($v[1]), 'verein') === false;
}

function klassen_name($code)
{
    if (preg_match('/^([MW])(K?)(J?)U(\d+)$/', $code, $m)) {
        return ($m[1] === 'M' ? 'Männliche' : 'Weibliche') . ' ' . ($m[2] ? 'Kinder' : 'Jugend') . ' U' . $m[4];
    }
    if (preg_match('/^([MW])(\d+)$/', $code, $m)) {
        return ((int)$m[2] < 30 ? 'Jugend ' : 'Senioren ') . $code;
    }
    $fest = ['M' => 'Männer', 'W' => 'Frauen', 'X' => 'Männer & Frauen'];
    return $fest[$code] ?? $code;
}

/** Männer/Frauen, Senioren, Jugend absteigend (U20 … U8; M13/M12 zwischen U14 und U12), Sonstiges. */
function klassen_sortierung($code)
{
    $g = strpos($code, 'M') === 0 ? 0 : 1;
    if ($code === 'M' || $code === 'W') return [0, 0, $g];
    if (preg_match('/^[MW]K?J?U(\d+)$/', $code, $m) || preg_match('/^[MW](\d+)$/', $code, $m)) {
        $n = (int)$m[1];
        if ($n >= 30) return [1, $n, $g];
        return [2, preg_match('/^[MW]\d+$/', $code) ? -($n + 0.5) : -$n, $g];
    }
    return [3, 0, $g];
}

function disziplin_und_runde($name, array $klassen_namen)
{
    $runde = '';
    if (preg_match(RE_RUNDE, $name, $m, PREG_OFFSET_CAPTURE)) {
        $runde = $m[1][0];
        $name = substr($name, 0, $m[0][1]);
    }
    $woerter = preg_split('/\s+/u', trim($name));
    for ($i = 1; $i < count($woerter); $i++) {
        $rest = implode(' ', array_slice($woerter, $i));
        $treffer = preg_match(RE_CODE, rtrim($woerter[$i], ','));
        if (!$treffer) foreach ($klassen_namen as $k) if (strpos($rest, $k) === 0) { $treffer = true; break; }
        if ($treffer) return [implode(' ', array_slice($woerter, 0, $i)), $runde];
    }
    return [trim($name), $runde];
}

function offiziell_seit($info)
{
    if (!preg_match('/\bOffiziell\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/u', $info, $m)) return null;
    if (!preg_match('/(\d{2})\.(\d{2})\.(\d{4})/', $info, $d)) return null;
    $t = new DateTime(sprintf('%04d-%02d-%02d %02d:%02d:%02d', $d[3], $d[2], $d[1], $m[1], $m[2], isset($m[3]) && $m[3] !== '' ? $m[3] : 0),
                      new DateTimeZone('Europe/Berlin'));
    return $t->format('Y-m-d\TH:i:sP');
}

function leistung_zahl($s)
{
    $s = str_replace(',', '.', preg_replace('/[^\d:,.]/u', '', (string)$s));
    if (!preg_match('/\d/', $s)) return null;
    $wert = 0.0;
    foreach (explode(':', $s) as $teil) {
        if (!preg_match('/^(\d+\.?\d*|\.\d+)$/', $teil)) return null;
        $wert = $wert * 60 + (float)$teil;
    }
    return $wert;
}

// ---------------------------------------------------------------- Ergebnisliste
function parse_ergebnisse($seite, $disziplin = '')
{
    $info = preg_match('/class="listheader">.*?<div style="font-weight: normal;">(.*?)<\/div>/su', $seite, $m) ? text($m[1]) : '';
    $bloecke = [];
    $teile = preg_split('/<div class="runblock /u', $seite);
    array_shift($teile);
    foreach ($teile as $teil) {
        $art = explode('"', $teil, 2)[0];
        $team = ist_team($teil, $disziplin);
        $eintraege = [];
        $zeilen = explode('<div class="entryline"', $teil);
        array_shift($zeilen);
        foreach ($zeilen as $e) {
            $rang = firstline($e, 'col-1');
            $name1 = firstline($e, 'col-2');
            $zweite = secondline($e, 'col-2');
            $team = $team || strpos($zweite, ';') !== false;
            $eintraege[] = [
                'rang' => ctype_digit($rang) ? (int)$rang : null,
                'name' => $name1,
                'verein' => $team ? $name1 : $zweite,
                'mitglieder' => $team ? $zweite : '',
                'lv' => firstline($e, 'col-3'),
                'jg' => secondline($e, 'col-3'),
                'ergebnis' => firstline($e, 'col-4', 0),
                'klasse' => firstline($e, 'col-4', 1),
                'team' => $team,
            ];
        }
        $bloecke[] = [
            'art' => strpos($art, 'roundblock') !== false ? 'gesamt' : (strpos($art, 'classblock') !== false ? 'klasse' : 'lauf'),
            'klasse' => preg_match('/\bc-(\S+)/', $art, $k) ? $k[1] : null,
            'eintraege' => $eintraege,
        ];
    }
    return [$info, $bloecke];
}

function ergebnisse_aufbereiten(array $bloecke)
{
    $gesamt = [];
    foreach ($bloecke as $b) if ($b['art'] === 'gesamt') { $gesamt = $b['eintraege']; break; }
    $klassen = [];
    foreach ($bloecke as $b) if ($b['art'] === 'klasse' && $b['klasse']) $klassen[$b['klasse']] = $b['eintraege'];
    $codes = [];
    foreach ($gesamt as $e) if ($e['klasse'] !== '' && !in_array($e['klasse'], $codes, true)) $codes[] = $e['klasse'];
    if (!$klassen && $gesamt) {
        if (count($codes) <= 1) {
            $klassen[$codes ? $codes[0] : '?'] = $gesamt;
        } else {   // keine Klassenblöcke: Klassenplätze aus dem Gesamtergebnis ableiten
            foreach ($codes as $c) {
                $rest = []; $platz = 0; $vorher = null; $n = 0;
                foreach ($gesamt as $e) {
                    if ($e['klasse'] !== $c) continue;
                    if ($e['rang'] !== null) {
                        $n++;
                        if ($e['rang'] !== $vorher) $platz = $n;
                        $vorher = $e['rang'];
                        $e['rang'] = $platz;
                    }
                    $rest[] = $e;
                }
                $klassen[$c] = $rest;
            }
        }
    }
    $mehrere = count(array_filter($klassen, 'count')) > 1;
    return [$klassen, $mehrere ? $gesamt : null];
}

// ---------------------------------------------------------------- Meldeliste
function parse_meldungen($seite, $disziplin)
{
    $teil = explode('<div class="registerblock"', $seite, 2);
    if (count($teil) < 2) return [];
    $teil = $teil[1];
    $team = ist_team($teil, $disziplin);
    $liste = [];
    $zeilen = explode('<div class="entryline"', $teil);
    array_shift($zeilen);
    foreach ($zeilen as $e) {
        $name1 = firstline($e, 'col-2');
        $zweite = secondline($e, 'col-2');
        $team = $team || strpos($zweite, ';') !== false;
        $liste[] = [
            'bib' => firstline($e, 'col-1'),
            'name' => $name1,
            'verein' => $team ? $name1 : $zweite,
            'mitglieder' => $team ? $zweite : '',
            'lv' => firstline($e, 'col-3'),
            'jg' => secondline($e, 'col-3'),
            'meldewert' => firstline($e, 'col-4'),
            'klasse' => firstline($e, 'col-5', 0),
            'team' => $team,
        ];
    }
    // nach Meldewert (Lauf: kleiner besser, Sprung/Wurf: größer besser), bei Gleichstand nach Startnummer
    $hoeher = (bool)preg_match(RE_HOEHER, $disziplin);
    $schluessel = [];
    foreach ($liste as $i => $e) {
        $w = leistung_zahl($e['meldewert']);
        $bib = ctype_digit($e['bib']) ? (int)$e['bib'] : 1000000000;
        $schluessel[$i] = $w === null ? [1, 0, $bib, $e['name'], $i] : [0, $hoeher ? -$w : $w, $bib, $e['name'], $i];
    }
    uksort($liste, function ($a, $b) use ($schluessel) {
        foreach ($schluessel[$a] as $k => $x) {
            $y = $schluessel[$b][$k];
            $c = is_string($x) ? strcmp($x, $y) : ($x <=> $y);
            if ($c) return $c;
        }
        return 0;
    });
    return array_values($liste);
}

// ---------------------------------------------------------------- Aufbau
function neu_aufbauen($wid, array $listen_alt)
{
    $zeitplan_url = BASIS . "/Competitions/Details/$wid";
    $ov_url = BASIS . "/Competitions/Resultoverview/$wid";
    $seiten = hole_viele([$zeitplan_url, $ov_url]);
    $zeitplan = $seiten[$zeitplan_url];
    if ($zeitplan === null) throw new RuntimeException('Zeitplan nicht erreichbar');

    $titel = preg_match('/<h1[^>]*>\s*<div style="flex: 1;">(.*?)<\/div>/su', $zeitplan, $m) ? text($m[1]) : '';

    // Klassennamen aus der Ergebnisübersicht (falls schon vorhanden)
    $namen = [];
    if ($seiten[$ov_url] !== null && preg_match('/id="EventMenuHeader".*?<\/ul>/su', $seiten[$ov_url], $menue)) {
        preg_match_all('/<a href="#([^"]+)">(.*?)<\/a>/su', $menue[0], $mm, PREG_SET_ORDER);
        foreach ($mm as $x) $namen[$x[1]] = text($x[2]);
    }

    // Alle Runden aus dem Zeitplan (mit Status, um unveränderte Listen nicht neu zu holen)
    preg_match_all('/<a href=(\/Competitions\/CurrentList\/(\d+)\/\d+)>\s*<div class="blockround".*?class="roundtime">(.*?)<\/div>'
                 . '.*?class="mainname">(.*?)<\/div>.*?class="typename">(.*?)<\/div>/su', $zeitplan, $treffer, PREG_SET_ORDER | PREG_OFFSET_CAPTURE);
    $runden = [];
    foreach ($treffer as $r) {
        $lid = $r[2][0];
        if (isset($runden[$lid])) continue;
        $nach = substr($zeitplan, $r[0][1] + strlen($r[0][0]), 600);
        $status = preg_match('/class="roundstate ([^"]*)"/', $nach, $s) ? $s[1] : '';
        $haupt = text($r[4][0]);
        $runde = preg_replace('/\s*\(.*?\)\s*$/u', '', text($r[5][0]));
        $runden[$lid] = ['id' => $lid, 'zeit' => text($r[3][0]), 'haupt' => $haupt,
                         'name' => trim($haupt . ' ' . $runde), 'url' => BASIS . $r[1][0], 'status' => $status];
    }

    $beispiel = ['M', 'W', 'X'];
    foreach (['M', 'W'] as $g) {
        foreach (['J', 'K'] as $k) for ($n = 8; $n < 24; $n += 2) $beispiel[] = "$g{$k}U$n";
        for ($n = 6; $n < 16; $n++) $beispiel[] = "$g$n";
    }
    $alle_namen = array_unique(array_merge(array_values($namen), array_map('klassen_name', $beispiel)));
    usort($alle_namen, function ($a, $b) { return mb_strlen($b) <=> mb_strlen($a); });

    // Welche Listen müssen neu geholt werden?
    $jetzt = time();
    $holen = [];
    foreach ($runden as $lid => $w) {
        $a = $listen_alt[$lid] ?? null;
        if (!$a || $a['status'] !== $w['status'] || $jetzt - $a['zeit_geholt'] >= LISTE_MAX_ALTER || !empty($a['fehler'])) {
            $holen[] = $w['url'];
            $holen[] = BASIS . "/Competitions/RegisterList/$lid/$wid";
        }
    }
    $html = $holen ? hole_viele($holen) : [];

    $GLOBALS['__listen_neu'] = [];
    $liste = [];
    foreach ($runden as $lid => $w) {
        list($w['disziplin'], $w['runde']) = disziplin_und_runde($w['name'], $alle_namen);
        $w['vorlauf'] = (bool)preg_match(RE_VORLAUF, $w['runde'] !== '' ? $w['runde'] : $w['name']);
        $reg_url = BASIS . "/Competitions/RegisterList/$lid/$wid";
        if (array_key_exists($w['url'], $html)) {
            $fehler = false;
            if ($html[$w['url']] !== null) {
                list($info, $bloecke) = parse_ergebnisse($html[$w['url']], $w['disziplin']);
                list($klassen, $gesamt) = ergebnisse_aufbereiten($bloecke);
            } else {
                $fehler = true;
                $a = $listen_alt[$lid] ?? [];
                $info = $a['info'] ?? ''; $klassen = $a['klassen'] ?? []; $gesamt = $a['gesamt'] ?? null;
            }
            if ($html[$reg_url] !== null) {
                $meldungen = parse_meldungen($html[$reg_url], $w['disziplin']);
            } else {
                $fehler = true;
                $meldungen = ($listen_alt[$lid]['meldungen'] ?? []);
            }
            $GLOBALS['__listen_neu'][$lid] = ['status' => $w['status'], 'zeit_geholt' => $fehler ? 0 : $jetzt, 'fehler' => $fehler,
                                              'info' => $info, 'klassen' => $klassen, 'gesamt' => $gesamt, 'meldungen' => $meldungen];
        } else {
            $a = $listen_alt[$lid];
            $info = $a['info']; $klassen = $a['klassen']; $gesamt = $a['gesamt']; $meldungen = $a['meldungen'];
            $GLOBALS['__listen_neu'][$lid] = $a;
        }
        $w['info'] = $info;
        $w['offiziell'] = offiziell_seit($info);
        $w['klassen'] = $klassen ? $klassen : new stdClass();
        $w['gesamt'] = $gesamt;
        $w['meldungen'] = $meldungen;
        unset($w['status']);
        $liste[] = $w;
    }

    // Meldungen nur in der ersten Runde (das Finale nach Vorläufen enthält sonst dieselben Athleten nochmal)
    foreach ($liste as $i => $w) {
        $folgerunde = false;
        if (!$w['vorlauf']) foreach ($liste as $x) if ($x['vorlauf'] && $x['haupt'] === $w['haupt']) { $folgerunde = true; break; }
        $liste[$i]['meldungenZeigen'] = count($w['meldungen']) > 0 && !$folgerunde;
    }

    $codes = [];
    foreach ($liste as $w) {
        foreach ((array)$w['klassen'] as $c => $v) if (count($v)) $codes[$c] = true;
        foreach ($w['meldungen'] as $e) if ($e['klasse'] !== '') $codes[$e['klasse']] = true;
    }
    $codes = array_map('strval', array_keys($codes));
    usort($codes, function ($a, $b) { return klassen_sortierung($a) <=> klassen_sortierung($b); });
    $klassen = [];
    foreach ($codes as $c) $klassen[] = ['code' => $c, 'name' => ($namen[$c] ?? '') !== '' ? $namen[$c] : klassen_name($c)];

    return [
        'wettkampf' => $titel,
        'quelle' => $zeitplan_url,
        'stand' => gmdate('Y-m-d\TH:i:s') . '+00:00',
        'klassen' => $klassen,
        'wettbewerbe' => $liste,
    ];
}
