// P3.4 port of components/molecule-dag.tsx.
// Source-divergence:
//   - next/dynamic { ssr: false } → direct import. Vite SPA has no SSR
//     boundary; the original dynamic() existed only to avoid Next's
//     server-render of three.js. Bundle-splitting still happens
//     automatically via the route's lazy chunk.
//   - actions/molecules.loadMoleculeGraph → rpc.molecules.loadMoleculeGraph

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ForceGraphMethods } from "react-force-graph-3d"
import ForceGraph3D from "react-force-graph-3d"
import * as THREE from "three"
import { rpc } from "../lib/rpc"
import type { MoleculeGraph, MoleculeNode } from "../lib/types"
import { Spinner } from "./ui/spinner"

const statusColors: Record<string, number> = {
  open: 0xffffff,
  in_progress: 0x3b82f6,
  closed: 0x22c55e,
  blocked: 0x6b7280,
  ready_for_qa: 0xa855f7,
  ready_to_ship: 0x10b981,
}

const gateColors = {
  pending: 0xf59e0b,
  resolved: 0x22c55e,
}

function getNodeColor(node: MoleculeNode): number {
  if (node.type === "gate") {
    return node.status === "closed" ? gateColors.resolved : gateColors.pending
  }
  return statusColors[node.status] ?? statusColors.open
}

function getNodeSize(node: MoleculeNode, rootId: string): number {
  if (node.id === rootId) return 8
  if (node.type === "gate") return 6
  return 5
}

function getNodeLabel(node: MoleculeNode): string {
  const statusLabel = node.status.replace(/_/g, " ")
  return `<div style="background:rgba(0,0,0,0.85);color:#fff;padding:6px 10px;border-radius:6px;font-size:12px;max-width:250px">
    <div style="font-weight:600;margin-bottom:2px">${node.title}</div>
    <div style="opacity:0.7">${node.id} &middot; ${statusLabel}</div>
  </div>`
}

interface MoleculeDagProps {
  beadId: string
  dbPath?: string
  onBeadNavigate?: (beadId: string) => void
}

export function MoleculeDag({ beadId, dbPath, onBeadNavigate }: MoleculeDagProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<ForceGraphMethods | undefined>(undefined)
  const [graph, setGraph] = useState<MoleculeGraph | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dimensions, setDimensions] = useState({ width: 400, height: 400 })

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    rpc.molecules
      .loadMoleculeGraph(beadId, dbPath)
      .then((result) => {
        if (cancelled) return
        if (result.success) {
          setGraph(result.graph)
        } else {
          setError(result.error)
        }
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [beadId, dbPath])

  useEffect(() => {
    if (!graph || !containerRef.current) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        setDimensions({ width: Math.floor(width), height: Math.floor(height) })
      }
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [graph])

  useEffect(() => {
    if (graph && graphRef.current) {
      setTimeout(() => graphRef.current?.zoomToFit(400, 60), 500)
    }
  }, [graph])

  const handleNodeClick = useCallback(
    (node: { id?: string | number }) => {
      if (node.id && onBeadNavigate) {
        onBeadNavigate(String(node.id))
      }
    },
    [onBeadNavigate],
  )

  const graphData = useMemo(() => {
    if (!graph) return { nodes: [], links: [] }
    return {
      nodes: graph.nodes.map((n) => ({
        id: n.id,
        title: n.title,
        status: n.status,
        type: n.type,
        gateType: n.gateType,
        color: getNodeColor(n),
        val: getNodeSize(n, graph.rootId),
      })),
      links: graph.edges.map((e) => ({
        source: e.source,
        target: e.target,
      })),
    }
  }, [graph])

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Spinner className="size-6" />
        <span className="ml-2 text-sm text-muted-foreground">Loading molecule graph...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    )
  }

  if (!graph || graph.nodes.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-muted-foreground">No molecule data available</p>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="absolute inset-0">
      <ForceGraph3D
        ref={graphRef}
        graphData={graphData}
        width={dimensions.width}
        height={dimensions.height}
        backgroundColor="rgba(0,0,0,0)"
        dagMode="td"
        dagLevelDistance={40}
        nodeLabel={(node: Record<string, unknown>) => {
          const n = graph.nodes.find((gn) => gn.id === node.id)
          return n ? getNodeLabel(n) : ""
        }}
        nodeColor={(node: Record<string, unknown>) =>
          `#${((node.color as number) ?? 0xffffff).toString(16).padStart(6, "0")}`
        }
        nodeVal={(node: Record<string, unknown>) => (node.val as number) ?? 5}
        nodeThreeObject={(node: Record<string, unknown>) => {
          const nodeType = node.type as string
          if (nodeType === "gate") {
            const geometry = new THREE.OctahedronGeometry(4)
            const color = (node.color as number) ?? 0xf59e0b
            const material = new THREE.MeshLambertMaterial({
              color,
              transparent: true,
              opacity: 0.9,
            })
            return new THREE.Mesh(geometry, material) as unknown as THREE.Object3D
          }
          return false as unknown as THREE.Object3D
        }}
        nodeThreeObjectExtend={(node: Record<string, unknown>) => (node.type as string) !== "gate"}
        linkDirectionalArrowLength={4}
        linkDirectionalArrowRelPos={0.9}
        linkColor={() => "#4b5563"}
        linkCurvature={0.1}
        linkOpacity={0.6}
        onNodeClick={handleNodeClick}
        enableNodeDrag={false}
      />
    </div>
  )
}
