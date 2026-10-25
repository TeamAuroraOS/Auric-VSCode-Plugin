// Auric AST, mirroring auric-lang/compiler/ast.py. Every node also carries its
// source span (UTF-16 offsets), and `line` is the line aurc reports errors on.

export interface Span {
    start: number;
    end: number;
}

/** The type of anything that already failed to parse or check; it never causes a further error. */
export const ERROR_TYPE = "?";

interface NodeBase extends Span {
    line: number;
}

interface ExprBase extends NodeBase {
    /** Set by the checker. */
    type?: string;
}

export interface IntLit extends ExprBase { kind: "int"; value: string }
export interface FloatLit extends ExprBase { kind: "float"; value: string }
export interface BoolLit extends ExprBase { kind: "bool"; value: boolean }
export interface StringLit extends ExprBase { kind: "string"; value: string }
export interface VarExpr extends ExprBase { kind: "var"; name: string }
export interface UnaryExpr extends ExprBase { kind: "unary"; op: string; operand: Expr }
export interface BinaryExpr extends ExprBase { kind: "binary"; op: string; left: Expr; right: Expr }
export interface CallExpr extends ExprBase { kind: "call"; callee: string; calleeSpan: Span; args: Expr[] }
export interface IndexExpr extends ExprBase { kind: "index"; name: string; nameSpan: Span; index: Expr }
/** Stands in for an expression that failed to parse; already reported. */
export interface ErrorExpr extends ExprBase { kind: "error" }

export type Expr =
    | IntLit | FloatLit | BoolLit | StringLit | VarExpr
    | UnaryExpr | BinaryExpr | CallExpr | IndexExpr | ErrorExpr;

export interface LetStmt extends NodeBase {
    kind: "let";
    name: string;
    nameSpan: Span;
    /** The annotation (`int`, `int[]`), or null to infer. */
    declType: string | null;
    typeSpan: Span | null;
    /** Null for arrays, which are zero-filled. */
    value: Expr | null;
    arraySize: number | null;
    /** A syntax error cut the initializer short, so its type says nothing about the variable's. */
    incomplete?: boolean;
}

export interface AssignStmt extends NodeBase { kind: "assign"; name: string; nameSpan: Span; value: Expr }
export interface IndexAssignStmt extends NodeBase { kind: "indexAssign"; target: IndexExpr; value: Expr }
export interface BreakStmt extends NodeBase { kind: "break" }
export interface ContinueStmt extends NodeBase { kind: "continue" }
export interface IfStmt extends NodeBase {
    kind: "if";
    cond: Expr;
    thenBlock: Block;
    elseBlock: Block | IfStmt | null;
}
export interface WhileStmt extends NodeBase { kind: "while"; cond: Expr; body: Block }
export interface ReturnStmt extends NodeBase { kind: "return"; keyword: Span; value: Expr | null }
export interface ExprStmt extends NodeBase { kind: "expr"; expr: Expr }
export interface Block extends NodeBase { kind: "block"; statements: Stmt[] }

export type Stmt =
    | LetStmt | AssignStmt | IndexAssignStmt | BreakStmt | ContinueStmt
    | IfStmt | WhileStmt | ReturnStmt | ExprStmt | Block;

export interface Param {
    name: string;
    nameSpan: Span;
    type: string;
    line: number;
}

export interface FnDecl extends NodeBase {
    name: string;
    nameSpan: Span;
    params: Param[];
    /** "void" when no `-> type` is written. */
    retType: string;
    retTypeSpan: Span | null;
    /** Null when the body could not be parsed. */
    body: Block | null;
    /** False when the parameter list or return type had a syntax error. */
    signatureOk: boolean;
}

export interface Program {
    functions: FnDecl[];
    globals: LetStmt[];
}
