import type { MoleculeNode } from "./types"

// The molecule graph's nodeLabel is rendered by float-tooltip, which assigns a
// string label with innerHTML. Every bead-supplied field interpolated into the
// label must therefore be escaped, or a title containing markup would become
// live markup in the app window.
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function getNodeLabel(node: Pick<MoleculeNode, "id" | "title" | "status">): string {
  const statusLabel = node.status.replace(/_/g, " ")
  return `<div style="background:rgba(0,0,0,0.85);color:#fff;padding:6px 10px;border-radius:6px;font-size:12px;max-width:250px">
    <div style="font-weight:600;margin-bottom:2px">${escapeHtml(node.title)}</div>
    <div style="opacity:0.7">${escapeHtml(node.id)} &middot; ${escapeHtml(statusLabel)}</div>
  </div>`
}
