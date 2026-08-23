import { createHash } from "node:crypto";
import ts from "typescript";

export type SymbolDeclarationKind =
  | "interface"
  | "type_alias"
  | "function"
  | "variable"
  | "class"
  | "class_static_property";

export interface SymbolRecord {
  qualifiedName: string;
  declarationKind: SymbolDeclarationKind;
  projectRelativePath: string;
  declarationStart: number;
  declarationEnd: number;
  fingerprint: string;
}

export interface Anchor {
  qualifiedName: string;
  declarationKind: SymbolDeclarationKind;
  projectRelativePath: string;
  fingerprint: string;
}

export interface ClaudeMemProvenance {
  externalObservationId: string;
  capturedAt: string;
  project?: string;
  memorySessionId?: string;
  contentSessionId?: string;
}

export interface MemoryObservation {
  id: string;
  content: string;
  capturedAt: string;
  boundAt: string;
  source: "claude-mem";
  provenance: ClaudeMemProvenance;
  anchor: Anchor;
}

export interface BindMemoryObservationInput {
  atomicClaim: string;
  provenance: ClaudeMemProvenance;
  projectRelativePath: string;
  qualifiedName: string;
}

export type BindingResult =
  | { status: "bound"; observation: MemoryObservation; symbol: SymbolRecord }
  | {
      status: "unbound";
      reason:
        | "invalid_claim"
        | "invalid_provenance"
        | "source_unreadable"
        | "source_unparseable"
        | "symbol_unresolved_or_ambiguous";
    };

export type VerificationResult =
  | { status: "verified"; symbol: SymbolRecord }
  | {
      status: "needs_revalidation";
      reason: "fingerprint_changed" | "source_unparseable";
      symbol?: SymbolRecord;
    }
  | { status: "orphaned" };

export type SourceReader = (projectRelativePath: string) => string | null | undefined;

export type WithholdingReason =
  | "fingerprint_changed"
  | "source_unparseable"
  | "orphaned"
  | "source_unreadable";

export type RetrievalGateResult =
  | {
      status: "released";
      observation: MemoryObservation;
      symbol: SymbolRecord;
    }
  | {
      status: "withheld";
      reason: WithholdingReason;
      reread: {
        projectRelativePath: string;
        qualifiedName: string;
      };
    };

const FINGERPRINT_FORMAT_VERSION = "ast-structure-v1";
const BOUND_MEMORY_ID_VERSION = "bound-memory-id-v1";

/** Creates the durable portion of a memory-to-symbol binding. */
export function createAnchor(symbol: SymbolRecord): Anchor {
  return {
    qualifiedName: symbol.qualifiedName,
    declarationKind: symbol.declarationKind,
    projectRelativePath: symbol.projectRelativePath,
    fingerprint: symbol.fingerprint,
  };
}

/**
 * Resolves one direct declaration in a single TypeScript source file.
 *
 * Supported names are top-level interfaces, type aliases, functions, variables,
 * and classes (`Name`), plus direct class static properties (`Class.property`).
 * Exported and non-exported declarations are both supported. Imports, aliases,
 * namespaces, computed names, overload sets, and duplicate/merged declarations
 * are unsupported and return null rather than being guessed.
 */
export function resolveSymbol(
  sourceText: string,
  projectRelativePath: string,
  qualifiedName: string,
): SymbolRecord | null {
  const parts = qualifiedName.split(".");
  if (parts.length < 1 || parts.length > 2 || parts.some((part) => part.length === 0)) {
    return null;
  }
  if (hasParseDiagnostics(sourceText, projectRelativePath)) {
    return null;
  }

  const sourceFile = parseTypeScript(sourceText, projectRelativePath);
  const matches = parts.length === 1
    ? findTopLevelDeclarations(sourceFile, parts[0])
    : findClassStaticProperties(sourceFile, parts[0], parts[1]);

  // A durable anchor must identify exactly one declaration.
  if (matches.length !== 1) {
    return null;
  }

  const match = matches[0];
  const declarationStart = match.declaration.getStart(sourceFile);
  const declarationEnd = match.declaration.getEnd();

  return {
    qualifiedName,
    declarationKind: match.declarationKind,
    projectRelativePath,
    declarationStart,
    declarationEnd,
    fingerprint: fingerprintDeclaration(match.declaration, sourceFile, match.fingerprintContext),
  };
}

/** Compatibility wrapper for callers that already resolve `Class.property`. */
export function resolveClassStaticProperty(
  sourceText: string,
  projectRelativePath: string,
  qualifiedName: string,
): SymbolRecord | null {
  const symbol = resolveSymbol(sourceText, projectRelativePath, qualifiedName);
  return symbol?.declarationKind === "class_static_property" ? symbol : null;
}

interface ResolvedDeclaration {
  declaration: ts.Node;
  declarationKind: SymbolDeclarationKind;
  fingerprintContext?: Record<string, string>;
}

function findTopLevelDeclarations(
  sourceFile: ts.SourceFile,
  name: string,
): ResolvedDeclaration[] {
  const matches: ResolvedDeclaration[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === name) {
      matches.push({ declaration: statement, declarationKind: "interface" });
    } else if (ts.isTypeAliasDeclaration(statement) && statement.name.text === name) {
      matches.push({ declaration: statement, declarationKind: "type_alias" });
    } else if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      matches.push({ declaration: statement, declarationKind: "function" });
    } else if (ts.isClassDeclaration(statement) && statement.name?.text === name) {
      matches.push({ declaration: statement, declarationKind: "class" });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
          matches.push({
            declaration,
            declarationKind: "variable",
            fingerprintContext: {
              variableKeyword: variableKeyword(statement.declarationList),
              variableStatementModifiers: variableStatementModifiers(statement),
            },
          });
        }
      }
    }
  }

  return matches;
}

/**
 * A static-property anchor covers the property declaration itself only. It does
 * not track transitive semantic dependencies such as class heritage or referenced
 * constants elsewhere in the source file.
 */
function findClassStaticProperties(
  sourceFile: ts.SourceFile,
  className: string,
  propertyName: string,
): ResolvedDeclaration[] {
  const matches: ResolvedDeclaration[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== className) {
      continue;
    }

    for (const member of statement.members) {
      if (
        ts.isPropertyDeclaration(member) &&
        ts.isIdentifier(member.name) &&
        member.name.text === propertyName &&
        hasModifier(member, ts.SyntaxKind.StaticKeyword)
      ) {
        matches.push({ declaration: member, declarationKind: "class_static_property" });
      }
    }
  }

  return matches;
}

function variableKeyword(declarationList: ts.VariableDeclarationList): string {
  const flags = declarationList.flags;
  if (flags & ts.NodeFlags.AwaitUsing) return "await_using";
  if (flags & ts.NodeFlags.Using) return "using";
  if (flags & ts.NodeFlags.Const) return "const";
  if (flags & ts.NodeFlags.Let) return "let";
  return "var";
}

function variableStatementModifiers(statement: ts.VariableStatement): string {
  return (ts.getModifiers(statement) ?? [])
    .map((modifier) => ts.SyntaxKind[modifier.kind])
    .sort()
    .join(",");
}

export function verifyAnchor(
  anchor: Anchor,
  currentSource: string,
): VerificationResult {
  if (hasParseDiagnostics(currentSource, anchor.projectRelativePath)) {
    return { status: "needs_revalidation", reason: "source_unparseable" };
  }

  const symbol = resolveSymbol(
    currentSource,
    anchor.projectRelativePath,
    anchor.qualifiedName,
  );

  if (symbol === null) {
    return { status: "orphaned" };
  }

  return symbol.declarationKind === anchor.declarationKind && symbol.fingerprint === anchor.fingerprint
    ? { status: "verified", symbol }
    : { status: "needs_revalidation", reason: "fingerprint_changed", symbol };
}

/**
 * Binds a deliberately selected atomic claim to the current declaration of an
 * explicitly named symbol. It does not infer a claim or choose a symbol.
 */
export function bindMemoryObservation(
  input: BindMemoryObservationInput,
  readSource: SourceReader,
  now: () => Date = () => new Date(),
): BindingResult {
  const atomicClaim = input.atomicClaim.trim();
  if (atomicClaim.length === 0) {
    return { status: "unbound", reason: "invalid_claim" };
  }
  const provenance = normalizeProvenance(input.provenance);
  if (provenance === null) {
    return { status: "unbound", reason: "invalid_provenance" };
  }

  let currentSource: string | null | undefined;
  try {
    currentSource = readSource(input.projectRelativePath);
  } catch {
    return { status: "unbound", reason: "source_unreadable" };
  }

  if (typeof currentSource !== "string") {
    return { status: "unbound", reason: "source_unreadable" };
  }
  if (hasParseDiagnostics(currentSource, input.projectRelativePath)) {
    return { status: "unbound", reason: "source_unparseable" };
  }

  const symbol = resolveSymbol(
    currentSource,
    input.projectRelativePath,
    input.qualifiedName,
  );
  if (symbol === null) {
    return { status: "unbound", reason: "symbol_unresolved_or_ambiguous" };
  }

  const boundAt = now().toISOString();
  const observation: MemoryObservation = {
    id: boundMemoryId(provenance.externalObservationId, input.projectRelativePath, input.qualifiedName, atomicClaim),
    content: atomicClaim,
    capturedAt: provenance.capturedAt,
    boundAt,
    source: "claude-mem",
    provenance,
    anchor: createAnchor(symbol),
  };

  return { status: "bound", observation, symbol };
}

function normalizeProvenance(provenance: ClaudeMemProvenance): ClaudeMemProvenance | null {
  const externalObservationId = provenance.externalObservationId.trim();
  if (externalObservationId.length === 0) return null;

  const capturedAtDate = new Date(provenance.capturedAt);
  if (Number.isNaN(capturedAtDate.getTime())) return null;

  return {
    ...provenance,
    externalObservationId,
    capturedAt: capturedAtDate.toISOString(),
  };
}

function boundMemoryId(
  externalObservationId: string,
  projectRelativePath: string,
  qualifiedName: string,
  atomicClaim: string,
): string {
  const canonicalTuple = JSON.stringify({
    version: BOUND_MEMORY_ID_VERSION,
    externalObservationId,
    projectRelativePath,
    qualifiedName,
    atomicClaim,
  });
  const hash = createHash("sha256").update(canonicalTuple).digest("hex");
  return `claude-mem-bound:${hash}`;
}

/**
 * Releases a memory only when its anchored declaration is still verified. This
 * gate makes no judgment about memory truth; unsafe memories are withheld until
 * the caller re-reads the returned source target.
 */
export function gateMemoryObservation(
  observation: MemoryObservation,
  readSource: SourceReader,
): RetrievalGateResult {
  const reread = {
    projectRelativePath: observation.anchor.projectRelativePath,
    qualifiedName: observation.anchor.qualifiedName,
  };

  let currentSource: string | null | undefined;
  try {
    currentSource = readSource(observation.anchor.projectRelativePath);
  } catch {
    return { status: "withheld", reason: "source_unreadable", reread };
  }

  if (typeof currentSource !== "string") {
    return { status: "withheld", reason: "source_unreadable", reread };
  }

  const verification = verifyAnchor(observation.anchor, currentSource);
  if (verification.status === "verified") {
    return { status: "released", observation, symbol: verification.symbol };
  }

  if (verification.status === "orphaned") {
    return { status: "withheld", reason: "orphaned", reread };
  }

  return { status: "withheld", reason: verification.reason, reread };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  return ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false;
}

function parseTypeScript(sourceText: string, projectRelativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    projectRelativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function hasParseDiagnostics(sourceText: string, projectRelativePath: string): boolean {
  const result = ts.transpileModule(sourceText, {
    fileName: projectRelativePath,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.Latest },
  });

  return result.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? false;
}

/**
 * Serializes the parser's tree, excluding source locations and trivia. Child order,
 * node kinds, and leaf text retain syntax that affects TypeScript semantics.
 */
function fingerprintDeclaration(
  declaration: ts.Node,
  sourceFile: ts.SourceFile,
  fingerprintContext?: Record<string, string>,
): string {
  const structuralTree = serializeAstNode(declaration, sourceFile);
  const hashInput = JSON.stringify({
    version: FINGERPRINT_FORMAT_VERSION,
    fingerprintContext,
    structuralTree,
  });

  return createHash("sha256").update(hashInput).digest("hex");
}

interface SerializedAstNode {
  kind: string;
  text?: string;
  children: SerializedAstNode[];
}

function serializeAstNode(node: ts.Node, sourceFile: ts.SourceFile): SerializedAstNode {
  const children = node.getChildren(sourceFile);
  const serialized: SerializedAstNode = {
    kind: ts.SyntaxKind[node.kind],
    children: children.map((child) => serializeAstNode(child, sourceFile)),
  };

  if (children.length === 0) {
    serialized.text = node.getText(sourceFile);
  }

  return serialized;
}
