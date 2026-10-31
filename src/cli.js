#!/usr/bin/env node
/**
 * Interface en ligne de commande.
 *   node src/cli.js rapport      data/incidents-exemple.csv [--semaine "S44 2026"]
 *   node src/cli.js sauvegardes  data/sauvegardes-exemple.csv [--age 26 --taille 50 --ref 2026-10-31T08:00]
 *   node src/cli.js logs         data/app.log [--erreurs 5]
 *   node src/cli.js diagnostic   INC-004 [data/incidents-exemple.csv]
 *   node src/cli.js aide
 * Sortie : du texte sur stdout. Code 1 si un argument manque, si un fichier est introuvable
 * ou si le contrôle des sauvegardes trouve une anomalie.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCsv, computeKpis, formatRapport, controleSauvegardes, analyseLog,
  premierDiagnostic, trouverIncident,
} from './incidents.js';

const RACINE = dirname(dirname(fileURLToPath(import.meta.url)));

function opt(args, nom, defaut) {
  const i = args.indexOf(`--${nom}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : defaut;
}

/** Affiche une date comme l'utilisateur l'a saisie, sans la basculer en UTC. */
function enLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function lire(chemin) {
  try {
    return readFileSync(resolve(chemin), 'utf8');
  } catch {
    console.error(`Fichier introuvable : ${chemin}`);
    process.exit(1);
  }
}

const [commande, ...restes] = process.argv.slice(2);

switch (commande) {
  case 'rapport': {
    if (!restes[0]) { console.error('Usage : rapport <incidents.csv>'); process.exit(1); }
    const incidents = parseCsv(lire(restes[0]));
    if (!incidents.length) { console.error('Aucun incident lisible dans ce fichier.'); process.exit(1); }
    console.log(formatRapport(computeKpis(incidents), { semaine: opt(restes, 'semaine', null) }));
    break;
  }
  case 'sauvegardes': {
    if (!restes[0]) { console.error('Usage : sauvegardes <sauvegardes.csv>'); process.exit(1); }
    const rows = parseCsv(lire(restes[0]));
    const ref = new Date(opt(restes, 'ref', new Date().toISOString()));
    if (Number.isNaN(ref.getTime())) { console.error('Date --ref illisible.'); process.exit(1); }
    const controle = controleSauvegardes(rows, ref, {
      ageMaxH: Number(opt(restes, 'age', 26)),
      tailleMinKo: Number(opt(restes, 'taille', 50)),
    });
    const alertes = controle.filter((c) => c.etat !== 'ok');
    console.log(`Contrôle des sauvegardes à ${enLocal(ref)} : ${controle.length} job(s), ${alertes.length} en anomalie.`);
    for (const c of controle) {
      console.log(`  [${c.etat.toUpperCase()}] ${c.job} — âge ${c.ageH ?? '?'} h, ${c.tailleKo ?? '?'} Ko — ${c.motif}`);
    }
    process.exitCode = alertes.length ? 1 : 0;
    break;
  }
  case 'logs': {
    if (!restes[0]) { console.error('Usage : logs <app.log>'); process.exit(1); }
    const a = analyseLog(lire(restes[0]), { maxErreurs: Number(opt(restes, 'erreurs', 5)) });
    console.log(`Lignes analysées : ${a.total} (${a.lignesNonReconnues} non reconnues)`);
    console.log('Niveaux :', Object.entries(a.lignes).map(([k, v]) => `${k}=${v}`).join('  '));
    console.log(`Plage : ${a.premiereLigne?.split(' ')[0] ?? '?'} à ${a.derniereLigne?.split(' ')[0] ?? '?'}`);
    if (a.dernieresErreurs.length) {
      console.log('\nDernières erreurs :');
      for (const e of a.dernieresErreurs) console.log(`  ${e.horodatage} ${e.niveau} ${e.message}`);
    } else console.log('\nAucune erreur dans ce fichier.');
    break;
  }
  case 'diagnostic': {
    const id = restes[0];
    if (!id) { console.error('Usage : diagnostic <id> [incidents.csv]'); process.exit(1); }
    const fichier = restes[1] || resolve(RACINE, 'data', 'incidents-exemple.csv');
    const incident = trouverIncident(parseCsv(lire(fichier)), id);
    if (!incident) { console.error(`Incident ${id} absent de ${fichier}`); process.exit(1); }
    const d = premierDiagnostic(incident);
    console.log(`${d.id} — ${incident.titre} (${incident.applicatif}, ${incident.severite}, ${incident.statut})`);
    console.log(`Règle retenue : ${d.regle}`);
    console.log('Premières vérifications :');
    d.checks.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
    break;
  }
  default:
    console.log(`suivi-incidents — boîte à outils de support applicatif

  rapport <incidents.csv> [--semaine "S44 2026"]         rapport hebdomadaire en Markdown
  sauvegardes <sauvegardes.csv> [--age 26 --taille 50]   fraîcheur et taille des sauvegardes
  logs <app.log> [--erreurs 5]                           compte les niveaux, isole les erreurs
  diagnostic <id> [incidents.csv]                        checklist de premier diagnostic
  aide                                                   cette page

Données d'exemple dans data/. Tout est en JavaScript sans dépendance.`);
}
