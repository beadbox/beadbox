# Proposal

## Why

On long bead lists at the Hours zoom, scrolling the Chart sideways moves the whole pane, bead titles included, so you lose track of which bar belongs to which bead. Zooming is limited to three fixed presets (plus Fit), which are far apart: there is nothing between "a whole day on screen" and "an hour is 48 px". In the desktop app, hovering over a dependency dot shows nothing, nothing explains what the dots, outlines and colours mean, and beads in an epic that is blocked by another epic are drawn as if they could start right away.

## What Changes

- The bead title column (and the corner above it) stays fixed while the timeline scrolls horizontally. The time axis stays fixed while the rows scroll vertically. Only the bars move sideways.
- **+** and **−** buttons right of the **Weeks** option zoom the time axis step by step:
  - Between neighbouring presets (Hours↔Days, Days↔Weeks) the zoom moves in a fixed number of steps (4). The step size therefore adapts to the scale, and every 4th click lands exactly on a preset, which then becomes the highlighted option. For example, pressing − repeatedly from Days moves smoothly to Weeks.
  - Zooming keeps the moment at the centre of the visible area in place.
  - Starting from Fit, the first click moves to the next step in that direction.
  - + stops two steps past Hours; − stops when week ticks would get too close together to label. The buttons are disabled at those limits.
- Hovering over (or focusing) a cross-section dependency dot shows an in-app tooltip naming the other bead. The native SVG tooltip used so far is not shown by the macOS webview the desktop app runs in.
- A small legend to the right of the zoom controls explains the bar styles, the connector, the amber and grey dots, and the now line.
- Scheduling also honours blockers inherited from parent epics: a bead in an epic that is blocked (for example, group 2 blocked by group 1) starts only after that blocker finishes, and an epic finishes when the last bar inside it ends.
- No change to the data or to connector routing.

## Capabilities

### New Capabilities
<!-- None -->

### Modified Capabilities
- `gantt-chart`: adds requirements for the fixed title column and axis while scrolling, stepwise +/− zoom with seamless preset switching, marker tooltips, a legend, and blockers inherited from parent epics. The capability is introduced by the change `add-gantt-chart-view` (complete, not yet archived); archive that change first so this delta applies on top of it. The delta only adds requirements, so the existing "Time axis and zoom" requirement is unchanged.

## Impact

- **Client only** (`packages/client`):
  - `components/gantt-chart.tsx`: scroll layout (the grid replaced by a structure whose sticky title column and axis can stay fixed), +/− buttons, zoom state as a step level instead of a preset name, centre-anchored scroll adjustment.
  - `lib/gantt-scale.ts`: the zoom ladder (presets plus intermediate steps), limits, the active-preset lookup.
  - `components/gantt-chart.tsx` also: Radix tooltips on markers, legend.
  - `lib/gantt-model.ts`: inherited blockers in `scheduleBars`.
  - Tests: `gantt-scale.test.ts`, `gantt-model.test.ts`, `chart-view.test.tsx`.
- No server, data or dependency changes.
