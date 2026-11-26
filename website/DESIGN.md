# Design: the Pathayam website

The locked system for every page in `website/`. Every page reads it and shares it. Change it on purpose; the file is the rule.

## System
- Genre: editorial
- Shape of the first page: Split Studio (text on one side, the app's own screens on the other; the proof keeps its side)
- Theme: brand (Pathayam's own palette and faces)
- Axes: light/grotesk-heavy/cool · posture: Restrained (the blue is a signal: the primary button, links, focus)
- Chrome: nav is a slab (one ink bar, gold chest mark); footer is a colophon block (the name in Malayalam and its meaning, the links, the build note, the legal line). Both are identical on every page.

## Tokens
`tokens.css` is the source of truth, with a dark block twice (system dark, and the toggle). The roles:
```css
:root {
  --color-paper: oklch(95.9% 0.010 87);  --color-paper-2: oklch(92.9% 0.016 86);  --color-paper-3: oklch(98.8% 0.007 89);
  --color-ink: oklch(21.9% 0.011 81);  --color-ink-2: oklch(44.8% 0.024 85);  --color-muted: oklch(50.3% 0.025 83);
  --color-rule: oklch(86.5% 0.020 85);  --color-rule-2: oklch(76.9% 0.027 85);
  --color-accent: oklch(46.9% 0.125 254);  --color-accent-ink: oklch(99% 0.004 254);  --color-focus: oklch(48% 0.19 254);
  --color-gold: oklch(53.9% 0.104 77);  --color-positive, --color-warn (+ -soft), --color-slab, --color-shot (screenshot ground)
  --font-display: "Bricolage Grotesque";  --font-body: "Figtree";  --font-outlier: "IBM Plex Mono" (money, figures, code only);  --font-mal (the name only)
  --radius-card: 12px;  --radius-input: 10px;  --rule-hair: 1px;  --shadow-card: none;
}
```
The spacing scale (`--space-*`), the type scale (`--text-*`), easings and durations are the scaffold's and live in `tokens.css`. Never a raw length where a `--space-*` exists, never a colour or font literal outside `tokens.css`.

## Shared parts (style.css)
`.wrap` (the one container, 1440 max, `--gutter`), `.sec`, `.sec--tight`, `.sec--band`, `.h-sec`, `.lede`, `.prose`, `.wrap--prose`, `.btn` `.btn--primary` `.btn--ghost` `.btn--sm` `.btn--nav`, `.actions`, `.frame` (a screenshot of the app: dark ground, 12px radius, inset hairline, `<figcaption>` below), `.checks`, `.pill` (`--r` `--w` `--ship` `--hold`), `.note` `.note--good` `.warn` (tinted wells, hairline all round, never a side stripe), tables in `.table-scroll`, `pre`/`code`, `.m` (money in tabular mono), `.waitlist` (the request form site.js posts), `.docs` + `.docs__rail` (two-column reference with a sticky rail), the footer.

## Page rules
- One page stylesheet per page (`home.css`, `features.css`, ...), read after `style.css`; page CSS never restyles the chrome.
- Labels, table heads, tags and nav links: body face, a step smaller, sentence case, untracked. No eyebrows above headings. No arrows glued to link text. No middle-dot strings.
- Section heads at `--text-section`, one weight; no single accented word in a heading.
- Grid tracks `minmax(0, 1fr)`; everything stacks under 60rem; nothing scrolls sideways at 320 to 1920 except a table that says so.
- Words, facts, prices and figures are the owner's; legal text is never reworded.

## Controls
- Primary: accent fill · 10px radius · 48px tall (44px small and in the nav)
- Secondary: 1px outline in `--color-rule-2` · same radius and height
- One filled primary per screen.

## Motion
- Character: calm. Colour and background transitions at `--dur-short`, a 1px press. No reveals. Under reduced motion everything ends at once.

## Exports
`tokens.css` in this folder.
