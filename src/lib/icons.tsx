import type { JSX } from "solid-js";

// ── inline SVG icons (serialized from lucide IconNodes — zero runtime scans) ──
type IconNode = Array<[string, Record<string, string | number | undefined>]>;

export function iconBody(node: unknown): string {
  const parts = node as IconNode;
  return parts
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ");
      return `<${tag} ${a}></${tag}>`;
    })
    .join("");
}

export function iconSvgString(
  node: unknown,
  size: number,
  cls = "",
  fill = "none"
): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"` +
    ` viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2"` +
    ` stroke-linecap="round" stroke-linejoin="round"${cls ? ` class="${cls}"` : ""}>` +
    `${iconBody(node)}</svg>`
  );
}

/** Renders a lucide icon as a real inline <svg> element (reactive size/class/fill). */
export function Ico(props: {
  node: unknown;
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
