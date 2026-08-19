/** Public `lsc info --typed` schema 1. Crosscheck never imports LemmaScript internals. */

export type Ty =
  | { kind: "bool" }
  | { kind: "nat"; big?: boolean }
  | { kind: "int"; big?: boolean }
  | { kind: "real" }
  | { kind: "string"; values?: string[] }
  | { kind: "void" }
  | { kind: "array"; elem: Ty }
  | { kind: "tuple"; elems: Ty[] }
  | { kind: "map"; key: Ty; value: Ty }
  | { kind: "set"; elem: Ty }
  | { kind: "optional"; inner: Ty }
  | { kind: "user"; name: string }
  | { kind: "fn"; params: Ty[]; result: Ty }
  | { kind: "unknown" };

export interface TExpr {
  kind: string;
  ty?: Ty;
  [key: string]: unknown;
}

export interface FieldInfo {
  name: string;
  tsType: string;
  type?: Ty;
}

export interface TypeDeclInfo {
  name: string;
  typeParams?: string[];
  kind: "string-union" | "discriminated-union" | "record" | "alias" | "opaque";
  values?: string[];
  discriminant?: string;
  variants?: { name: string; fields: FieldInfo[] }[];
  fields?: FieldInfo[];
  aliasOf?: string;
  aliasOfTy?: Ty;
}

export interface TypedParam {
  name: string;
  ty: Ty;
  tsType?: string;
}

export interface TypedFunction {
  name: string;
  exported: boolean;
  typeParams: string[];
  params: TypedParam[];
  returnTy: Ty;
  requires: TExpr[];
  ensures: TExpr[];
  decreases: TExpr | null;
  contract: string[];
  isPure: boolean;
  forcePure: boolean;
  autohavoc: boolean;
  bodyKinds: string[];
}

export interface TypedConst {
  name: string;
  ty: Ty;
  value: TExpr;
}

export interface TypedInfo {
  schema: number;
  lemmascript: string;
  file: string;
  backendDirective: string | null;
  typeDecls: TypeDeclInfo[];
  externs: unknown[];
  constants: TypedConst[];
  functions: TypedFunction[];
  classes: { name: string; fields: { name: string; ty: Ty }[]; methods: TypedFunction[] }[];
  dafny: { emittedNames?: Record<string, string>; error?: string };
}
