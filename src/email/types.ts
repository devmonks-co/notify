import type { ReactElement } from 'react';

/** A React Email template: props in, element out. The adapter also passes `brand` (see EmailBrand). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EmailTemplate<P = any> = (props: P) => ReactElement;

/** Brand slot for emails (BaseLayout, simpleEmail). */
export interface EmailBrand {
  name: string;
  /** CSS colour for buttons and accents. */
  accent?: string;
  /** Absolute URL of a logo image; the name is shown as text without it. */
  logoUrl?: string;
  /** Footer line, e.g. a tagline or address. */
  footer?: string;
  supportEmail?: string;
  /** Logo size in CSS px (keep the image's aspect ratio; serve it at 2-3x). */
  logoWidth?: number;
  logoHeight?: number;
  /** Colours; anything unset falls back to the neutral default. */
  palette?: Partial<EmailPalette>;
  /** Heading font stack (body text always uses the system stack). */
  headingFont?: string;
  /** Web font stylesheet for clients that load one (Apple Mail, iOS); others use the stack's fallbacks. */
  fontCssUrl?: string;
  /** Small links under the card, e.g. website, privacy. */
  links?: { label: string; url: string }[];
  /** Line under the content, e.g. "See you at 8 pm". */
  signoff?: string;
}

export interface EmailPalette {
  /** Outside the card. */
  background: string;
  /** The card. */
  surface: string;
  /** Card border. */
  line: string;
  /** Short rule under the heading; transparent = none. */
  rule: string;
  heading: string;
  text: string;
  muted: string;
  /** Code box fill and border. */
  codeFill: string;
  codeBorder: string;
}
