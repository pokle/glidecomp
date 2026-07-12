/** Where a branch preview's Pages Functions find their per-branch workers. */
export interface PreviewBackends {
  /** e.g. https://auth-api-pv-<slug>.<account>.workers.dev */
  authApiUrl: string;
  /** e.g. https://competition-api-pv-<slug>.<account>.workers.dev */
  compApiUrl: string;
}
