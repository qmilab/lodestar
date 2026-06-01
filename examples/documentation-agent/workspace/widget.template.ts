// Pristine fixture for the documentation-agent demo.
//
// `index.ts` copies this to `widget.ts` (a gitignored working copy) at the
// start of each run, so the demo is repeatable and never dirties a tracked
// file. The docstring on `renderWidget` below is deliberately STALE — it
// documents a `name` parameter the function no longer takes. The agent
// reads the real signature, notices the mismatch, and rewrites the
// docstring through a governed `doc.write` action.

export interface WidgetProps {
  title: string
  badge?: number
}

export interface RenderOptions {
  compact?: boolean
}

/**
 * Render a widget.
 *
 * @param name - the widget's display name
 * @returns the rendered widget as an HTML string
 */
export function renderWidget(props: WidgetProps, options?: RenderOptions): string {
  const badge = props.badge !== undefined ? ` (${props.badge})` : ""
  const variant = options?.compact ? "compact" : "full"
  return `<div class="widget ${variant}">${props.title}${badge}</div>`
}
