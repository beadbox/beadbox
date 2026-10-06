# Design

## Context

See proposal.md for the motivation and specs/gantt-chart/spec.md for the behaviour. Current state (from `add-gantt-chart-view`):

- **Layout.** `components/gantt-chart.tsx` (before this change) laid out the chart as a CSS grid (`TITLE_W px | timelineW px`) inside one `overflow-auto` scroll container. The title column and the axis corner are `position: sticky; left: 0` grid items. A sticky element can only move within its containing block, and for a grid item that is its grid area, which is just the 300 px title cell. So once the user scrolls right, the sticky offset has nowhere to go and the titles scroll away with the timeline. That is the reported "whole pane slides". The axis row's `sticky top-0` does work, because its cell spans the scroll direction that matters.
- **Zoom.** Zoom is a `Zoom = "fit" | "hours" | "days" | "weeks"` value kept for the session. `lib/gantt-scale.ts` maps the presets to fixed pixels per millisecond (Hours 48 px/hour, Days 56 px/day, Weeks 84 px/week). Fit fills the view width. Tick units follow the scale (`tickUnit`, ticks at least 44 px apart).
- **Tests.** The tests run in happy-dom, which performs no layout. Sticky positioning and real scrolling can only be checked structurally in tests; the behaviour is checked in the running app.

## Goals / Non-Goals

**Goals:**
- Bead titles stay aligned with their bars at any zoom and scroll position, with one vertical and one horizontal scrollbar, both only along the timeline.
- +/− zoom that feels continuous with the presets: exact landings, matching highlight, a stable centre.

**Non-Goals:**
- Tick units coarser than weeks (months). The zoom-out limit exists so they are not needed.
- Trackpad pinch or ⌘-scroll zoom, and keyboard shortcuts for +/− (⌘= and ⌘− are already the app's page zoom).
- Any change to connector routing. The schedule changes only by inheriting blockers from epics (D6).

## Decisions

### D1: The timeline is the only scroll container; the titles follow it
A scrollbar spans the full width of the element that scrolls. Making the whole chart scroll (the 1.1 layout: rows as wide as the content, with a sticky title column) keeps the titles in place, but puts the horizontal scrollbar under the bead list as well. So the layout is split in two columns:
- **Left (fixed width, never scrolls on its own):** the corner, then a title pane with `overflow: hidden`.
- **Right:** the timeline scroller, the only `overflow: auto` element. Its content is a column with the axis row (`sticky top-0`, so it stays on top and scrolls sideways with the bars natively) and the timeline SVG. Both scrollbars therefore sit only under and beside the bars.

The title pane follows the scroller vertically:
- In the scroller's `scroll` handler, synchronously, set `titlePane.scrollTop = scroller.scrollTop`, in the same frame, so the titles don't lag. The title pane is padded at the bottom by the scroller's horizontal scrollbar height (`offsetHeight − clientHeight`), so the last row can line up.
- A `wheel` event over the title pane is passed on: its `deltaY` (and `deltaX`) go to `scroller.scrollBy`, and its default is prevented.
- Keyboard focus moving to an off-screen title scrolls the title pane; its `scroll` handler copies that back to the scroller. A guard flag stops the two handlers from echoing each other.

The page side is unchanged from 1.1: the Chart page's flex column containers get `min-w-0`, and the zoom controls stay outside the scrolling area.

*Alternatives:*
- One scroll container with a sticky title column (as built in 1.1): the titles stay put, but the scrollbar spans the bead list too. Superseded at the user's request.
- Hiding the native scrollbar and drawing a custom one under the bars: rejected, because it loses native scrollbar behaviour and accessibility.
- A transform-driven overlay for the titles instead of `scrollTop` mirroring: rejected, because focus scrolling would not work.

### D2: A zoom ladder instead of named presets
The zoom becomes a level on a ladder: `level 0 = Weeks`, `4 = Days`, `8 = Hours`. Between neighbouring presets there are 4 equal steps on a log scale:
- Weeks↔Days: ×1.470 per step (4.67× overall);
- Days↔Hours: ×2.130 per step (20.6× overall).

So one step from Hours changes the scale more than one step from Days, and every 4th step lands exactly on a preset. Levels run from −1 to 10:
- **Zoom-out limit, −1:** week ticks 57 px apart. At −2 they would be 39 px apart, below the 44 px minimum for labelled ticks.
- **Zoom-in limit, 10:** two Hours-band steps past Hours, so an hour is about 218 px wide.

`gantt-scale.ts` exports:
- `levelScale(level)` (pixels per millisecond);
- `PRESET_LEVEL = { weeks: 0, days: 4, hours: 8 }`;
- `MIN_LEVEL` and `MAX_LEVEL`;
- `presetAt(level)` (the preset at that level, or null);
- `stepFrom(scale, direction)`, which gives the next level strictly beyond an arbitrary scale. This is used from Fit.

The zoom state becomes `{ kind: "fit" } | { kind: "level"; level: number }`, still kept for the session. A preset button sets its level. The highlighted option is Fit, or `presetAt(level)`. Tick units still come from `tickUnit(scale)`, so labels switch from hours to days to weeks as the scale crosses their density thresholds.

*Alternative:* a fixed ×1.25 per click. Rejected by the user: presets would rarely be hit exactly, and Hours↔Days would take about 14 clicks.

### D3: Keep the centre in place
On +/−, before the scale changes, record the time at the centre of the visible timeline: `t = domain.start + (scrollLeft + viewW / 2) / oldScale`. Here `viewW` is the scroll container's width minus the title column. After the new scale renders (in a layout effect, so before paint), set `scrollLeft = (t − domain.start) × newScale − viewW / 2`, clamped to the scroll range. The arithmetic is a pure helper, `centeredScrollLeft(t, domainStart, scale, viewW, contentW)`, so it can be unit-tested. Preset buttons and Fit keep their current behaviour.

### D4: Marker tooltips with the app's Tooltip component
Each marker becomes a small group: the visible dot plus a transparent circle of about 8 px radius that takes the pointer and has `tabIndex=0`. It is wrapped in the existing Radix `Tooltip` (`components/ui/tooltip`, as the header tabs use), so the text appears on hover and on focus in the desktop webview as well. The native `<title>` is dropped, because WKWebView does not show it. The `aria-label` stays.
*Alternative:* a hand-rolled hover state with an absolutely positioned div. Rejected, because the app already has an accessible tooltip.

### D5: Legend
An inline HTML legend in the zoom controls row, to the right of +/−. Each entry is a tiny SVG swatch drawn with the same classes as the chart: the `BAR_CLASS` entries, the dashed planned outline, the connector with its arrowhead, the amber and grey dots, and the dashed now line. Text is small and muted, and the row wraps on narrow widths. Sharing the constants with the chart keeps the legend from drifting from the drawing.

### D6: Blockers inherited from epics in `scheduleBars`
`indexBeads` also records each bead's ancestor epics, following `children` and `childEpics`. When computing a bead's latest blocker finish, the scheduler also considers the blockers of every ancestor. A blocker's finish is defined as follows:
- **A bead:** the end of its own bar, as before.
- **An epic with content:** the latest end among its descendants' bars.
- **An epic with nothing inside:** the end of its own bar.

The existing memoization and in-progress guard cover this too. A blocker that is the bead's own ancestor or descendant is reached while still in progress, contributes nothing, and so cannot deadlock the pass. Recorded starts still win (design D12 of `add-gantt-chart-view`). Bars of epic sections keep their summary meaning; only when they are used as blockers does their finish come from their descendants.
*Alternative:* copy every epic-level dependency onto each child bead in the data. Rejected: it writes to the user's database and duplicates what bd already expresses through the parent link.

## Risks / Trade-offs

- [Sticky behaviour and real scrolling can't be verified in happy-dom] → Component tests check the structure (the timeline scroller is the only scroll container; the axis is sticky inside it) and the sync logic (setting `scrollTop` on the scroller is copied to the title pane, wheel events over the titles are passed on). The real behaviour is checked in the running app with a screenshot.
- [The titles follow the scroller through code, not natively] → The copy happens synchronously in the scroll event, in the same frame; a guard flag prevents feedback loops. If a webview ever shows lag, a fallback is to put the titles back in the scroller as a sticky column and accept the full-width scrollbar.
- [At level 10 a week-long chart is very wide (about 36,000 px for one week)] → It's only an SVG of rects and paths, and the browser handles widths like that. If profiling shows a problem, rendering only the visible rows remains the fallback from the first change's design.
- [The session-stored zoom value changes shape] → An old stored preset name is read back as its level, and anything unreadable falls back to Fit.

## Migration Plan

Client-only. Nothing to migrate beyond the session-stored zoom value (see above). To roll back, revert the change.
