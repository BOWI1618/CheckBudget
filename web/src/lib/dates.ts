const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_PREP = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне',
  'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** Локальная сегодняшняя дата в формате YYYY-MM-DD (без сдвига по UTC). */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const currentPeriod = (): string => todayIso().slice(0, 7);

export function periodBounds(period: string): { from: string; to: string } {
  const [year, month] = period.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` };
}

export function shiftPeriod(period: string, delta: number): string {
  const [year, month] = period.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function formatPeriod(period: string): string {
  const [year, month] = period.split('-').map(Number) as [number, number];
  const name = MONTHS_NOM[month - 1] ?? period;
  return year === new Date().getFullYear() ? name : `${name} ${year}`;
}

/**
 * Месяц в родительном и предложном падежах: «против июля», «в июле было».
 *
 * Именительный падеж в такие фразы подставлять нельзя — получается
 * «против июль». Отдельные функции, а не склонение на лету: падежей нужно
 * ровно два, и списки короче любого правила.
 */
export function periodGen(period: string): string {
  return withYear(period, MONTHS_GEN);
}

export function periodPrep(period: string): string {
  return withYear(period, MONTHS_PREP);
}

function withYear(period: string, names: string[]): string {
  const [year, month] = period.split('-').map(Number) as [number, number];
  const name = names[month - 1] ?? period;
  return year === new Date().getFullYear() ? name : `${name} ${year}`;
}

export const shortMonth = (period: string): string =>
  MONTHS_SHORT[Number(period.slice(5, 7)) - 1] ?? period;

/** «27 августа», «Сегодня», «Вчера» — в списке операций так читается быстрее. */
export function formatDay(iso: string): string {
  const today = todayIso();
  if (iso === today) return 'Сегодня';
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yIso = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
  if (iso === yIso) return 'Вчера';

  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  const base = `${day} ${MONTHS_GEN[month - 1]}`;
  return year === new Date().getFullYear() ? base : `${base} ${year}`;
}

export const formatShortDate = (iso: string): string => {
  const [, month, day] = iso.split('-').map(Number) as [number, number, number];
  return `${day} ${MONTHS_SHORT[month - 1]}`;
};

export function lastMonths(count: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
