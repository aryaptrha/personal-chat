/**
 * Running stats from Garmin, synced into KV by scripts/garmin-sync/sync.py.
 *
 * The sync job already filters the snapshot down to what is fine to make public;
 * this module only turns it into a block of text for the system prompt. Anyone
 * chatting can talk the model into repeating its system prompt, so treat every
 * field in the snapshot as published.
 */

const SNAPSHOT_KEY = 'running-stats';
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

type PeriodName = 'thisWeek' | 'lastWeek' | 'thisMonth' | 'lastMonth' | 'thisYear';

const PERIOD_LABELS: Array<[PeriodName, string]> = [
  ['thisWeek', 'Minggu ini'],
  ['lastWeek', 'Minggu lalu'],
  ['thisMonth', 'Bulan ini'],
  ['lastMonth', 'Bulan lalu'],
  ['thisYear', 'Tahun ini'],
];

interface PeriodTotals {
  from: string;
  to: string;
  runs: number;
  distanceKm: number;
  duration: string;
  longestKm: number;
}

/**
 * Averages for a whole run or one lap; null when the watch didn't record them.
 * Fields marked optional are missing from snapshots synced before they were added.
 */
interface RunMetrics {
  avgHr: number | null;
  cadence?: number | null;
  strideLengthM?: number | null;
  verticalOscillationCm?: number | null;
  verticalRatio?: number | null;
  groundContactMs?: number | null;
  avgPower?: number | null;
  elevationGainM?: number | null;
}

interface Split extends RunMetrics {
  distanceKm: number;
  duration: string;
  pace: string | null;
}

interface RecentRun extends RunMetrics {
  date: string;
  distanceKm: number;
  duration: string;
  pace: string | null;
  maxHr?: number | null;
  maxCadence?: number | null;
  trainingEffect?: { aerobic: number | null; anaerobic: number | null; label: string | null } | null;
  trainingLoad?: number | null;
  /** Time in heart-rate zones 1 to 5. */
  hrZones?: string[] | null;
  splits?: Split[] | null;
}

interface PersonalRecord {
  name: string;
  date: string | null;
  time?: string;
  distanceKm?: number;
}

/** Shape written by sync.py's build_snapshot(). Bump `version` on both sides together. */
export interface RunningSnapshot {
  version: 1;
  generatedAt: string;
  timezone: string;
  periods: Partial<Record<PeriodName, PeriodTotals>>;
  recentRuns: RecentRun[];
  personalRecords: PersonalRecord[];
  racePredictions: Array<{ name: string; time: string }>;
  vo2Max: number | null;
  trainingStatus: string | null;
}

function formatNumber(value: number): string {
  return String(value).replace('.', ',');
}

function formatKm(value: number): string {
  return `${formatNumber(value)} km`;
}

function formatDynamics(run: RecentRun): string {
  return [
    run.cadence
      ? `cadence ${run.cadence} spm${run.maxCadence ? ` (max ${run.maxCadence})` : ''}`
      : null,
    run.strideLengthM ? `stride ${formatNumber(run.strideLengthM)} m` : null,
    run.verticalOscillationCm
      ? `vertical oscillation ${formatNumber(run.verticalOscillationCm)} cm`
      : null,
    run.verticalRatio ? `vertical ratio ${formatNumber(run.verticalRatio)}%` : null,
    run.groundContactMs ? `ground contact time ${run.groundContactMs} ms` : null,
    run.avgPower ? `power ${run.avgPower} W` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

function formatTrainingEffect(run: RecentRun): string {
  const effect = run.trainingEffect;
  return [
    effect?.aerobic ? `aerobic ${formatNumber(effect.aerobic)}` : null,
    effect?.anaerobic ? `anaerobic ${formatNumber(effect.anaerobic)}` : null,
    effect?.label ? `fokus ${effect.label}` : null,
    run.trainingLoad ? `training load ${run.trainingLoad}` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/** Only pace, HR and cadence per lap: the rest would cost too much prompt per chat. */
function formatSplit(split: Split, index: number): string {
  const parts = [`${index + 1}) ${formatKm(split.distanceKm)} ${split.pace ?? split.duration}`];
  if (split.avgHr) parts.push(`HR ${split.avgHr}`);
  if (split.cadence) parts.push(`${split.cadence} spm`);
  return parts.join(' ');
}

function formatDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

function formatRange(from: string, to: string): string {
  const [fromYear, fromMonth, fromDay] = from.split('-').map(Number);
  const [toYear, toMonth, toDay] = to.split('-').map(Number);
  const start =
    fromYear === toYear ? `${fromDay} ${MONTHS[fromMonth - 1]}` : formatDate(from);
  return `${start}–${toDay} ${MONTHS[toMonth - 1]} ${toYear}`;
}

/** Date and time in the snapshot's timezone, e.g. "7 Okt 2026 14:05 WIB". */
function formatInZone(date: Date, timeZone: string, withTime: boolean): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      ...(withTime && {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZoneName: 'short',
      }),
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );

  const day = formatDate(`${parts.year}-${parts.month}-${parts.day}`);
  return withTime ? `${day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}` : day;
}

export function renderRunningStats(snapshot: RunningSnapshot, now: Date): string {
  const generatedAt = new Date(snapshot.generatedAt);
  const lines = [
    `DATA LARI GUE (dari Garmin, update terakhir ${formatInZone(generatedAt, snapshot.timezone, true)}; ` +
      `hari ini ${formatInZone(now, snapshot.timezone, false)}):`,
  ];

  const ageMs = now.getTime() - generatedAt.getTime();
  if (ageMs > STALE_AFTER_MS) {
    const days = Math.floor(ageMs / STALE_AFTER_MS);
    lines.push(
      `Catatan: data ini udah ${days} hari nggak ke-update, jadi angka minggu/bulan ini bisa aja udah basi.`
    );
  }

  for (const [name, label] of PERIOD_LABELS) {
    const period = snapshot.periods[name];
    if (!period) continue;
    const range = name === 'thisYear' ? period.from.slice(0, 4) : formatRange(period.from, period.to);
    lines.push(
      period.runs === 0
        ? `- ${label} (${range}): belum lari`
        : `- ${label} (${range}): ${period.runs}x lari, ${formatKm(period.distanceKm)}, ` +
            `total waktu ${period.duration}, terjauh ${formatKm(period.longestKm)}`
    );
  }

  if (snapshot.recentRuns.length > 0) {
    lines.push('Lari terakhir:');
    for (const run of snapshot.recentRuns) {
      const details = [formatKm(run.distanceKm), run.duration];
      if (run.pace) details.push(`pace ${run.pace}`);
      if (run.avgHr) {
        details.push(`HR rata-rata ${run.avgHr}${run.maxHr ? ` (max ${run.maxHr})` : ''}`);
      }
      if (run.elevationGainM) details.push(`elevasi naik ${run.elevationGainM} m`);
      lines.push(`- ${formatDate(run.date)}: ${details.join(', ')}`);

      const dynamics = formatDynamics(run);
      if (dynamics) lines.push(`  Running dynamics: ${dynamics}`);
      const effect = formatTrainingEffect(run);
      if (effect) lines.push(`  Training effect: ${effect}`);
      if (run.hrZones?.length) {
        lines.push(`  Waktu di zona HR: ${run.hrZones.map((time, i) => `Z${i + 1} ${time}`).join(', ')}`);
      }
      if (run.splits?.length) {
        lines.push(`  Split per lap: ${run.splits.map(formatSplit).join('; ')}`);
      }
    }
  }

  if (snapshot.personalRecords.length > 0) {
    const records = snapshot.personalRecords.map((record) => {
      const value = record.time ?? (record.distanceKm ? formatKm(record.distanceKm) : '?');
      return record.date ? `${record.name} ${value} (${formatDate(record.date)})` : `${record.name} ${value}`;
    });
    lines.push(`Personal record: ${records.join(', ')}`);
  }

  if (snapshot.racePredictions.length > 0) {
    const predictions = snapshot.racePredictions.map((p) => `${p.name} ${p.time}`);
    lines.push(`Prediksi race dari Garmin: ${predictions.join(', ')}`);
  }

  const fitness = [
    snapshot.vo2Max ? `VO2 max ${snapshot.vo2Max}` : null,
    snapshot.trainingStatus ? `training status ${snapshot.trainingStatus}` : null,
  ].filter(Boolean);
  if (fitness.length > 0) {
    lines.push(`Kebugaran: ${fitness.join(', ')}`);
  }

  lines.push(
    '',
    'Cara pakai data lari ini:',
    '- Kalau ditanya soal lari gue (jarak, pace, split, cadence, running dynamics, HR, training effect, PR, prediksi race, VO2 max, minggu ini lari berapa), jawab pakai angka di atas. Jangan ngarang angka lain.',
    '- Kalau yang ditanya nggak ada di data ini, bilang aja nggak nyatet atau nggak inget, sambil becanda.',
    '- Jangan pernah nyebut lokasi, rute, atau jam berapa gue biasa lari. Gue emang nggak share itu.',
    '- Tetep bales gaya chat: pendek, tanpa list. Sebut satu-dua angka yang relevan aja, jangan nyalin semua data.'
  );

  return lines.join('\n');
}

/**
 * Prompt block for the current snapshot, or undefined when there is none (binding
 * not configured, sync never ran, unknown version). A failure here only drops the
 * stats; chat keeps working without them.
 *
 * Read on every request, with no in-isolate cache on top: KV already caches hot
 * keys at the edge (about 60s), and a second layer would only stretch how long
 * the chat keeps answering from the old numbers after the owner presses "Sync".
 */
export async function getRunningStatsBlock(
  kv: KVNamespace | undefined
): Promise<string | undefined> {
  if (!kv) return undefined;

  try {
    const snapshot = await kv.get<RunningSnapshot>(SNAPSHOT_KEY, 'json');
    if (snapshot?.version === 1) {
      return renderRunningStats(snapshot, new Date());
    }
    if (snapshot) {
      console.warn(`[runningStats] Ignoring snapshot with unknown version ${String(snapshot.version)}.`);
    }
  } catch (err) {
    console.error('[runningStats] Failed to load the Garmin snapshot:', err);
  }
  return undefined;
}
