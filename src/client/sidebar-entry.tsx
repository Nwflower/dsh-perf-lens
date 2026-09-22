// Left-nav row for the Perf Lens panel, registered into sidebar.panellist.
// Mirrors the built-in Plugins panel's entry (dsh 0.1.7): the sidebar owns the
// button and hands the occupant its square size and selected state.

/** Owner props supplied by the sidebar for a global panel row. */
export interface PerfSidebarEntryProps {
  readonly size: number
  readonly active: boolean
}

export function PerfSidebarEntry({ size, active }: PerfSidebarEntryProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ opacity: active ? 1 : 0.75 }}
    >
      <path
        d="M2 12.5 L6 7 L9 10 L14 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
