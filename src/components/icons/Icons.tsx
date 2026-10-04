import React from 'react';

/**
 * BookKaro icon set — one consistent style (24px grid, 1.8 stroke, round caps).
 * Inline SVG so nothing is fetched at runtime. Decorative by default (aria-hidden);
 * every icon-only button supplies its own aria-label.
 */
type P = { size?: number; className?: string; strokeWidth?: number; title?: string };

const Svg: React.FC<P & { children: React.ReactNode }> = ({ size = 20, className, strokeWidth = 1.8, title, children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
    strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
    {title && <title>{title}</title>}
    {children}
  </svg>
);

export const IconTrain: React.FC<P> = (p) => (
  <Svg {...p}><rect x="5" y="3" width="14" height="14" rx="3.5" /><path d="M5 10.5h14" /><path d="M9 21l1.5-3.5M15 21l-1.5-3.5" /><circle cx="9" cy="13.8" r=".6" fill="currentColor" /><circle cx="15" cy="13.8" r=".6" fill="currentColor" /></Svg>
);
export const IconMic: React.FC<P> = (p) => (
  <Svg {...p}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0" /><path d="M12 17.5V21" /></Svg>
);
export const IconMicOff: React.FC<P> = (p) => (
  <Svg {...p}><path d="M3 3l18 18" /><path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 10V6a3 3 0 0 0-5.7-1.3" /><path d="M5.5 11a6.5 6.5 0 0 0 10.6 5M18.5 11a6.4 6.4 0 0 1-.6 2.7" /><path d="M12 17.5V21" /></Svg>
);
export const IconArrowUp: React.FC<P> = (p) => (<Svg {...p}><path d="M12 19V5" /><path d="M6 11l6-6 6 6" /></Svg>);
export const IconArrowRight: React.FC<P> = (p) => (<Svg {...p}><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></Svg>);
export const IconPlus: React.FC<P> = (p) => (<Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>);
export const IconSearch: React.FC<P> = (p) => (<Svg {...p}><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></Svg>);
export const IconCalendar: React.FC<P> = (p) => (<Svg {...p}><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M3.5 10h17M8 3v4M16 3v4" /></Svg>);
export const IconUsers: React.FC<P> = (p) => (<Svg {...p}><circle cx="9" cy="8.5" r="3.5" /><path d="M2.8 20a6.3 6.3 0 0 1 12.4 0" /><path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18.2 14.6A6.3 6.3 0 0 1 21.2 20" /></Svg>);
export const IconPin: React.FC<P> = (p) => (<Svg {...p}><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.4" /></Svg>);
export const IconClock: React.FC<P> = (p) => (<Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Svg>);
export const IconWallet: React.FC<P> = (p) => (<Svg {...p}><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" /><rect x="4" y="7.5" width="16.5" height="12" rx="2.5" /><path d="M16 13.5h1.5" /></Svg>);
export const IconSettings: React.FC<P> = (p) => (
  <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></Svg>
);
export const IconMenu: React.FC<P> = (p) => (<Svg {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Svg>);
export const IconClose: React.FC<P> = (p) => (<Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>);
export const IconCheck: React.FC<P> = (p) => (<Svg {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>);
export const IconAlert: React.FC<P> = (p) => (<Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.8v4.9" /><circle cx="12" cy="16.2" r=".6" fill="currentColor" /></Svg>);
export const IconInfo: React.FC<P> = (p) => (<Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5" /><circle cx="12" cy="7.8" r=".6" fill="currentColor" /></Svg>);
export const IconEdit: React.FC<P> = (p) => (<Svg {...p}><path d="M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></Svg>);
export const IconLock: React.FC<P> = (p) => (<Svg {...p}><rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></Svg>);
export const IconTicket: React.FC<P> = (p) => (<Svg {...p}><path d="M3.5 8.5V6.5a1.5 1.5 0 0 1 1.5-1.5h14a1.5 1.5 0 0 1 1.5 1.5v2a2.5 2.5 0 0 0 0 5v2a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-2a2.5 2.5 0 0 0 0-5z" /><path d="M14 5v2M14 11v2M14 17v2" /></Svg>);
export const IconChevronRight: React.FC<P> = (p) => (<Svg {...p}><path d="M9 6l6 6-6 6" /></Svg>);
export const IconChevronDown: React.FC<P> = (p) => (<Svg {...p}><path d="M6 9l6 6 6-6" /></Svg>);
export const IconStop: React.FC<P> = (p) => (<Svg {...p}><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" /></Svg>);
export const IconHome: React.FC<P> = (p) => (<Svg {...p}><path d="M4 11l8-6.5 8 6.5" /><path d="M6 9.5V20h12V9.5" /></Svg>);
export const IconCompose: React.FC<P> = (p) => (<Svg {...p}><path d="M12 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V12" /><path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L13 14l-4 1 1-4z" /></Svg>);
export const IconRoute: React.FC<P> = (p) => (<Svg {...p}><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="6" r="2.5" /><path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5" /></Svg>);
export const IconSparkle: React.FC<P> = (p) => (<Svg {...p}><path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z" /><path d="M18.5 16l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" /></Svg>);
export const IconRefresh: React.FC<P> = (p) => (<Svg {...p}><path d="M20 11a8 8 0 0 0-14.3-4.6L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.3 4.6L20 16" /><path d="M20 20v-4h-4" /></Svg>);
export const IconWave: React.FC<P> = (p) => (<Svg {...p}><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" /></Svg>);
export const IconShield: React.FC<P> = (p) => (<Svg {...p}><path d="M12 3l7 3v5.5c0 4.4-3 8-7 9.5-4-1.5-7-5.1-7-9.5V6z" /><path d="M9 12l2.2 2.2L15.5 10" /></Svg>);

/** Brand mark (train in a rounded square is rendered by the container). */
export const BrandMark: React.FC<{ size?: number }> = ({ size = 18 }) => <IconTrain size={size} strokeWidth={2} />;
