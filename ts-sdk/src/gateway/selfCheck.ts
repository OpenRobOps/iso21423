// Layering: gateway → core → session. The implementation lives in core/selfCheck.ts (shared with
// Iso21423Client's own security.selfCheck) — this re-export just keeps the gateway's public
// surface (and import path) unchanged.
export { publishSelfCheck } from '../core/selfCheck.js';
