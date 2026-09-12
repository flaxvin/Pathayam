/**
 * The app icon, inline so there is no binary asset in the repository and no
 * external request (R35.4). Drawn as three envelopes, which is what the
 * product actually is.
 */

export const APP_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Pathayam">
  <rect width="64" height="64" rx="14" fill="#1f5fa9"/>
  <g fill="none" stroke="#ffffff" stroke-width="3" stroke-linejoin="round">
    <rect x="12" y="18" width="40" height="12" rx="2"/>
    <path d="M12 18l20 9 20-9"/>
    <rect x="12" y="34" width="40" height="12" rx="2" opacity=".75"/>
    <path d="M12 34l20 9 20-9" opacity=".75"/>
  </g>
</svg>`;
