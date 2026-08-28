/**
 * Иконки заданы путями, а не подключены библиотекой: их немного, они
 * участвуют в выборе категории (то есть должны рисоваться мгновенно),
 * и вся сетка нарисована в одном стиле — 24×24, обводка 1.8.
 */
const PATHS: Record<string, string> = {
  cart: 'M3 5h2l2.4 10.4a2 2 0 0 0 2 1.6h7.2a2 2 0 0 0 2-1.6L20 8H6M9 21h.01M17 21h.01',
  coffee: 'M4 9h12v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V9Zm12 1h2a2.5 2.5 0 0 1 0 5h-2M6 3v2M10 3v2M14 3v2',
  car: 'M5 15h14M6.5 15V9.5L8 6h8l1.5 3.5V15M4 15h16v3h-2.5M4 15v3h2.5M7 18h10M7.5 12h9',
  home: 'M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1v-8Z',
  heart: 'M12 20s-7-4.4-7-9.2A4 4 0 0 1 12 8a4 4 0 0 1 7 2.8C19 15.6 12 20 12 20Z',
  bag: 'M5 8h14l-1 12H6L5 8Zm3.5 0V6a3.5 3.5 0 0 1 7 0v2',
  ticket: 'M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V8Zm10-2v12',
  phone: 'M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm4 15h2',
  book: 'M5 5a2 2 0 0 1 2-2h11v16H7a2 2 0 0 0-2 2V5Zm2 12h11',
  dots: 'M6 12h.01M12 12h.01M18 12h.01',
  briefcase: 'M4 8h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8Zm5 0V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M4 13h16',
  sparkles: 'm12 4 1.8 4.2L18 10l-4.2 1.8L12 16l-1.8-4.2L6 10l4.2-1.8L12 4Zm6 8 .9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z',
  trending: 'M4 16l5-5 3.5 3.5L20 7m0 0h-5m5 0v5',
  gift: 'M4 11h16v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8Zm-.5-4h17v4h-17V7ZM12 7v13M12 7S10.5 3 8.5 3a2 2 0 0 0 0 4H12Zm0 0s1.5-4 3.5-4a2 2 0 0 1 0 4H12Z',
  tag: 'M4 12V5a1 1 0 0 1 1-1h7l8 8-8 8-8-8Zm4-4.5h.01',
  wallet: 'M4 7a2 2 0 0 1 2-2h11a1 1 0 0 1 1 1v2M4 7v11a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-3M4 7h15a1 1 0 0 1 1 1v3h-4a2 2 0 0 0 0 4h4',
  card: 'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 4h18M6.5 15h3',
  cash: 'M3 7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Zm9 5a2.5 2.5 0 1 0 0-.01M6 9.5h.01M18 14.5h.01',
  bank: 'M4 10h16M5 10V9l7-4 7 4v1M6.5 10v7M11 10v7M17.5 10v7M4 20h16',
  savings: 'M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16Zm0 4v8m-3-5.5h6M9 14h6',
  target: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Zm0 4a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 4a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  check: 'm5 13 4 4L19 7',
  x: 'M6 6l12 12M18 6 6 18',
  chevronRight: 'm9 5 7 7-7 7',
  chevronDown: 'm5 9 7 7 7-7',
  chevronLeft: 'm15 5-7 7 7 7',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm5 12 4.5 4.5',
  home2: 'M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1v-8Z',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 9c0-3 2.7-5 6-5s6 2 6 5M16 4.5a3.5 3.5 0 0 1 0 7M18 20c0-2-.8-3.6-2-4.6',
  settings: 'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm8.4 3a8.4 8.4 0 0 0-.15-1.5l2-1.5-2-3.4-2.4 1a8.3 8.3 0 0 0-2.6-1.5L15 2.5H9l-.25 2.6a8.3 8.3 0 0 0-2.6 1.5l-2.4-1-2 3.4 2 1.5a8.4 8.4 0 0 0 0 3l-2 1.5 2 3.4 2.4-1a8.3 8.3 0 0 0 2.6 1.5l.25 2.6h6l.25-2.6a8.3 8.3 0 0 0 2.6-1.5l2.4 1 2-3.4-2-1.5c.1-.5.15-1 .15-1.5Z',
  wifiOff: 'M3 3l18 18M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 4-2.5m10 2.5a10 10 0 0 0-3-2.2M2 9.5a15 15 0 0 1 5-3M22 9.5a15 15 0 0 0-9-3.4M12 20h.01',
  clock: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Zm0 4.5V12l3 2',
  trash: 'M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V7M10 11v6M14 11v6',
  edit: 'M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Zm11-13 3 3',
  arrows: 'M7 7h11l-3-3M17 17H6l3 3',
  copy: 'M9 9h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Zm-4 6H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1',
  logout: 'M9 20H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4m5 4 4 4-4 4m4-4H9',
  warning: 'M12 4 2.5 20h19L12 4Zm0 6v5m0 3h.01',
};

export function Icon({
  name, size = 20, className, strokeWidth = 1.8,
}: { name: string; size?: number; className?: string; strokeWidth?: number }) {
  const d = PATHS[name] ?? PATHS.tag!;
  return (
    <svg
      className={className}
      width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

export const ICON_NAMES = Object.keys(PATHS).filter(
  (n) => !['chevronRight', 'chevronDown', 'chevronLeft', 'x', 'check', 'plus', 'minus', 'search', 'wifiOff', 'trash', 'edit', 'copy', 'logout', 'warning', 'arrows', 'clock', 'home2', 'list', 'chart', 'users', 'settings'].includes(n),
);
