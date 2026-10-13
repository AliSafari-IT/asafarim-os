export const HARDENING: { readonly tmpfs: string; readonly capDrop: string; readonly securityOpt: string };

export function workerImage(
  webRef: string,
  manifest: { runtime: { image: string } },
  worker: { image: string },
): string;
