import { Body, Container, Head, Html, Img, Link, Preview, Section, Text } from '@react-email/components';
import type { CSSProperties, ReactNode } from 'react';

import type { EmailBrand, EmailPalette } from './types.js';

export const DEFAULT_BRAND: EmailBrand = { name: 'Notifications', accent: '#221A2B' };

export const DEFAULT_PALETTE: EmailPalette = {
  background: '#f6f4f9',
  surface: '#ffffff',
  line: '#ece6f2',
  rule: 'transparent',
  heading: '#221a2b',
  text: '#4a4152',
  muted: '#6f6578',
  codeFill: '#f6f4f9',
  codeBorder: '#ece6f2',
};

export const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export const paletteOf = (brand: EmailBrand): EmailPalette => ({ ...DEFAULT_PALETTE, ...brand.palette });

export interface BaseLayoutProps {
  brand?: EmailBrand;
  /** Inbox preview line (shown next to the subject, hidden in the body). */
  preview?: string;
  children: ReactNode;
}

/** The one layout every email uses: logo or name, a card with the content, a footer. */
export function BaseLayout({ brand = DEFAULT_BRAND, preview, children }: BaseLayoutProps) {
  const c = paletteOf(brand);
  const accent = brand.accent ?? DEFAULT_BRAND.accent!;
  const body: CSSProperties = { backgroundColor: c.background, margin: 0, padding: '40px 16px', fontFamily: FONT };
  const card: CSSProperties = {
    backgroundColor: c.surface,
    border: `1px solid ${c.line}`,
    borderRadius: '18px',
    padding: '36px 32px 28px',
    color: c.heading,
  };
  const footer: CSSProperties = { color: c.muted, fontSize: '12px', lineHeight: '18px', margin: '4px 0 0', textAlign: 'center' };
  const signoff: CSSProperties = {
    fontFamily: brand.headingFont ?? FONT,
    fontStyle: 'italic',
    fontSize: '18px',
    lineHeight: '24px',
    color: accent,
    margin: '24px 0 0',
  };
  return (
    <Html lang="en">
      <Head>
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
        {brand.fontCssUrl ? <link rel="stylesheet" href={brand.fontCssUrl} /> : null}
      </Head>
      {preview ? <Preview>{preview}</Preview> : null}
      <Body style={body}>
        <Container style={{ maxWidth: '560px', margin: '0 auto' }}>
          <Section style={{ textAlign: 'center', margin: '0 0 24px' }}>
            {brand.logoUrl ? (
              <Img
                src={brand.logoUrl}
                alt={brand.name}
                width={brand.logoWidth}
                height={brand.logoHeight ?? 32}
                style={{ display: 'inline-block', border: 0, outline: 'none' }}
              />
            ) : (
              <Text style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: accent }}>{brand.name}</Text>
            )}
          </Section>
          <Section style={card}>
            {children}
            {brand.signoff ? <Text style={signoff}>{brand.signoff}</Text> : null}
          </Section>
          <Section style={{ padding: '24px 0 0' }}>
            {brand.footer ? <Text style={{ ...footer, color: c.text, fontSize: '13px' }}>{brand.footer}</Text> : null}
            {brand.links?.length ? (
              <Text style={footer}>
                {brand.links.map((l, i) => (
                  <span key={l.url}>
                    {i > 0 ? '  ·  ' : ''}
                    <Link href={l.url} style={{ color: c.muted, textDecoration: 'underline' }}>{l.label}</Link>
                  </span>
                ))}
              </Text>
            ) : null}
            {brand.supportEmail ? (
              <Text style={footer}>
                Need help? <Link href={`mailto:${brand.supportEmail}`} style={{ color: accent }}>{brand.supportEmail}</Link>
              </Text>
            ) : null}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
