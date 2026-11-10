// amazon-cognito-identity-js (via its crypto dependencies) expects Node's
// `global` to exist; the browser has no such global, so shim it before
// anything else loads.
(globalThis as unknown as { global: typeof globalThis }).global = globalThis;
