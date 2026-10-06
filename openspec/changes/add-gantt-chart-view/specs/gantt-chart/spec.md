# Spec Delta

## Purpose

Shows each epic's beads on a timeline: when they started, how long they have run or waited, when they closed, and what blocks what. Also records the start time that beads itself does not keep.

## ADDED Requirements

### Requirement: Chart navigation
The header SHALL show a "Chart" button directly after the Formulas button. Activating it, or pressing ⌘5 (Ctrl+5 off macOS) from any top-level view, SHALL open the Chart view at its own route. The button SHALL appear active while the Chart view is shown.

#### Scenario: Open from header
- **WHEN** the user clicks "Chart" in the header
- **THEN** the Chart view is shown and the Chart button is highlighted as active

#### Scenario: Open by shortcut
- **WHEN** the user presses ⌘5 while on Beads, Activity, Formulas or Trains
- **THEN** the Chart view is shown

### Requirement: Epic grouping
The Chart view SHALL show one section per epic, with nested child epics as collapsible subsections, following the same hierarchy as the Beads epic tree. Each child bead SHALL occupy one row in its epic's section.

#### Scenario: Nested epic
- **WHEN** epic A has child epic A.1, and A.1 has child bead X
- **THEN** A.1 is shown as a subsection inside A, and X is a row inside A.1

#### Scenario: Collapse an epic
- **WHEN** the user collapses an epic section
- **THEN** its rows and subsections are hidden and its summary bar stays visible

### Requirement: Archived beads excluded
The Chart view SHALL NOT show beads labelled `archived`, nor any bead under an archived epic. Backlogged epics SHALL be shown like any other epic.

#### Scenario: Archived epic hidden
- **WHEN** an epic carries the `archived` label
- **THEN** neither the epic nor any of its descendants appear in the chart

#### Scenario: Backlogged epic shown
- **WHEN** an epic is in the Beads view's Backlog section
- **THEN** it appears in the chart as a normal epic section

### Requirement: Ungrouped beads
Beads that belong to no epic SHALL be shown in a section labelled "Ungrouped".

#### Scenario: Bead without epic
- **WHEN** a bead has no parent epic and passes the active filters
- **THEN** it is shown as a row in the "Ungrouped" section

### Requirement: Epic summary bar
Each epic section header SHALL show a summary bar from the earliest start to the latest end of all bars inside it, including nested epics. An epic with no visible descendants SHALL instead show its own bar, using the same start, end and style rules as a bead.

#### Scenario: Summary span
- **WHEN** an epic's visible beads start at the earliest on Oct 1 and end at the latest on Oct 5
- **THEN** the epic's summary bar spans Oct 1 to Oct 5

#### Scenario: Childless epic
- **WHEN** an epic has no visible child beads or child epics
- **THEN** its header shows a bar for the epic itself

### Requirement: Bead title links
Each row SHALL show the bead's title at the left of the chart. Activating the title SHALL switch to the Beads view with that bead selected and its detail shown.

#### Scenario: Open bead from chart
- **WHEN** the user clicks the title of bead X in the chart
- **THEN** the Beads view is shown with bead X selected and its detail open

### Requirement: Bar start time
A bead with `started_at` metadata SHALL start at that recorded time. A bead without it SHALL start at its calculated start: for a not-started bead (open, deferred or blocked), the later of now and its latest blocker's finish; for any other bead, the later of its creation time and its latest blocker's finish, but never after its own close time (finished) or after now (in progress).

#### Scenario: Recorded start
- **WHEN** a bead has metadata `started_at` = T
- **THEN** its bar starts at T, whatever its blockers do

#### Scenario: Finished without a recorded start
- **WHEN** a closed bead has no `started_at`, was created at C, and its blocker finished at F later than C
- **THEN** its bar starts at F, or at its close time if that is earlier

#### Scenario: Not started, no blockers
- **WHEN** an open bead has no blockers
- **THEN** its bar starts at now

### Requirement: Bar end time
A closed bead's bar SHALL end at its close time. A bead that has started but is not closed SHALL end at the current time, extending as time passes. A not-started bead's bar is its planned window and SHALL end at its start plus its estimated duration, or plus one hour when it has no estimate.

#### Scenario: Closed bead
- **WHEN** a bead is closed at time C
- **THEN** its bar ends at C

#### Scenario: Running bead grows
- **WHEN** a bead is in progress and the view stays open
- **THEN** its bar's end keeps moving to the current time

#### Scenario: Planned length
- **WHEN** a not-started bead has an estimate of 90 minutes, and another has no estimate
- **THEN** their bars are 90 minutes and one hour long

### Requirement: Dependency scheduling
A blocker's finish SHALL be the end of its own bar, computed by these rules, so schedules follow dependency chains. Every blocker in the workspace's dependency data SHALL count, including blockers hidden by filters or shown in other sections; blockers that are not loaded are ignored, and a dependency cycle SHALL be broken rather than prevent drawing. When dependency data is unavailable, no bead is rescheduled.

#### Scenario: One blocker
- **WHEN** not-started bead B is blocked by running bead A
- **THEN** B's bar starts where A's bar ends (now), not at the same time as A

#### Scenario: Several blockers
- **WHEN** bead C is blocked by A and B, and B finishes later than A
- **THEN** C's bar starts where B's bar ends

#### Scenario: Chain
- **WHEN** not-started bead C is blocked by not-started bead B, which is blocked by running bead A
- **THEN** B starts when A ends, and C starts when B's planned window ends

#### Scenario: Independent beads
- **WHEN** two not-started beads have no blockers
- **THEN** both start at now and appear in parallel

#### Scenario: Blocker hidden by filters
- **WHEN** bead B's blocker A is hidden by the active filters
- **THEN** B is still scheduled after A's finish

### Requirement: Bar style by state
A bead whose status is open or deferred SHALL be drawn as a hollow bar. A blocked bead SHALL be drawn as a hollow red bar. A bead in any other non-closed status SHALL be drawn as a solid bar. A closed bead SHALL be drawn as a solid bar in a distinct "done" color.

#### Scenario: Waiting vs working
- **WHEN** bead X is open and bead Y is in progress
- **THEN** X is drawn hollow and Y is drawn solid

#### Scenario: Blocked bead
- **WHEN** a bead's status is `blocked`
- **THEN** it is drawn as a hollow red bar

#### Scenario: Blocked after starting
- **WHEN** a bead with `started_at` = T becomes `blocked`
- **THEN** it is drawn as a hollow red bar that still starts at T

#### Scenario: Custom status counts as started
- **WHEN** a bead has a status such as `ready_for_qa` or a workspace-defined status
- **THEN** it is drawn as a solid (started) bar

### Requirement: Dependency connectors
For each blocking dependency where both beads are shown in the same section, the chart SHALL draw a connector from the predecessor's end edge to the dependent's start edge, ending in a small arrowhead pointing into the dependent. No part of a connector SHALL be drawn over the interior of any bar. Connectors that end at a hollow (not-started or blocked) bar SHALL use the foreground colour.

#### Scenario: Gap between the bars
- **WHEN** predecessor A ends before dependent B starts, and both are rows in the same epic section
- **THEN** one connector runs from A's end edge across the gap to B's start edge, with the arrowhead at B's start edge

#### Scenario: Bars overlap in time
- **WHEN** dependent B starts before predecessor A ends
- **THEN** the connector leaves A's end edge, runs along the gap between rows, and enters B's start edge from the left, crossing neither A nor B

#### Scenario: Rows in between
- **WHEN** other rows lie between A and B
- **THEN** the connector's vertical run passes where none of those rows has a bar

#### Scenario: Not-started dependent
- **WHEN** B is drawn as a dotted (not-started) bar
- **THEN** the connector ends at B's outline, in the foreground colour, and no part of it is drawn inside B

#### Scenario: Several dependencies
- **WHEN** several connectors start, end or pass in the same area
- **THEN** no two connectors share a segment, so each one can be followed on its own

### Requirement: Cross-section dependency marker
When a blocking dependency connects beads in different sections, or the other bead is not shown, the chart SHALL show a marker on the bar instead of an arrow. The marker SHALL identify the other bead.

#### Scenario: Dependency in another epic
- **WHEN** bead B in epic 1 is blocked by bead A in epic 2
- **THEN** B's bar shows a dependency marker identifying A, and no arrow is drawn between sections

### Requirement: Shared filters
The Chart view SHALL show the same filter controls as the Beads view and SHALL use the same saved filter state, so a change in either view applies to both and persists across sessions.

#### Scenario: Filter carries over
- **WHEN** the user filters by assignee "alice" on the Beads view and then opens the Chart view
- **THEN** the Chart view shows only beads matching assignee "alice" and the filter control shows that selection

### Requirement: Time axis and zoom
The chart SHALL show a time axis with zoom levels of hours, days and weeks. On open, the view SHALL fit all visible bars into the visible width.

#### Scenario: Initial fit
- **WHEN** the Chart view opens
- **THEN** every visible bar fits inside the visible time range

#### Scenario: Change zoom
- **WHEN** the user selects the "hours" zoom level
- **THEN** the axis is labelled in hours and bars rescale accordingly

### Requirement: Live updates
The Chart view SHALL reflect bead changes made outside Beadbox, through the same live-update mechanism as the Beads view, without a manual refresh.

#### Scenario: Close from CLI
- **WHEN** a bead shown in the chart is closed with the bd CLI
- **THEN** its bar ends at the close time and takes the done style without a manual refresh

### Requirement: Start-time recording
When Beadbox loads a workspace's beads and finds a bead in a started status (any status other than open, deferred, blocked or closed) without `started_at` metadata, it SHALL set `started_at` to that bead's last-updated time. It SHALL NOT overwrite an existing value and SHALL NOT record a value for closed beads.

#### Scenario: Agent claims a bead
- **WHEN** an agent sets bead X to `in_progress` with the bd CLI at time T, and Beadbox next loads the workspace
- **THEN** bead X gets metadata `started_at` = T

#### Scenario: Existing value kept
- **WHEN** a started bead already has `started_at` metadata
- **THEN** Beadbox does not change it

#### Scenario: Closed without observed start
- **WHEN** a bead went from open to closed without Beadbox seeing it started
- **THEN** Beadbox records no `started_at` and the bar runs from creation time to close time

#### Scenario: Blocked without starting
- **WHEN** a bead goes from `open` to `blocked`
- **THEN** Beadbox records no `started_at`

#### Scenario: Reopened bead
- **WHEN** a bead with `started_at` is reopened and started again
- **THEN** the original `started_at` is kept
