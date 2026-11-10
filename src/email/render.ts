import { render } from '@react-email/render';
import type { ReactElement } from 'react';

import type { Content } from '../types.js';
import { DEFAULT_BRAND } from './layout.js';
import { simpleEmail } from './simple.js';
import type { EmailBrand, EmailTemplate } from './types.js';

/** Headings keep their case in the plain-text version (the library upper-cases them by default). */
const HEADING_SELECTORS = ['h1', 'h2', 'h3'].map((selector) => ({ selector, options: { uppercase: false } }));

/** HTML and plain-text bodies of one email, rendered from the same React element. */
export async function renderEmail(element: ReactElement): Promise<{ html: string; text: string }> {
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true, htmlToTextOptions: { selectors: HEADING_SELECTORS } }),
  ]);
  return { html, text };
}

const isAbsolute = (url: string) => /^https?:\/\//.test(url);

/**
 * Subject + html + text for a Content. No custom template: simpleEmail from title, body and url.
 * [linkBase] prefixes a relative `content.url`; a url that is still relative gets no button.
 */
export async function renderContentEmail(
  content: Content,
  brand: EmailBrand = DEFAULT_BRAND,
  linkBase?: string,
): Promise<{ subject: string; html: string; text: string }> {
  const subject = content.email?.subject ?? content.title;
  const template = content.email?.template as EmailTemplate | undefined;
  let element: ReactElement;
  if (template) {
    element = template({ brand, ...(content.email?.props as object | undefined) });
  } else {
    let url = content.url;
    if (url && linkBase && !isAbsolute(url)) url = `${linkBase.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
    element = simpleEmail({
      brand,
      heading: content.title,
      body: content.body,
      ...(url && isAbsolute(url) ? { button: { label: `Open ${brand.name}`, url } } : {}),
    });
  }
  return { subject, ...(await renderEmail(element)) };
}
