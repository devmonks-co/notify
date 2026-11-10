import { Button, Heading, Hr, Section, Text } from '@react-email/components';
import type { CSSProperties } from 'react';

import type { EmailBrand } from './types.js';
import { BaseLayout, DEFAULT_BRAND, FONT, paletteOf } from './layout.js';

export interface SimpleEmailProps {
  heading: string;
  /** Plain text. Blank lines start a new paragraph. */
  body: string;
  /** A short code shown large (sign-in codes). */
  code?: string;
  button?: { label: string; url: string };
  /** Inbox preview line. Defaults to the first line of the body. */
  preview?: string;
  brand?: EmailBrand;
}

/** Heading, paragraphs, optional code box, optional button: covers text-and-button emails without a custom template. */
export function simpleEmail({ heading, body, code, button, preview, brand = DEFAULT_BRAND }: SimpleEmailProps) {
  const accent = brand.accent ?? DEFAULT_BRAND.accent!;
  const c = paletteOf(brand);
  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const h: CSSProperties = {
    fontFamily: brand.headingFont ?? FONT,
    fontSize: brand.headingFont ? '32px' : '22px',
    fontWeight: brand.headingFont ? 400 : 700,
    lineHeight: brand.headingFont ? '38px' : '28px',
    margin: '0 0 16px',
    color: c.heading,
  };
  const p: CSSProperties = { fontSize: '16px', lineHeight: '26px', margin: '0 0 16px', color: c.text };
  const codeBox: CSSProperties = {
    fontFamily: '"SF Mono", Menlo, Consolas, "Courier New", monospace',
    fontSize: '34px',
    letterSpacing: '0.35em',
    fontWeight: 700,
    textAlign: 'center',
    color: c.heading,
    backgroundColor: c.codeFill,
    border: `1px dashed ${c.codeBorder}`,
    borderRadius: '14px',
    padding: '18px 16px 18px calc(16px + 0.35em)',
    margin: '8px 0 20px',
  };
  const btn: CSSProperties = {
    backgroundColor: accent,
    color: '#ffffff',
    borderRadius: '999px',
    padding: '14px 28px',
    fontSize: '15px',
    fontWeight: 600,
    textDecoration: 'none',
    display: 'inline-block',
  };
  return (
    <BaseLayout brand={brand} preview={preview ?? paragraphs[0] ?? heading}>
      <Heading as="h1" style={h}>{heading}</Heading>
      {c.rule !== 'transparent' ? <Hr style={{ border: 'none', borderTop: `3px solid ${c.rule}`, width: '44px', margin: '-4px 0 20px 0' }} /> : null}
      {paragraphs.map((text, i) => (
        <Text key={i} style={p}>{text}</Text>
      ))}
      {code ? <Text style={codeBox}>{code}</Text> : null}
      {button ? (
        <Section style={{ margin: '8px 0 0' }}>
          <Button href={button.url} style={btn}>{button.label}</Button>
        </Section>
      ) : null}
    </BaseLayout>
  );
}
