// Client-rendered SPA shell: Keycloak (keycloak-js) and the auth store are
// browser-only, so disable SSR for the whole app. Matches the demo's SPA model.
export const ssr = false;
export const prerender = false;
