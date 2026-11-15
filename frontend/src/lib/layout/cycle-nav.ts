// src/lib/layout/cycle-nav.ts — where the sidebar's `cycleOn` comes from (the W5 side of the W2 hook).
//
// navConfig.ts owns the nav structure and marks the screens that only exist while a voting cycle
// runs (`requiresCycle: true`, today only Results = /winner); `sidebarNav(roles, { cycleOn })` drops
// them. This file only answers "is the cycle on?" from the effective cadence (backend
// `cycle.cadence`, 0107, carried on /api/me as `cycleCadence`), so the filtering lives in ONE place.

/**
 * Is a voting cycle running for this cadence? Only an explicit `off` turns it off: an absent
 * cadence (older backend) is treated as ON — never hide a screen on missing data.
 */
export function cycleOnFor(cadence: string | null | undefined): boolean {
	return cadence !== 'off';
}
