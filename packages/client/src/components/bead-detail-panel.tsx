"use client"

import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ExternalLink,
  FileText,
  Maximize2,
  Pencil,
  Rocket,
  Trash2,
} from "lucide-react"
import posthog from "posthog-js"
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react"
import { CommentsSection } from "@/components/bead-comments-section"
import { safeCapture } from "@/lib/posthog-safe"
import { BeadDependenciesDisplay } from "@/components/bead-dependencies-display"
import {
  captureDetailPanelAction,
  formatDate,
  formatRelativeTime,
  getStatusDisplayConfig,
  getWorkflowAdvancement,
  typeColors,
} from "@/components/bead-detail-helpers"
import { BeadExpandedViewModal } from "@/components/bead-expanded-view-modal"
import { MetadataControls } from "@/components/bead-metadata-controls"
import { SchedulingControls } from "@/components/bead-scheduling-controls"
import { CopyableId } from "@/components/copyable-id"
import { EditableMarkdownField } from "@/components/editable-markdown-field"
import { ExpandedCommentModal } from "@/components/expanded-comment-modal"
import { MoleculeDag } from "@/components/molecule-dag"
import { SimpleMarkdown } from "@/components/simple-markdown"
import { SpecViewerModal } from "@/components/spec-viewer-modal"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useBeadMutations } from "@/hooks/use-bead-mutations"
import { isMoleculePresentation } from "@/lib/molecule-presentation"
import { useCommentNavigation } from "@/hooks/use-comment-navigation"
import { useViewport } from "@/hooks/use-viewport"
import type { CommentSortOrder } from "@/lib/local-storage"
import { getAnalyticsEnabled, getCommentSortOrder, setCommentSortOrder } from "@/lib/local-storage"
import type { Bead, Comment } from "@/lib/types"
import { cn } from "@/lib/utils"

interface BeadDetailPanelProps {
  bead: Bead | null
  onClose: () => void
  onUpdate: (bead: Bead) => void
  onAddComment: (beadId: string, comment: Comment) => void
  onDelete?: (beadId: string) => void
  onBeadNavigate?: (beadId: string) => void
  parentPath?: { id: string; title: string }[]
  dbPath?: string
  assignees?: string[]
  availableStatuses?: string[]
  availableTypes?: string[]
  typeCatalogReady?: boolean
  // beadbox-3qo: ordered status.custom chain for the workflow advancement
  // button (pm/spec §4.3). Empty array → button hidden.
  customStatusChain?: string[]
  isLoadingBead?: boolean
  isFocused?: boolean
  onFocus?: () => void
}

interface BeadDetailPanelHandle {
  navigateComments: (direction: "up" | "down") => void
  scrollToLatestComment: () => void
}

export const BeadDetailPanel = forwardRef<BeadDetailPanelHandle, BeadDetailPanelProps>(
  function BeadDetailPanel(
    {
      bead,
      onClose,
      onUpdate,
      onAddComment,
      onDelete,
      onBeadNavigate,
      parentPath = [],
      dbPath,
      assignees = [],
      availableStatuses = ["open", "in_progress", "closed"],
      availableTypes = [],
      typeCatalogReady = false,
      customStatusChain = [],
      isLoadingBead = false,
      isFocused = false,
      onFocus,
    },
    ref,
  ) {
    const { isMobile } = useViewport()
    const mutations = useBeadMutations({ bead, dbPath, onUpdate })
    const scrollContainerRef = useRef<HTMLDivElement | null>(null)
    const descriptionRef = useRef<HTMLDivElement | null>(null)

    // Comment sort order
    const [commentSort, setCommentSort] = useState<CommentSortOrder>("newest")
    useEffect(() => {
      setCommentSort(getCommentSortOrder())
    }, [])
    const handleCommentSortChange = useCallback(() => {
      setCommentSort((prev) => {
        const next = prev === "newest" ? "oldest" : "newest"
        setCommentSortOrder(next)
        return next
      })
    }, [])

    // Comment navigation
    const comments = useCommentNavigation({ bead, commentSort, scrollContainerRef, isFocused })

    // Expose comment navigation to parent
    useImperativeHandle(
      ref,
      () => ({
        navigateComments: comments.navigateComments,
        scrollToLatestComment: comments.scrollToLatestComment,
      }),
      [comments.navigateComments, comments.scrollToLatestComment],
    )

    // Molecule DAG view state
    const [moleculeViewEnabled, setMoleculeViewEnabled] = useState(false)
    const [activeDetailTab, setActiveDetailTab] = useState<"details" | "molecule">("details")
    const isMolecule = bead ? isMoleculePresentation(bead) : false

    useEffect(() => {
      const check = () => {
        try {
          const ph = posthog.isFeatureEnabled("enable-molecule-view")
          if (ph !== undefined) return !!ph
        } catch {
          /* PostHog not ready */
        }
        try {
          return localStorage.getItem("beadbox_enable_molecule_view") === "true"
        } catch {
          return false
        }
      }
      setMoleculeViewEnabled(check())
      const cleanup = posthog.onFeatureFlags?.(() => setMoleculeViewEnabled(check()))
      return () => cleanup?.()
    }, [])

    useEffect(() => {
      setActiveDetailTab("details")
    }, [bead?.id])

    // Spec viewer state
    const [isEditingSpecId, setIsEditingSpecId] = useState(false)
    const [editSpecIdValue, setEditSpecIdValue] = useState("")
    const [specViewerOpen, setSpecViewerOpen] = useState(false)
    const [specViewerContent, setSpecViewerContent] = useState("")
    const [specViewerLoading, setSpecViewerLoading] = useState(false)
    const [specViewerError, setSpecViewerError] = useState("")

    const handleSpecIdEdit = useCallback(() => {
      setEditSpecIdValue(mutations.specId)
      setIsEditingSpecId(true)
    }, [mutations.specId])

    const handleSpecIdView = useCallback(async () => {
      if (!mutations.specId || !dbPath) return
      setSpecViewerLoading(true)
      setSpecViewerError("")
      setSpecViewerContent("")
      setSpecViewerOpen(true)
      const result = await mutations.handleSpecIdView()
      if (result?.success) {
        setSpecViewerContent(result.content)
      } else if (result) {
        setSpecViewerError(result.error)
      }
      setSpecViewerLoading(false)
    }, [mutations, dbPath])

    const handleSpecIdSave = useCallback(() => {
      setIsEditingSpecId(false)
      mutations.saveSpecId(editSpecIdValue.trim())
    }, [editSpecIdValue, mutations])

    // Design editing state
    const [isEditingDesign, setIsEditingDesign] = useState(false)
    const [editDesignValue, setEditDesignValue] = useState("")
    const handleDesignSave = useCallback(() => {
      setIsEditingDesign(false)
      mutations.saveDesign(editDesignValue)
    }, [editDesignValue, mutations])

    // Expanded views
    const [expandedComment, setExpandedComment] = useState<Comment | null>(null)
    const [isExpandedView, setIsExpandedView] = useState(false)

    // Reset UI state on bead change
    useEffect(() => {
      if (bead) {
        setIsEditingSpecId(false)
        setEditSpecIdValue("")
        setIsEditingDesign(false)
        setEditDesignValue("")
        setIsExpandedView(false)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps -- only reset UI state on bead identity change, not every field update
    }, [bead?.id])

    // Fire app_issue_viewed once per bead
    const viewedBeadIdRef = useRef<string | null>(null)
    useEffect(() => {
      if (!bead || bead.id === viewedBeadIdRef.current) return
      viewedBeadIdRef.current = bead.id
      if (getAnalyticsEnabled()) {
        safeCapture("app_issue_viewed", { source: "panel" })
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps -- only fire analytics on bead identity change
    }, [bead?.id])

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && comments.focusedCommentIndex !== null) {
          e.preventDefault()
          setExpandedComment(comments.sortedComments[comments.focusedCommentIndex])
        }
      },
      [comments.focusedCommentIndex, comments.sortedComments],
    )

    // Empty state
    if (!bead) {
      return (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          <p className="text-base">Select a bead to view details</p>
        </div>
      )
    }

    // beadbox-3qo: dynamic workflow-advancement footer (pm/spec §4.3). The
    // discriminated `advancement` distinguishes the three button states:
    //   advance → "Mark as <Title>" (mid-chain or below-chain)
    //   close   → "Close" at the chain's terminal entry (engineer choice per
    //             §4.3 for terminal UX; writes status=closed via the same
    //             handleStatusChange path, which already runs the "Bead
    //             closed!" toast + archive-hint flow)
    //   hidden  → empty chain or bead already closed → no footer
    // Mid-save we keep the footer mounted so the spinner + disabled button
    // render cleanly while the optimistic mutation lands.
    const advancement = getWorkflowAdvancement(mutations.status, customStatusChain)
    const hasFooter = mutations.fieldStates.status.isSaving || advancement.kind !== "hidden"
    const advanceTargetStatus =
      advancement.kind === "advance"
        ? advancement.targetStatus
        : advancement.kind === "close"
          ? "closed"
          : null
    const advanceLabel =
      advancement.kind === "advance"
        ? `Mark as ${getStatusDisplayConfig(advancement.targetStatus).label}`
        : advancement.kind === "close"
          ? "Close"
          : null

    return (
      <div
        className="h-full flex flex-col relative outline-none"
        onClick={onFocus}
        onKeyDown={handleKeyDown}
        tabIndex={0}
      >
        {/* Header */}
        <div className="-mx-4 px-4 md:px-6 pt-3 md:pt-4 pb-3 md:pb-4 bg-card border-b border-border shrink-0">
          <TooltipProvider>
            {/* Title row */}
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className={cn(
                        "px-2 py-1 text-xs font-medium rounded border capitalize cursor-pointer hover:opacity-80 transition-opacity shrink-0 flex items-center gap-1.5",
                        typeColors[mutations.type] ??
                          "bg-slate-500/20 text-slate-400 border-slate-500/30",
                        mutations.fieldStates.type.hasError && "ring-2 ring-destructive",
                        isMobile && "min-h-[44px] min-w-[44px]",
                      )}
                      disabled={mutations.fieldStates.type.isSaving || !typeCatalogReady}
                    >
                      {mutations.fieldStates.type.isSaving ? <Spinner className="h-3 w-3" /> : null}
                      {mutations.type}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {[...new Set([mutations.type, ...availableTypes])].map((t) => (
                      <DropdownMenuItem
                        key={t}
                        onClick={() => mutations.handleTypeChange(t)}
                        className="capitalize"
                      >
                        {t}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <h2 className="text-base font-semibold text-foreground/70 truncate">
                  {bead.title}
                </h2>
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => mutations.handleStatusChange("closed")}
                      disabled={mutations.status === "closed"}
                      className={cn("h-7 w-7", isMobile && "min-h-[44px] min-w-[44px]")}
                    >
                      <CheckCircle2 className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Close Bead</TooltipContent>
                </Tooltip>
                {onDelete && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onDelete(bead.id)}
                        className={cn(
                          "h-7 w-7 text-muted-foreground hover:text-destructive",
                          isMobile && "min-h-[44px] min-w-[44px]",
                        )}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Delete Bead</TooltipContent>
                  </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setIsExpandedView(true)}
                      className={cn("h-7 w-7", isMobile && "min-h-[44px] min-w-[44px]")}
                    >
                      <Maximize2 className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Expand View</TooltipContent>
                </Tooltip>
              </div>
            </div>

            {/* ID, External Ref, Timestamps */}
            <div className="flex items-center gap-3 text-sm text-muted-foreground mt-2 flex-wrap">
              <CopyableId
                id={bead.id}
                className="text-sm"
                onCopy={() => captureDetailPanelAction("copy_id", bead.type)}
              />
              {bead.externalRef && (
                <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 font-medium">
                  {bead.externalRef}
                </span>
              )}
              {bead.createdAt && (
                <span data-testid="bead-created-ts" title={formatDate(bead.createdAt)}>
                  Created: {formatRelativeTime(bead.createdAt)}
                </span>
              )}
              {bead.updatedAt && (
                <span data-testid="bead-updated-ts" title={formatDate(bead.updatedAt)}>
                  Updated: {formatRelativeTime(bead.updatedAt)}
                </span>
              )}
            </div>

            {/* Spec ID row */}
            <div className="flex items-center gap-2 mt-1.5 text-sm text-muted-foreground">
              {isEditingSpecId ? (
                <div className="flex items-center gap-1">
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                  <input
                    value={editSpecIdValue}
                    onChange={(e) => setEditSpecIdValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSpecIdSave()
                      if (e.key === "Escape") {
                        setIsEditingSpecId(false)
                        setEditSpecIdValue("")
                      }
                    }}
                    onBlur={handleSpecIdSave}
                    placeholder="spec path or URL..."
                    autoFocus
                    className="w-full md:w-48 bg-transparent border-b border-border text-foreground text-sm outline-none"
                  />
                </div>
              ) : mutations.specId ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    {mutations.specId.startsWith("http") ? (
                      <a
                        href={mutations.specId}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400 font-medium hover:bg-indigo-500/30 transition-colors"
                      >
                        <ExternalLink className="h-3 w-3" />
                        <span className="truncate max-w-[200px]">{mutations.specId}</span>
                      </a>
                    ) : (
                      <button
                        onClick={handleSpecIdView}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400 font-medium hover:bg-indigo-500/30 transition-colors cursor-pointer"
                      >
                        <FileText className="h-3 w-3" />
                        <span className="truncate max-w-[200px]">{mutations.specId}</span>
                      </button>
                    )}
                  </TooltipTrigger>
                  <TooltipContent>
                    {mutations.specId.startsWith("http")
                      ? "Open spec (click to edit: double-click)"
                      : "Click to view spec"}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={handleSpecIdEdit}
                      className={cn(
                        "inline-flex items-center gap-1 text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors",
                        isMobile && "min-h-[44px]",
                      )}
                    >
                      <FileText className="h-3 w-3" />
                      <span>Add spec</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Link a specification document</TooltipContent>
                </Tooltip>
              )}
              {mutations.fieldStates.specId.isSaving && <Spinner className="h-3 w-3" />}
              {mutations.specId && !isEditingSpecId && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={handleSpecIdEdit}
                      className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                    >
                      <span className="text-xs">edit</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Edit spec ID</TooltipContent>
                </Tooltip>
              )}
            </div>

            <SchedulingControls
              dueAt={mutations.dueAt}
              deferUntil={mutations.deferUntil}
              estimatedMinutes={mutations.estimatedMinutes}
              fieldStates={{
                dueAt: mutations.fieldStates.dueAt,
                deferUntil: mutations.fieldStates.deferUntil,
                estimatedMinutes: mutations.fieldStates.estimatedMinutes,
              }}
              onSaveDue={mutations.saveDue}
              onSaveDefer={mutations.saveDefer}
              onSaveEstimate={mutations.saveEstimate}
              isMobile={isMobile}
            />

            <MetadataControls
              status={mutations.status}
              priority={mutations.priority}
              assignee={mutations.assignee}
              labels={mutations.labels}
              availableStatuses={availableStatuses}
              assignees={assignees}
              fieldStates={{
                status: mutations.fieldStates.status,
                priority: mutations.fieldStates.priority,
                assignee: mutations.fieldStates.assignee,
              }}
              onStatusChange={mutations.handleStatusChange}
              onPriorityChange={mutations.handlePriorityChange}
              onAssigneeChange={mutations.handleAssigneeChange}
              onRemoveLabel={mutations.handleRemoveLabel}
              isMobile={isMobile}
            />
          </TooltipProvider>
        </div>

        {/* Molecule tab bar */}
        {isMolecule && moleculeViewEnabled && (
          <div className="shrink-0 border-b border-border/50 px-4 md:px-6">
            <div className="flex gap-4">
              <button
                onClick={() => setActiveDetailTab("details")}
                className={cn(
                  "py-2 text-xs font-medium transition-colors border-b-2",
                  activeDetailTab === "details"
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground/70",
                )}
              >
                Details
              </button>
              <button
                onClick={() => {
                  setActiveDetailTab("molecule")
                  captureDetailPanelAction("expand_deps", bead.type)
                }}
                className={cn(
                  "py-2 text-xs font-medium transition-colors border-b-2",
                  activeDetailTab === "molecule"
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground/70",
                )}
              >
                Molecule
              </button>
            </div>
          </div>
        )}

        {/* Molecule DAG view */}
        {isMolecule && moleculeViewEnabled && activeDetailTab === "molecule" ? (
          <div className="flex-1 min-h-0 relative overflow-hidden">
            <MoleculeDag beadId={bead.id} dbPath={dbPath} onBeadNavigate={onBeadNavigate} />
          </div>
        ) : (
          <div
            ref={scrollContainerRef}
            className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 hide-scrollbar"
          >
            <TooltipProvider>
              <div className="py-4 flex gap-3">
                <div className="flex-1 min-w-0 space-y-4">
                  {/* Description */}
                  <div ref={descriptionRef}>
                    <EditableMarkdownField
                      key={`${bead.id}:description`}
                      label="Description"
                      value={mutations.description}
                      isSaving={mutations.fieldStates.description.isSaving}
                      onSave={(value) => mutations.saveTextField("description", value)}
                    />
                  </div>

                  {/* Design */}
                  {(mutations.design || isEditingDesign) && (
                    <div className="pt-4 border-t border-border/30">
                      <div className="flex items-center gap-2 mb-2">
                        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Design
                        </h3>
                        {!isEditingDesign && (
                          <button
                            aria-label="Edit Design"
                            onClick={() => {
                              setEditDesignValue(mutations.design)
                              setIsEditingDesign(true)
                            }}
                            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <Pencil className="h-3 w-3" />
                            <span>Edit</span>
                          </button>
                        )}
                        {mutations.fieldStates.design.isSaving && <Spinner className="h-3 w-3" />}
                      </div>
                      {isEditingDesign ? (
                        <div>
                          <Textarea
                            value={editDesignValue}
                            onChange={(e) => setEditDesignValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                e.preventDefault()
                                handleDesignSave()
                              }
                              if (e.key === "Escape") {
                                setIsEditingDesign(false)
                                setEditDesignValue("")
                              }
                            }}
                            placeholder="Design notes (markdown)..."
                            rows={8}
                            autoFocus
                            className="w-full bg-transparent border-border/40 text-foreground text-sm resize-y"
                          />
                          <div className="flex items-center gap-2 mt-1.5">
                            <Button size="sm" className="h-6 text-xs" onClick={handleDesignSave}>
                              Save
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 text-xs"
                              onClick={() => {
                                setIsEditingDesign(false)
                                setEditDesignValue("")
                              }}
                            >
                              Cancel
                            </Button>
                            <span className="text-xs text-muted-foreground/40">
                              Cmd+Enter to save
                            </span>
                          </div>
                        </div>
                      ) : (
                        <div className="prose prose-sm prose-invert max-w-none text-foreground/90">
                          <SimpleMarkdown content={mutations.design} />
                        </div>
                      )}
                    </div>
                  )}
                  {!mutations.design && !isEditingDesign && (
                    <div className="pt-4 border-t border-border/30">
                      <button
                        onClick={() => {
                          setEditDesignValue("")
                          setIsEditingDesign(true)
                        }}
                        className={cn(
                          "inline-flex items-center gap-1 text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors",
                          isMobile && "min-h-[44px]",
                        )}
                      >
                        <Pencil className="h-3 w-3" />
                        <span>Add design</span>
                      </button>
                    </div>
                  )}

                  {/* Acceptance Criteria */}
                  <EditableMarkdownField
                    key={`${bead.id}:acceptanceCriteria`}
                    label="Acceptance Criteria"
                    value={mutations.acceptanceCriteria}
                    isSaving={mutations.fieldStates.acceptanceCriteria.isSaving}
                    onSave={(value) => mutations.saveTextField("acceptanceCriteria", value)}
                  />

                  {/* Notes */}
                  <EditableMarkdownField
                    key={`${bead.id}:notes`}
                    label="Notes"
                    value={mutations.notes}
                    isSaving={mutations.fieldStates.notes.isSaving}
                    onSave={(value) => mutations.saveTextField("notes", value)}
                  />

                  {/* Custom Fields */}
                  {Object.keys(bead.metadata || {}).length > 0 && (
                    <div className="pt-4 border-t border-border/30">
                      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                        Custom Fields
                      </h3>
                      <div className="space-y-1">
                        {Object.entries(bead.metadata!).map(([key, value]) => (
                          <div key={key} className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">{key}</span>
                            <span className="text-foreground/90">{value}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <BeadDependenciesDisplay
                    blockedBy={bead.blockedBy}
                    blocks={bead.blocks}
                    onRemove={mutations.handleRemoveDependency}
                    onNavigate={onBeadNavigate}
                    isMobile={isMobile}
                  />

                  <CommentsSection
                    commentsCount={bead.comments.length}
                    sortedComments={comments.sortedComments}
                    groupedComments={comments.groupedComments}
                    commentSort={commentSort}
                    onSortChange={handleCommentSortChange}
                    onDeleteComment={mutations.handleDeleteComment}
                    onExpandComment={setExpandedComment}
                    isLoadingBead={isLoadingBead}
                    isMobile={isMobile}
                    focusedCommentIndex={comments.focusedCommentIndex}
                    onCommentClick={(idx) => {
                      onFocus?.()
                      comments.setFocusedCommentIndex(idx)
                    }}
                    commentRefs={comments.commentRefs}
                    firstCommentRef={comments.firstCommentRef}
                    lastCommentRef={comments.lastCommentRef}
                  />
                </div>

                {/* Content Minimap */}
                <div className="w-8 shrink-0 hidden md:flex flex-col gap-1 py-1 sticky top-0 self-start">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => {
                          comments.setFocusedCommentIndex(null)
                          descriptionRef.current?.scrollIntoView({
                            behavior: "smooth",
                            block: "start",
                          })
                        }}
                        className={cn(
                          "w-full rounded-sm transition-all hover:opacity-100",
                          comments.focusedCommentIndex === null
                            ? "bg-blue-500 opacity-100"
                            : "bg-blue-500/30 opacity-60 hover:bg-blue-500/50",
                        )}
                        style={{
                          height: `${Math.max(16, Math.min(40, Math.floor((mutations.description?.length || 0) / 50) + 16))}px`,
                        }}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      <p className="font-medium text-xs">Description</p>
                    </TooltipContent>
                  </Tooltip>

                  {isLoadingBead && bead.comments.length === 0 ? (
                    <>
                      <Skeleton className="w-full h-4 rounded-sm opacity-40" />
                      <Skeleton className="w-full h-4 rounded-sm opacity-40" />
                    </>
                  ) : (
                    comments.sortedComments.map((comment, index) => {
                      const height = Math.max(
                        12,
                        Math.min(60, Math.floor(comment.content.length / 20) + 12),
                      )
                      return (
                        <Tooltip key={comment.id}>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => {
                                comments.setFocusedCommentIndex(index)
                                comments.commentRefs.current[index]?.scrollIntoView({
                                  behavior: "smooth",
                                  block: "nearest",
                                })
                              }}
                              className={cn(
                                "w-full rounded-sm transition-all hover:opacity-100 flex items-center justify-center overflow-hidden",
                                comments.focusedCommentIndex === index
                                  ? "bg-primary opacity-100"
                                  : "bg-muted-foreground/30 opacity-60 hover:bg-muted-foreground/50",
                              )}
                              style={{ height: `${height}px` }}
                            >
                              <span className="text-[7px] font-medium text-white/80 truncate px-0.5">
                                {comment.author.slice(0, 5)}
                              </span>
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="left" className="max-w-[200px]">
                            <p className="font-medium text-xs">{comment.author}</p>
                            <p className="text-xs text-muted-foreground truncate">
                              {comment.content.slice(0, 50)}
                              {comment.content.length > 50 ? "..." : ""}
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      )
                    })
                  )}
                </div>
              </div>
            </TooltipProvider>
          </div>
        )}

        {/* Footer */}
        {hasFooter && (
          <div className="-mx-4 px-4 md:px-6 py-3 bg-card border-t border-border shrink-0">
            <Button
              onClick={() => {
                if (advanceTargetStatus) mutations.handleStatusChange(advanceTargetStatus)
              }}
              disabled={mutations.fieldStates.status.isSaving || !advanceTargetStatus}
              className={cn(
                "w-full bg-emerald-600 hover:bg-emerald-500 text-white",
                isMobile && "min-h-[44px]",
              )}
            >
              {mutations.fieldStates.status.isSaving ? (
                <Spinner className="h-4 w-4 mr-2" />
              ) : (
                <Rocket className="h-4 w-4 mr-2" />
              )}
              {advanceLabel ?? "Next"}
            </Button>
          </div>
        )}

        {/* Floating nav */}
        {bead.comments.length > 0 &&
          (comments.isAtTop ? !comments.isFirstCommentVisible : true) && (
            <div
              className={cn(
                "absolute left-1/2 -translate-x-1/2 z-10",
                hasFooter ? "bottom-20" : "bottom-4",
              )}
            >
              {comments.isAtTop && !comments.isFirstCommentVisible ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={comments.scrollToFirstComment}
                  className="shadow-lg shadow-black/30 hover:shadow-black/40 transition-shadow"
                >
                  <ArrowDown className="h-4 w-4 mr-1.5" />
                  {commentSort === "newest" ? "Latest comment" : "First comment"}
                </Button>
              ) : comments.isLastCommentVisible ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={comments.scrollToFirstComment}
                  className="shadow-lg shadow-black/30 hover:shadow-black/40 transition-shadow"
                >
                  <ArrowUp className="h-4 w-4 mr-1.5" />
                  {commentSort === "newest" ? "Latest comment" : "First comment"}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={comments.scrollToLastComment}
                  className="shadow-lg shadow-black/30 hover:shadow-black/40 transition-shadow"
                >
                  <ArrowDown className="h-4 w-4 mr-1.5" />
                  {commentSort === "newest" ? "Oldest comment" : "Latest comment"}
                </Button>
              )}
            </div>
          )}

        {/* Modals */}
        <ExpandedCommentModal comment={expandedComment} onClose={() => setExpandedComment(null)} />

        <BeadExpandedViewModal
          open={isExpandedView}
          onOpenChange={setIsExpandedView}
          bead={bead}
          type={mutations.type}
          status={mutations.status}
          priority={mutations.priority}
          assignee={mutations.assignee}
          labels={mutations.labels}
          specId={mutations.specId}
          description={mutations.description}
          design={mutations.design}
          acceptanceCriteria={mutations.acceptanceCriteria}
          notes={mutations.notes}
          dueAt={mutations.dueAt}
          deferUntil={mutations.deferUntil}
          estimatedMinutes={mutations.estimatedMinutes}
          commentSort={commentSort}
          onSortChange={handleCommentSortChange}
          groupedComments={comments.groupedComments}
          onBeadNavigate={onBeadNavigate}
          onRemoveDependency={mutations.handleRemoveDependency}
        />

        <SpecViewerModal
          open={specViewerOpen}
          onOpenChange={setSpecViewerOpen}
          specId={mutations.specId}
          loading={specViewerLoading}
          error={specViewerError}
          content={specViewerContent}
        />
      </div>
    )
  },
)
