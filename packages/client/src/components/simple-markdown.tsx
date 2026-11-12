"use client"

import { memo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

interface SimpleMarkdownProps {
  content: string
  className?: string
}

// Preprocess content to convert ALL CAPS lines ending with : to markdown headers
function preprocessContent(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim()
      // Match ALL CAPS lines ending with colon (e.g., "DELIVERABLE:", "OUTPUT FORMAT:")
      if (/^[A-Z][A-Z\s]+:$/.test(trimmed)) {
        return `#### ${trimmed}`
      }
      return line
    })
    .join("\n")
}

const markdownPlugins = [remarkGfm]
const markdownComponents: Components = {
  h1: ({ children }) => (
    <h1 className="text-lg font-semibold text-foreground/70 mt-4 mb-2">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-base font-semibold text-foreground/70 mt-4 mb-2">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-sm font-semibold text-foreground/70 mt-3 mb-2">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-sm font-semibold text-foreground/70 mt-2 mb-0.5">{children}</h4>
  ),
  p: ({ children }) => <p className="text-sm text-muted-foreground my-1">{children}</p>,
  ul: ({ className, children }) => (
    <ul
      className={`space-y-0.5 my-1 text-muted-foreground ${className?.includes("contains-task-list") ? "list-none" : "list-disc list-inside"}`}
    >
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal list-inside space-y-0.5 my-1 text-muted-foreground">{children}</ol>
  ),
  li: ({ className, children }) => (
    <li
      className={`text-sm ${className?.includes("task-list-item") ? "flex items-start gap-2" : ""}`}
    >
      {children}
    </li>
  ),
  input: ({ checked, type }) =>
    type === "checkbox" ? (
      <input type="checkbox" checked={checked} readOnly className="mt-0.5 accent-primary" />
    ) : null,
  strong: ({ children }) => (
    <strong className="font-semibold text-foreground/70">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ children }) => (
    <code className="px-1.5 py-0.5 rounded bg-slate-700 text-emerald-400 text-xs font-mono">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="p-3 rounded bg-slate-800 overflow-x-auto my-2 text-sm">{children}</pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-slate-500 pl-3 my-2 text-muted-foreground italic">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-primary hover:underline"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-4 border-border" />,
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="min-w-full text-sm border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-border">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className="border-b border-border/50">{children}</tr>,
  th: ({ children }) => (
    <th className="px-2 py-1.5 text-left font-medium text-foreground/70">{children}</th>
  ),
  td: ({ children }) => <td className="px-2 py-1.5 text-muted-foreground">{children}</td>,
}

export const SimpleMarkdown = memo(function SimpleMarkdown({
  content,
  className = "",
}: SimpleMarkdownProps) {
  const processedContent = preprocessContent(content)

  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={markdownPlugins} components={markdownComponents}>
        {processedContent}
      </ReactMarkdown>
    </div>
  )
})
