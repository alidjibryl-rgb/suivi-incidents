/**
 * Logique métier du suivi d'incidents, de sauvegardes et de logs.
 * Aucune dépendance externe : lecture de CSV, calcul d'indicateurs, lecture de logs.
 * Les dates sont des chaînes ISO (YYYY-MM-DDTHH:mm) pour rester lisibles dans un tableur.
 */

const SEP = ',';

/** Découpe une ligne CSV en gérant les guillemets doubles. */
function splitLine(line) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === SEP && !quoted) {
      out.push(current); current = '';
    } else current += ch;
  }
  out.push(current);
  return out.map((v) => v.trim());
}

/** Parse un CSV avec en-tête et retourne un tableau d'objets. */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return [];
  const headers = splitLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
}

/** Nombre d'heures écoulées entre deux dates ISO. NaN si l'une des deux est vide. */
export function heuresEntre(debut, fin) {
  const a = Date.parse(debut);
  const b = Date.parse(fin);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return (b - a) / 3_600_000;
}

/**
 * Indicateurs sur une liste d'incidents.
 * Colonnes attendues : id, applicatif, titre, sévérité, statut, ouvert_le, clos_le, cause.
 */
export function computeKpis(incidents) {
  const delais = incidents
    .map((i) => heuresEntre(i.ouvert_le, i.clos_le))
    .filter((h) => !Number.isNaN(h) && h >= 0);
  const parSeverite = compter(incidents, (i) => i.severite || 'non classée');
  const parStatut = compter(incidents, (i) => i.statut || 'inconnu');
  const parApplicatif = compter(incidents, (i) => i.applicatif || 'sans applicatif');
  const parCause = compter(
    incidents.filter((i) => i.clos_le),
    (i) => i.cause || 'cause non documentée'
  );
  const sous24h = delais.filter((h) => h <= 24).length;
  const critiques = ['majeure', 'bloquante'];
  return {
    total: incidents.length,
    clots: incidents.filter((i) => i.clos_le).length,
    ouverts: incidents.filter((i) => !i.clos_le).length,
    ouvrantsCritiques: incidents.filter((i) => !i.clos_le && critiques.includes(i.severite)).length,
    delaiMoyenH: delais.length ? moyenne(delais) : null,
    delaiMedianH: delais.length ? mediane(delais) : null,
    tauxSous24h: delais.length ? sous24h / delais.length : null,
    parSeverite, parStatut, parApplicatif, parCause,
  };
}

function compter(rows, clef) {
  const acc = {};
  for (const r of rows) {
    const k = clef(r);
    acc[k] = (acc[k] || 0) + 1;
  }
  return acc;
}
const moyenne = (t) => t.reduce((a, b) => a + b, 0) / t.length;
function mediane(t) {
  const s = [...t].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Rapport hebdomadaire en Markdown, prêt à être collé dans un ticket ou un e-mail.
 * @param {object} kpis résultat de computeKpis
 * @param {{semaine?: string}} options
 */
export function formatRapport(kpis, options = {}) {
  const semaine = options.semaine || 'période en cours';
  const l = [];
  l.push(`# Rapport de support applicatif — ${semaine}`, '');
  l.push(`- Incidents suivis : **${kpis.total}** (${kpis.ouverts} en cours, ${kpis.clots} clôtures documentées)`);
  if (kpis.delaiMoyenH != null) {
    l.push(`- Délai moyen de résolution : **${kpis.delaiMoyenH.toFixed(1)} h** (médiane ${kpis.delaiMedianH.toFixed(1)} h)`);
    l.push(`- Résolus en moins de 24 h : **${Math.round(kpis.tauxSous24h * 100)} %**`);
  } else {
    l.push('- Délai de résolution : non calculable (aucune clôture renseignée)');
  }
  l.push('', '## Répartition par sévérité', table(kpis.parSeverite));
  l.push('', '## Par applicatif', table(kpis.parApplicatif));
  l.push('', '## Par statut', table(kpis.parStatut));
  l.push('', '## Causes retenues à la clôture', table(kpis.parCause));
  const critiques = kpis.ouvrantsCritiques ?? 0;
  if (critiques > 0) l.push('', `> À surveiller : ${critiques} incident(s) majeur(s) ou bloquant(s) encore ouverts.`);
  return l.join('\n');
}

function table(objet) {
  const cles = Object.entries(objet).sort((a, b) => b[1] - a[1]);
  if (!cles.length) return '_aucune donnée_';
  return ['| Clef | Nombre |', '|---|---:|', ...cles.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
}

/**
 * Fraîcheur des sauvegardes : une sauvegarde est conforme si elle a moins de `ageMaxH`
 * heures et si sa taille dépasse `tailleMinKo`.
 * Colonnes attendues : job, chemin, derniere_ecriture, taille_ko.
 */
export function controleSauvegardes(rows, ref = new Date(), seuils = {}) {
  const ageMaxH = seuils.ageMaxH ?? 26;
  const tailleMinKo = seuils.tailleMinKo ?? 50;
  return rows.map((r) => {
    const sansDate = !r.derniere_ecriture;
    const ageH = sansDate ? null : (ref - new Date(r.derniere_ecriture)) / 3_600_000;
    const taille = Number(r.taille_ko);
    const tropAncienne = !sansDate && ageH > ageMaxH;
    const tropPetite = !Number.isNaN(taille) && taille < tailleMinKo;
    let etat = 'ok';
    if (sansDate || tropAncienne) etat = 'alerte';
    else if (tropPetite) etat = 'à vérifier';
    return {
      job: r.job || r.chemin,
      chemin: r.chemin,
      ageH: ageH == null ? null : Number(ageH.toFixed(1)),
      tailleKo: Number.isNaN(taille) ? null : taille,
      etat,
      motif: sansDate ? 'aucune date d\'écriture renseignée'
        : tropAncienne ? `sauvegarde plus ancienne que ${ageMaxH} h`
        : tropPetite ? `taille inférieure à ${tailleMinKo} Ko` : 'conforme',
    };
  });
}

/**
 * Lecture d'un fichier de log : compte les niveaux, isole les erreurs les plus récentes.
 * Format attendu : `2026-10-30T07:12:44Z ERROR texte` (date ISO, niveau, message).
 */
export function analyseLog(texte, options = {}) {
  const maxErreurs = options.maxErreurs ?? 5;
  const niveaux = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
  const compte = Object.fromEntries(niveaux.map((n) => [n, 0]));
  const erreurs = [];
  let inconnues = 0;
  const lignes = texte.split(/\r?\n/);
  for (const line of lignes) {
    const m = /^(\S+)\s+([A-Z]+)\s+(.*)$/.exec(line.trim());
    if (!m) { if (line.trim()) inconnues++; continue; }
    const [horodatage, niveau, message] = [m[1], m[2], m[3]];
    if (niveaux.includes(niveau)) compte[niveau]++;
    if (niveau === 'ERROR' || niveau === 'FATAL') erreurs.push({ horodatage, niveau, message });
  }
  return {
    lignes: compte,
    total: Object.values(compte).reduce((a, b) => a + b, 0),
    lignesNonReconnues: inconnues,
    dernieresErreurs: erreurs.slice(-maxErreurs).reverse(),
    premiereLigne: lignes.find((x) => x.trim()) || null,
    derniereLigne: [...lignes].reverse().find((x) => x.trim()) || null,
  };
}

/**
 * Premier diagnostic : une checklist, pas un outil de résolution. Le but est de ne rien
 * oublier avant de passer la main à un développeur.
 */
const REGLES = [
  {
    mots: ['sauvegarde', 'backup', 'restore'],
    checks: [
      'vérifier la présence du fichier et sa date de dernière écriture',
      'comparer sa taille avec la moyenne des sept derniers jours',
      'lancer une restauration de contrôle sur un environnement secondaire',
    ],
  },
  {
    mots: ['lent', 'timeout', 'latence', 'lenteur'],
    checks: [
      'regarder la charge du service sur la plage signalée',
      'contrôler les erreurs de base de données et les requêtes lentes dans les logs',
      'vérifier l\'espace disque et la mémoire disponible sur l\'hôte',
    ],
  },
  {
    mots: ['connexion', 'login', 'auth', 'token', 'mot de passe'],
    checks: [
      'vérifier la date d\'expiration du certificat et du jeton',
      'contrôler les erreurs 401 et 403 dans les logs d\'accès',
      'tester depuis un autre poste pour isoler un problème de réseau',
    ],
  },
  {
    mots: ['erreur', '500', 'crash', 'exception', 'panne'],
    checks: [
      'extraire la première ligne d\'erreur complète avec sa pile',
      'identifier la version déployée juste avant l\'incident',
      'chercher un déploiement ou un changement de configuration au même moment',
    ],
  },
  {
    mots: ['mail', 'sms', 'notification', 'ussd'],
    checks: [
      'vérifier l\'état de la file de sortie et les messages bloqués',
      'contrôler les erreurs renvoyées par le prestataire dans les logs',
      'tester un envoi vers un destinataire de contrôle',
    ],
  },
];

const PAR_DEFAUT = [
  'reproduire le problème et noter l\'heure exacte',
  'consulter les logs des trente minutes autour de l\'heure signalée',
  'identifier l\'applicatif et la version concernés',
  'documenter ce qui a déjà été vérifié',
];

/** @returns {{id: string, regle: string, checks: string[]}} */
export function premierDiagnostic(incident) {
  const texte = `${incident.titre || ''} ${incident.cause || ''}`.toLowerCase();
  const regle = REGLES.find((r) => r.mots.some((mot) => texte.includes(mot)));
  return {
    id: incident.id || 'sans id',
    regle: regle ? regle.mots.join(', ') : 'checklist générique',
    checks: regle ? regle.checks : PAR_DEFAUT,
  };
}

/** Retourne un incident par son identifiant, ou null. */
export function trouverIncident(incidents, id) {
  return incidents.find((i) => i.id === id) || null;
}
