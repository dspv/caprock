// Line icons, 16px, drawn on a 24 grid with currentColor.
const paths: Record<string, string> = {
  inbox: 'M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z',
  unread: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  send: 'M4 12l16-8-6 16-2.5-6.5z M11.5 13.5 20 4',
  draft: 'M4 20h4L19 9l-4-4L4 16z M13 7l4 4',
  archive: 'M3 5h18v4H3z M5 9v10h14V9 M10 13h4',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  spam: 'M12 3l9 16H3z M12 10v4 M12 17v.5',
  folder: 'M3 6h6l2 2h10v11H3z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20 20l-4-4',
  compose: 'M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  reply: 'M10 9V5l-7 7 7 7v-4c5 0 8 1.5 11 5-1-5-4-10-11-11z',
  replyAll: 'M7 8l-5 4 5 4 M13 9V5l-7 7 7 7v-4c4 0 7 1.5 9 5-.8-5-3.5-10-9-11z',
  forward: 'M14 9V5l7 7-7 7v-4c-5 0-8 1.5-11 5 1-5 4-10 11-11z',
  sync: 'M20 12a8 8 0 0 1-14 5.3 M4 12a8 8 0 0 1 14-5.3 M18 3v4h-4 M6 21v-4h4',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  clip: 'M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7',
  close: 'M6 6l12 12 M18 6 6 18',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z',
  plus: 'M12 5v14 M5 12h14',
  mail: 'M3 6h18v12H3z M3 7l9 6 9-6',
  image: 'M4 5h16v14H4z M4 16l5-5 4 4 3-3 4 4 M15 9.5a1 1 0 1 0 0-.1',
  chevron: 'M9 6l6 6-6 6',
  cloud: 'M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.5 1.5A3.3 3.3 0 0 0 7 18z',
  download:'M12 4v11 M7 10l5 5 5-5 M5 20h14',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  keyboard: 'M3 6h18v12H3z M7 10h.01 M11 10h.01 M15 10h.01 M8 14h8',
}

export function Icon({ name, size = 16, className }: { name: keyof typeof paths | string; size?: number; className?: string }) {
  const d = paths[name] ?? paths.folder
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {d!.split(' M').map((seg, i) => <path key={i} d={i === 0 ? seg : 'M' + seg} />)}
    </svg>
  )
}
