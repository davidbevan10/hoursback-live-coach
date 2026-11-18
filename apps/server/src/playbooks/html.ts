import { convert } from 'html-to-text';

/**
 * Playbooks are free-form HTML. The model reads plain text fine, so we only strip markup,
 * keep headings as "## " lines (cues cite heading text as playbook_ref), and keep list bullets.
 */
export function playbookHtmlToText(html: string): string {
  const text = convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'style', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'h1', format: 'heading_md' as any },
      { selector: 'h2', format: 'heading_md' as any },
      { selector: 'h3', format: 'heading_md' as any },
      { selector: 'h4', format: 'heading_md' as any },
      { selector: 'table', format: 'dataTable', options: { uppercaseHeaderCells: false } },
    ],
    formatters: {
      heading_md(elem, walk, builder) {
        builder.openBlock({ leadingLineBreaks: 2 });
        builder.addInline('## ');
        walk(elem.children, builder);
        builder.closeBlock({ trailingLineBreaks: 1 });
      },
    },
  });
  return text
    .replace(/^(## .*?[a-z?.')])Must$/gm, '$1 (must ask)') // sector template glues its "Must" tag onto the heading
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Heading lines, used to check that a cue's playbook_ref points at something real. */
export function headingsOf(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('## '))
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}
