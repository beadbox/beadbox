# Spec Delta

## ADDED Requirements

### Requirement: Fixed title column and axis while scrolling
When the timeline is wider or taller than the visible area, the bead title column and the corner above it SHALL stay in place during horizontal scrolling, and the time axis SHALL stay in place during vertical scrolling. Only the bars, connectors and gridlines SHALL move horizontally, and the rest of the page SHALL NOT scroll sideways. The scrollbars SHALL span only the timeline area, not the bead title column.

#### Scenario: Scrolling sideways at Hours zoom
- **WHEN** the Hours zoom makes the timeline wider than the view, and the user scrolls right
- **THEN** the bead titles stay where they are, aligned with their bars, and the header, filters and zoom controls do not move

#### Scenario: Scrolling down a long list
- **WHEN** the list of beads is taller than the view, and the user scrolls down
- **THEN** the time axis stays at the top, and the titles scroll together with their bars

#### Scenario: Scrollbars only along the timeline
- **WHEN** the timeline is wider and taller than the view
- **THEN** the horizontal scrollbar runs only under the bars, the vertical scrollbar only beside them, and scrolling over the titles moves the rows as well

### Requirement: Stepwise zoom buttons
The zoom controls SHALL include a **+** and a **−** button to the right of the **Weeks** option. Each press SHALL zoom one step in or out. Between neighbouring presets (Hours and Days, Days and Weeks) the zoom SHALL take a fixed number of equal steps (equal as ratios), so the step size adapts to the scale, and a step SHALL land exactly on each preset.

#### Scenario: Steps adapt to the scale
- **WHEN** the user presses − once from Hours, and once from Days
- **THEN** each press moves a quarter of the way (as a ratio) towards the next preset, so the first press changes the scale more than the second

#### Scenario: Zooming in
- **WHEN** the user presses + from Days
- **THEN** the axis zooms in one step towards Hours

### Requirement: Seamless preset switching
The highlighted zoom option SHALL follow the zoom level: when stepping lands on a preset, that preset SHALL become the highlighted option; between presets no preset SHALL be highlighted. Choosing a preset directly SHALL still jump to it.

#### Scenario: Minus from Days reaches Weeks
- **WHEN** Days is selected and the user presses − four times
- **THEN** the zoom moves in three intermediate steps and then lands on Weeks, which becomes highlighted

#### Scenario: Between presets
- **WHEN** Days is selected and the user presses − once
- **THEN** neither Days nor Weeks is highlighted

#### Scenario: From Fit
- **WHEN** Fit is selected and the user presses + or −
- **THEN** the zoom moves to the nearest step in that direction from Fit's scale, and Fit is no longer highlighted

### Requirement: Zoom keeps the centre in place
Zooming with + or − SHALL keep the moment at the horizontal centre of the visible timeline at the centre.

#### Scenario: Zoom around the centre
- **WHEN** the view is scrolled so that 10:00 on a given day is at the centre, and the user presses +
- **THEN** 10:00 on that day is still at the centre after zooming

### Requirement: Zoom limits
The **+** button SHALL be disabled two steps past Hours, and the **−** button SHALL be disabled at the step where week ticks would come closer together than they can be labelled.

#### Scenario: Zoom-in limit
- **WHEN** the zoom is two steps past Hours
- **THEN** + is disabled and − still works

#### Scenario: Zoom-out limit
- **WHEN** one more − press would put week ticks too close together to label
- **THEN** − is disabled at that step and + still works

### Requirement: Marker details on hover
Hovering over or keyboard-focusing a cross-section dependency marker SHALL show an in-app tooltip naming the relation and the other bead, in both the desktop app and the browser. Each marker SHALL have a hit area larger than its visible dot.

#### Scenario: Hover a blocked-by marker
- **WHEN** the user hovers over the amber marker of bead C, which is blocked by bead B in another section
- **THEN** a tooltip reads "Blocked by <B's id>: <B's title>"

#### Scenario: Keyboard focus
- **WHEN** a marker receives keyboard focus
- **THEN** the same tooltip is shown

### Requirement: Chart legend
The Chart SHALL show a compact legend to the right of the zoom controls, explaining the bar styles (working, planned or not started, blocked, done), the dependency connector, the amber marker (blocked by a bead in another section), the grey marker (blocks a bead in another section), and the now line, each with a swatch drawn like the chart itself.

#### Scenario: Legend matches the chart
- **WHEN** the Chart view is shown
- **THEN** the legend lists every bar style, the connector, both marker colours and the now line, and each swatch uses the same colour and style as in the chart

### Requirement: Blockers inherited from epics
A bead SHALL NOT be scheduled to start before the blockers of any of its ancestor epics finish. An epic that blocks something SHALL finish when the latest bar inside it ends, or when its own bar ends if it has nothing inside. A recorded start still SHALL win over this, as it does for direct blockers.

#### Scenario: Group blocked by a group
- **WHEN** epic G2 is blocked by epic G1, and the not-started bead T in G2 has no blockers of its own
- **THEN** T starts no earlier than the end of the latest bar in G1

#### Scenario: Nested epics
- **WHEN** epic E is blocked by bead X, and bead T sits in a child epic of E
- **THEN** T starts no earlier than X finishes

#### Scenario: Recorded start wins
- **WHEN** bead T has a recorded `started_at` before its parent epic's blocker finished
- **THEN** T's bar still starts at the recorded time
