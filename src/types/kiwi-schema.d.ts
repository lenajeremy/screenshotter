declare module "kiwi-schema" {
  export function decodeBinarySchema(bytes: Uint8Array): unknown;
  export function compileSchema(schema: unknown): { decodeMessage(bytes: Uint8Array): any };
}
