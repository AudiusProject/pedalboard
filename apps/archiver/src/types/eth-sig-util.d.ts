// Minimal type shim for eth-sig-util@3.0.1, which ships without bundled types.
declare module 'eth-sig-util' {
  export function recoverPersonalSignature(params: {
    data: string
    sig: string
  }): string
}
