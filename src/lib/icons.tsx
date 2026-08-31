import type { JSX } from "solid-js";

// ── inline SVG icons (serialized from lucide IconNodes — zero runtime scans) ──

/** Lucide's icon node shape: [tag, attrs] pairs. Exported (audit T2) so
 *  callers can't pass arbitrary data where a dev-defined icon is expected. */
export type IconNode = Array<[string, Record<string, string | number | undefined>]>;

/** Escape a value for use inside a double-quoted HTML/SVG attribute
 *  (audit Q10). The nodes are dev-defined today, but `iconBody` composes
 *  markup via innerHTML — escaping here makes user-defined icons safe
 *  instead of relying on every future caller. */
function esc(v: string | number | undefined): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function iconBody(node: IconNode): string {
  return node
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .map(([k, v]) => `${k}="${esc(v)}"`)
        .join(" ");
      return `<${tag} ${a}></${tag}>`;
    })
    .join("");
}

export function iconSvgString(
  node: IconNode,
  size: number,
  cls = "",
  fill = "none"
): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"` +
    ` viewBox="0 0 24 24" fill="${esc(fill)}" stroke="currentColor" stroke-width="2"` +
    ` stroke-linecap="round" stroke-linejoin="round"${cls ? ` class="${esc(cls)}"` : ""}>` +
    `${iconBody(node)}</svg>`
  );
}

/** Renders a lucide icon as a real inline <svg> element (reactive size/class/fill). */
export function Ico(props: {
  node: IconNode;
  size?: number;
  cls?: string;
  fill?: string;
  hidden?: boolean;
}): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill={props.fill ?? "none"}
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.cls}
      classList={{ hidden: !!props.hidden }}
      innerHTML={iconBody(props.node)}
    />
  );
}
