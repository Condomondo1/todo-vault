/**
 * Markdown to Atlassian Document Format, the rich-text shape Jira Cloud's v3
 * API takes for descriptions and paragraph custom fields.
 *
 * Its own module, free of Node imports, so `jira-meta.ts` can shape a
 * paragraph field's plain text into ADF and the renderer can still import
 * `jira-meta`.
 */
import { parseDescription, serializeDescription, type Block, type Inline } from "./description.js";

export type AdfNode = { type: string; [key: string]: unknown };

function adfInline(nodes: Inline[]): AdfNode[] {
  return nodes.map((node) => {
    switch (node.kind) {
      case "link":
        return {
          type: "text",
          text: node.text,
          marks: [{ type: "link", attrs: { href: node.href } }],
        };
      case "code":
        return { type: "text", text: node.text, marks: [{ type: "code" }] };
      case "strong":
        return { type: "text", text: node.text, marks: [{ type: "strong" }] };
      case "em":
        return { type: "text", text: node.text, marks: [{ type: "em" }] };
      case "break":
        return { type: "hardBreak" };
      default:
        return { type: "text", text: node.text };
    }
  });
}

/**
 * Jira Cloud's v3 API takes Atlassian Document Format, not markdown.
 *
 * The grammar lives in description.ts, shared with the desktop app so the two
 * cannot disagree about what a description means; this is only the mapping onto
 * ADF's node names. Anything the grammar does not recognise arrives here as a
 * plain paragraph rather than failing the push.
 */
export function markdownToAdf(markdown: string): AdfNode {
  const content: AdfNode[] = parseDescription(markdown).map((block) => {
    switch (block.kind) {
      case "heading":
        return {
          type: "heading",
          attrs: { level: block.level },
          content: adfInline(block.content),
        };
      case "list":
        return {
          type: block.ordered ? "orderedList" : "bulletList",
          content: block.items.map((item) => ({
            type: "listItem",
            content: [{ type: "paragraph", content: adfInline(item) }],
          })),
        };
      case "quote":
        return {
          type: "blockquote",
          content: [{ type: "paragraph", content: adfInline(block.content) }],
        };
      case "code":
        return {
          type: "codeBlock",
          ...(block.language ? { attrs: { language: block.language } } : {}),
          // An ADF text node may not be empty, so an empty fence gets a space.
          content: [{ type: "text", text: block.text || " " }],
        };
      default:
        return { type: "paragraph", content: adfInline(block.content) };
    }
  });

  if (!content.length) {
    content.push({ type: "paragraph", content: [] });
  }
  return { type: "doc", version: 1, content };
}

// ------------------------------------------------------- ADF to markdown

/**
 * An ADF document back to the vault's markdown, the inverse of `markdownToAdf`.
 *
 * For showing a paragraph field's stored value as text a person can edit, and
 * for the push pane's preview. Whatever `markdownToAdf` writes comes back
 * exactly, so editing an existing value does not flatten its formatting. ADF a
 * person wrote in Jira can hold more than the vault's grammar (tables, panels,
 * mentions, two marks on one run). That arrives as its words, in a paragraph,
 * rather than being dropped.
 */
export function adfToMarkdown(doc: unknown): string {
  if (!isNode(doc)) return "";
  const blocks: Block[] = children(doc).map(adfBlock);
  return serializeDescription(blocks.filter((b) => b.kind === "code" || !isEmptyInline(b)));
}

/** Whether a value is an ADF document, as Jira's rich-text fields return and accept. */
export function isAdfDoc(value: unknown): value is AdfNode {
  return isNode(value) && value.type === "doc";
}

function isNode(value: unknown): value is AdfNode {
  return !!value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}

function children(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? node.content.filter(isNode) : [];
}

function isEmptyInline(block: Block): boolean {
  if (block.kind === "list") return block.items.length === 0;
  if (block.kind === "code") return false;
  return block.content.length === 0;
}

function adfBlock(node: AdfNode): Block {
  const attrs = (node.attrs ?? {}) as Record<string, unknown>;
  switch (node.type) {
    case "heading":
      return { kind: "heading", level: typeof attrs.level === "number" ? attrs.level : 1, content: inlineOf(node) };
    case "bulletList":
    case "orderedList":
      return {
        kind: "list",
        ordered: node.type === "orderedList",
        items: children(node).map((item) => joinWithBreaks(children(item).map(inlineOf))),
      };
    case "blockquote":
      return { kind: "quote", content: joinWithBreaks(children(node).map(inlineOf)) };
    case "codeBlock": {
      const text = children(node)
        .map((n) => (typeof n.text === "string" ? n.text : ""))
        .join("");
      return {
        kind: "code",
        ...(typeof attrs.language === "string" ? { language: attrs.language } : {}),
        text: text === " " ? "" : text,
      };
    }
    case "paragraph":
      return { kind: "paragraph", content: inlineOf(node) };
    default: {
      const text = plainText(node);
      return { kind: "paragraph", content: text ? [{ kind: "text", text }] : [] };
    }
  }
}

function joinWithBreaks(runs: Inline[][]): Inline[] {
  return runs.filter((r) => r.length).flatMap((r, i) => (i === 0 ? r : [{ kind: "break" } as Inline, ...r]));
}

/** A block's inline runs. Nested blocks a paragraph should not hold are read as their words. */
function inlineOf(node: AdfNode): Inline[] {
  return children(node).flatMap((child): Inline[] => {
    if (child.type === "hardBreak") return [{ kind: "break" }];
    if (child.type !== "text") {
      const text = plainText(child);
      return text ? [{ kind: "text", text }] : [];
    }
    const text = typeof child.text === "string" ? child.text : "";
    if (!text) return [];
    const marks = Array.isArray(child.marks) ? child.marks.filter(isNode) : [];
    const link = marks.find((m) => m.type === "link");
    const href = link && (link.attrs as { href?: unknown } | undefined)?.href;
    if (typeof href === "string") return [{ kind: "link", text, href }];
    if (marks.some((m) => m.type === "code")) return [{ kind: "code", text }];
    if (marks.some((m) => m.type === "strong")) return [{ kind: "strong", text }];
    if (marks.some((m) => m.type === "em")) return [{ kind: "em", text }];
    return [{ kind: "text", text }];
  });
}

/** Every word in a node, for the shapes the vault's grammar has no spelling for. */
function plainText(node: AdfNode): string {
  if (typeof node.text === "string") return node.text;
  const attrs = (node.attrs ?? {}) as Record<string, unknown>;
  // mention, emoji, status and inlineCard carry their words in attrs.
  for (const key of ["text", "shortName", "url"]) {
    if (typeof attrs[key] === "string") return attrs[key] as string;
  }
  return children(node).map(plainText).filter(Boolean).join(" ");
}
