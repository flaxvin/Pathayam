/**
 * The mark.
 *
 * Three things had to be true at once, and the first two attempts each got one
 * of them and lost another. A pale envelope on a coloured tile is a mail app,
 * whoever draws it. A treasure chest is a game. And a roof, an envelope and a
 * banknote drawn as three separate objects is three objects piled on top of one
 * another, which at 32px is a smudge with corners.
 *
 * So: one object. A gabled roof standing on a box, with a rupee inside it. The
 * roof is the household; the box under an open flap is the envelope; the rupee
 * says what is in it. Nothing overlaps anything, which is why it survives being
 * sixteen pixels wide.
 *
 * Two treatments, because a tile and a logo are different jobs:
 *
 * - **The icon** brings its own ground, because a home screen is not ours to
 *   colour: terracotta, a solid gold roof, a dark green body.
 * - **The logo** takes the page's colour instead — one stroke weight, no fill,
 *   currentColor — because a rounded terracotta tile dropped into a header reads
 *   as somebody pasted an app icon into the page. It is the same drawing with
 *   the ground taken away, and it follows the theme because the page's own
 *   colour is what it is drawn in.
 *
 * Drawn in shapes rather than type: a rupee from a font depends on that font
 * being installed, and this has to raster identically in a browser, in
 * ImageMagick, and in whatever an operating system uses to draw a home-screen
 * tile.
 */

const TERRACOTTA = "#b0522c";
const GOLD = "#edc067";
const DEEP_GREEN = "#1c5748";

/**
 * The rupee, as four strokes: the two bars, the bowl that hangs from the lower
 * one, and the leg.
 */
function rupee(colour: string, weight: number): string {
  return `
  <g fill="none" stroke="${colour}" stroke-width="${weight}"
     stroke-linecap="round" stroke-linejoin="round">
    <path d="M25 33 H39"/>
    <path d="M25 38 H39"/>
    <path d="M25 43.4 H32.6 C 37.4 43.4, 37.4 38, 32.6 38"/>
    <path d="M29.8 43.4 L37.6 51.4"/>
  </g>`;
}

/** The tile's drawing: solid roof, green body, gold rupee. */
const TILE = `
  <path d="M9 26 L32 8 L55 26 z" fill="${GOLD}"/>
  <rect x="10" y="26" width="44" height="30" rx="3"
        fill="${DEEP_GREEN}" stroke="${GOLD}" stroke-width="3.4"/>
  ${rupee(GOLD, 3.2)}`;

export const APP_ICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"
     role="img" aria-label="Pathayam">
  <rect width="64" height="64" rx="14" fill="${TERRACOTTA}"/>
  ${TILE}
</svg>`;

/**
 * The maskable variant: the same mark at two thirds, on a ground that fills the
 * whole tile, so a circular or squircle crop lands on colour rather than on a
 * corner of the roof (F21.1).
 */
export const APP_ICON_MASKABLE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"
     role="img" aria-label="Pathayam">
  <rect width="64" height="64" fill="${TERRACOTTA}"/>
  <g transform="translate(10.88 10.88) scale(0.66)">${TILE}</g>
</svg>`;

/**
 * The 16px variant.
 *
 * A browser tab is sixteen pixels across. At that size a 3.4-wide outline around
 * a 30-tall box is most of the box, and the rupee's bowl is a single dark pixel
 * inside a bright one. So the outline goes, and the bowl with it: a solid roof,
 * a solid body, two bars and a leg. That is still a rupee at a glance and it is
 * still this app's roof; the full drawing takes over the moment there is room
 * for it.
 */
export const APP_ICON_SMALL_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"
     role="img" aria-label="Pathayam">
  <rect width="64" height="64" rx="12" fill="${TERRACOTTA}"/>
  <path d="M7 25 L32 6 L57 25 z" fill="${GOLD}"/>
  <rect x="9" y="25" width="46" height="32" rx="3" fill="${DEEP_GREEN}"/>
  <g fill="none" stroke="${GOLD}" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M23 33 H41"/>
    <path d="M23 39.5 H41"/>
    <path d="M27.5 39.5 L38 51"/>
  </g>
</svg>`;

/**
 * The logo's paths: no ground, no colour, for inlining into a page. Shared
 * verbatim with the website's masthead so the two cannot drift apart.
 */
export const APP_LOGO_PATHS = `
  <path d="M10 26 L32 9 L54 26"/>
  <rect x="10.5" y="26" width="43" height="29" rx="3"/>
  <path d="M25 33 H39"/>
  <path d="M25 38 H39"/>
  <path d="M25 43.4 H32.6 C 37.4 43.4, 37.4 38, 32.6 38"/>
  <path d="M29.8 43.4 L37.6 51.4"/>`;

export const APP_LOGO_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="7 7 50 51" fill="none"
     stroke="currentColor" stroke-width="3.6" stroke-linejoin="round" stroke-linecap="round"
     aria-hidden="true">${APP_LOGO_PATHS}</svg>`;

/** The colour a browser paints the address bar and the splash screen with. */
export const ICON_GROUND = TERRACOTTA;

/** The warm page behind a splash screen, matching the light theme's ground. */
export const ICON_BACKGROUND = "#f4f1ea";
