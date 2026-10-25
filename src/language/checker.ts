// Auric semantic pass, a port of auric-lang/compiler/typecheck.py. aurc raises
// on the first ill-typed or undeclared use; this checker reports every one,
// giving anything already in error the type ERROR_TYPE, which raises nothing
// further. It also records symbols, references and scopes for editor features.

import * as ast from "./ast";
import { ERROR_TYPE } from "./ast";
import { AuricDiagnostic } from "./diagnostic";
import { builtinNamed, constantNamed } from "./prelude";

const NUMERIC = new Set(["int", "float"]);
const ORDERED = new Set(["int", "float"]);
const EQUATABLE = new Set(["int", "float", "bool", "string"]);
const BITWISE = new Set(["&", "|", "^", "<<", ">>"]);
const COMPARISON = new Set(["<", "<=", ">", ">="]);

export const isArrayType = (t: string) => t.endsWith("[]");
const elementType = (t: string) => t.slice(0, -2);

export type SymbolKind = "function" | "global" | "local" | "parameter";

export interface AuricSymbol {
    name: string;
    kind: SymbolKind;
    /** A variable's type, or a function's return type. */
    type: string;
    /** The name where it is declared. */
    span: ast.Span;
    decl: ast.FnDecl | ast.LetStmt | ast.Param;
    /** For variables: assigned to with `name = ...` after its declaration. */
    reassigned: boolean;
}

export type RefTarget =
    | { kind: "symbol"; symbol: AuricSymbol }
    | { kind: "builtin"; name: string }
    | { kind: "constant"; name: string };

export interface Reference {
    span: ast.Span;
    target: RefTarget;
}

export interface ScopeInfo extends ast.Span {
    parent: ScopeInfo | null;
    /** Declarations, each visible from an offset (a `let` after its statement). */
    entries: { symbol: AuricSymbol; visibleFrom: number }[];
}

export interface CheckResult {
    diagnostics: AuricDiagnostic[];
    symbols: AuricSymbol[];
    references: Reference[];
    scopes: ScopeInfo[];
    /** The functions calls resolve to (first definition of each name). */
    functions: Map<string, AuricSymbol>;
}

class Scope {
    readonly vars = new Map<string, AuricSymbol>();

    constructor(readonly parent: Scope | null, readonly info: ScopeInfo) {}

    lookup(name: string): AuricSymbol | undefined {
        for (let scope: Scope | null = this; scope; scope = scope.parent) {
            const sym = scope.vars.get(name);
            if (sym) {
                return sym;
            }
        }
        return undefined;
    }
}

class Checker {
    private readonly diagnostics: AuricDiagnostic[] = [];
    private readonly symbols: AuricSymbol[] = [];
    private readonly references: Reference[] = [];
    private readonly scopes: ScopeInfo[] = [];
    private readonly functions = new Map<string, AuricSymbol>();
    private readonly globals: Scope;
    private currentRet = "void";
    private loopDepth = 0;

    constructor(private readonly program: ast.Program, sourceLength: number) {
        const info: ScopeInfo = { start: 0, end: sourceLength, parent: null, entries: [] };
        this.scopes.push(info);
        this.globals = new Scope(null, info);
    }

    private error(span: ast.Span, message: string, line: number): void {
        this.diagnostics.push({
            start: span.start, end: span.end, message, stage: "type", compilerLine: line, compilerCol: 0,
        });
    }

    private declare(scope: Scope, symbol: AuricSymbol, line: number, visibleFrom: number): void {
        this.symbols.push(symbol);
        const name = symbol.name;
        if (constantNamed(name) || builtinNamed(name)) {
            this.error(symbol.span, `'${name}' is a predefined name and cannot be used as a variable`, line);
            return;
        }
        if (scope.vars.has(name)) {
            this.error(symbol.span, `'${name}' is already declared in this scope`, line);
            return;
        }
        scope.vars.set(name, symbol);
        scope.info.entries.push({ symbol, visibleFrom });
    }

    private ref(span: ast.Span, target: RefTarget): void {
        this.references.push({ span: { start: span.start, end: span.end }, target });
    }

    check(): CheckResult {
        for (const fn of this.program.functions) {
            const symbol: AuricSymbol = {
                name: fn.name, kind: "function", type: fn.retType, span: fn.nameSpan, decl: fn, reassigned: false,
            };
            this.symbols.push(symbol);
            if (this.functions.has(fn.name)) {
                this.error(fn.nameSpan, `function '${fn.name}' is defined more than once`, fn.line);
            } else if (builtinNamed(fn.name)) {
                this.error(fn.nameSpan, `'${fn.name}' is a built-in and cannot be redefined`, fn.line);
            } else {
                this.functions.set(fn.name, symbol);
            }
        }

        const main = this.functions.get("main")?.decl as ast.FnDecl | undefined;
        if (!main) {
            this.error({ start: 0, end: 0 }, "program has no 'fn main()' entry point", 0);
        } else if (main.signatureOk) {
            if (main.params.length > 0) {
                const params = { start: main.params[0].nameSpan.start, end: main.params[main.params.length - 1].nameSpan.end };
                this.error(params, "'fn main' must take no parameters", main.line);
            }
            if (main.retType !== "void") {
                this.error(main.retTypeSpan ?? main.nameSpan, "'fn main' must not return a value", main.line);
            }
        }

        this.checkGlobals();

        for (const fn of this.program.functions) {
            this.checkFn(fn);
        }

        return {
            diagnostics: this.diagnostics,
            symbols: this.symbols,
            references: this.references,
            scopes: this.scopes,
            functions: this.functions,
        };
    }

    /** Module-level `let`s. Their initializers become C file-scope initializers, so must be constant. */
    private checkGlobals(): void {
        for (const g of this.program.globals) {
            if (this.functions.has(g.name)) {
                this.error(g.nameSpan, `'${g.name}' is already declared as a function`, g.line);
            }
            const symbol: AuricSymbol = {
                name: g.name, kind: "global", type: ERROR_TYPE, span: g.nameSpan, decl: g, reassigned: false,
            };
            if (g.arraySize !== null) {
                symbol.type = g.declType!;
                this.declare(this.globals, symbol, g.line, 0);
                continue;
            }
            const value = g.value!;
            const vtype = this.checkExpr(value, this.globals);
            symbol.type = g.declType ?? vtype;
            if (g.incomplete) {
                symbol.type = g.declType ?? ERROR_TYPE;
            } else if (vtype === "void") {
                this.error(value, "cannot bind a void value to a global", g.line);
                symbol.type = g.declType ?? ERROR_TYPE;
            } else if (g.declType !== null && vtype !== ERROR_TYPE && g.declType !== vtype) {
                this.error(value, `global '${g.name}' declared as ${g.declType} but initialized with ${vtype}`, g.line);
            } else if (vtype !== ERROR_TYPE && !this.isConstExpr(value)) {
                this.error(value,
                    `global '${g.name}' must be initialized with a constant expression ` +
                    "(literals, predefined constants, and arithmetic on them)", g.line);
            }
            this.declare(this.globals, symbol, g.line, 0);
        }
    }

    private isConstExpr(expr: ast.Expr): boolean {
        switch (expr.kind) {
            case "int":
            case "float":
            case "bool":
            case "string":
            case "error":
                return true;
            case "var":
                // An undeclared name is already an error of its own.
                return constantNamed(expr.name) !== undefined || expr.type === ERROR_TYPE;
            case "unary":
                return this.isConstExpr(expr.operand);
            case "binary":
                // Comparing strings is a runtime call (aur_str_eq).
                if ((expr.op === "==" || expr.op === "!=") && expr.left.type === "string") {
                    return false;
                }
                return this.isConstExpr(expr.left) && this.isConstExpr(expr.right);
            default:
                return false;
        }
    }

    private checkFn(fn: ast.FnDecl): void {
        this.currentRet = fn.retType;
        this.loopDepth = 0;
        const info: ScopeInfo = { start: fn.start, end: fn.end, parent: this.globals.info, entries: [] };
        this.scopes.push(info);
        const scope = new Scope(this.globals, info);
        for (const p of fn.params) {
            const symbol: AuricSymbol = {
                name: p.name, kind: "parameter", type: p.type, span: p.nameSpan, decl: p, reassigned: false,
            };
            this.declare(scope, symbol, p.line, fn.start);
        }
        if (fn.body) {
            this.checkBlock(fn.body, scope);
        }
    }

    private checkBlock(block: ast.Block, parent: Scope): void {
        const info: ScopeInfo = { start: block.start, end: block.end, parent: parent.info, entries: [] };
        this.scopes.push(info);
        const scope = new Scope(parent, info);
        for (const stmt of block.statements) {
            this.checkStmt(stmt, scope);
        }
    }

    private checkStmt(stmt: ast.Stmt, scope: Scope): void {
        switch (stmt.kind) {
            case "let": {
                const symbol: AuricSymbol = {
                    name: stmt.name, kind: "local", type: ERROR_TYPE, span: stmt.nameSpan, decl: stmt, reassigned: false,
                };
                if (stmt.arraySize !== null) {
                    symbol.type = stmt.declType!;
                    this.declare(scope, symbol, stmt.line, stmt.end);
                    break;
                }
                const value = stmt.value!;
                const vtype = this.checkExpr(value, scope);
                symbol.type = stmt.declType ?? vtype;
                if (stmt.incomplete) {
                    symbol.type = stmt.declType ?? ERROR_TYPE;
                } else if (vtype === "void") {
                    this.error(value, "cannot bind a void value to a variable", stmt.line);
                    symbol.type = stmt.declType ?? ERROR_TYPE;
                } else if (stmt.declType !== null && vtype !== ERROR_TYPE && stmt.declType !== vtype) {
                    this.error(value,
                        `variable '${stmt.name}' declared as ${stmt.declType} but initialized with ${vtype}`, stmt.line);
                }
                this.declare(scope, symbol, stmt.line, stmt.end);
                break;
            }

            case "indexAssign": {
                const etype = this.checkIndexTarget(stmt.target, scope);
                const vtype = this.checkExpr(stmt.value, scope);
                if (etype !== ERROR_TYPE && vtype !== ERROR_TYPE && vtype !== etype) {
                    this.error(stmt.value,
                        `cannot assign ${vtype} to an element of '${stmt.target.name}' of type ${etype}`, stmt.line);
                }
                break;
            }

            case "break":
            case "continue":
                if (this.loopDepth === 0) {
                    this.error(stmt, `'${stmt.kind}' outside of a loop`, stmt.line);
                }
                break;

            case "assign": {
                const declared = scope.lookup(stmt.name);
                if (!declared) {
                    this.error(stmt.nameSpan, `assignment to undeclared variable '${stmt.name}'`, stmt.line);
                } else {
                    this.ref(stmt.nameSpan, { kind: "symbol", symbol: declared });
                    declared.reassigned = true;
                }
                const vtype = this.checkExpr(stmt.value, scope);
                if (declared && declared.type !== ERROR_TYPE && vtype !== ERROR_TYPE && vtype !== declared.type) {
                    this.error(stmt.value, `cannot assign ${vtype} to '${stmt.name}' of type ${declared.type}`, stmt.line);
                }
                break;
            }

            case "if":
                this.requireBool(stmt.cond, scope, "if condition");
                this.checkBlock(stmt.thenBlock, scope);
                if (stmt.elseBlock?.kind === "if") {
                    this.checkStmt(stmt.elseBlock, scope);
                } else if (stmt.elseBlock) {
                    this.checkBlock(stmt.elseBlock, scope);
                }
                break;

            case "while":
                this.requireBool(stmt.cond, scope, "while condition");
                this.loopDepth += 1;
                this.checkBlock(stmt.body, scope);
                this.loopDepth -= 1;
                break;

            case "return":
                if (stmt.value === null) {
                    if (this.currentRet !== "void" && this.currentRet !== ERROR_TYPE) {
                        this.error(stmt.keyword,
                            `return without a value in a function returning ${this.currentRet}`, stmt.line);
                    }
                } else {
                    const vtype = this.checkExpr(stmt.value, scope);
                    if (this.currentRet === "void") {
                        this.error(stmt.value, "return with a value in a void function", stmt.line);
                    } else if (this.currentRet !== ERROR_TYPE && vtype !== ERROR_TYPE && vtype !== this.currentRet) {
                        this.error(stmt.value,
                            `returning ${vtype} from a function declared to return ${this.currentRet}`, stmt.line);
                    }
                }
                break;

            case "expr":
                this.checkExpr(stmt.expr, scope);
                break;

            case "block":
                this.checkBlock(stmt, scope);
                break;
        }
    }

    /** Resolve `name[index]` and return its element type. */
    private checkIndexTarget(target: ast.IndexExpr, scope: Scope): string {
        const declared = scope.lookup(target.name);
        if (!declared) {
            this.error(target.nameSpan, `use of undeclared name '${target.name}'`, target.line);
        } else {
            this.ref(target.nameSpan, { kind: "symbol", symbol: declared });
            if (declared.type !== ERROR_TYPE && !isArrayType(declared.type)) {
                this.error(target.nameSpan,
                    `'${target.name}' is ${declared.type}, not an array, so it cannot be indexed`, target.line);
            }
        }
        const itype = this.checkExpr(target.index, scope);
        if (!declared || declared.type === ERROR_TYPE || !isArrayType(declared.type)) {
            return (target.type = ERROR_TYPE);
        }
        if (itype !== "int" && itype !== ERROR_TYPE) {
            this.error(target.index, `array index must be int, found ${itype}`, target.line);
        }
        return (target.type = elementType(declared.type));
    }

    private requireBool(expr: ast.Expr, scope: Scope, what: string): void {
        const t = this.checkExpr(expr, scope);
        if (t !== "bool" && t !== ERROR_TYPE) {
            this.error(expr, `${what} must be bool, found ${t}`, expr.line);
        }
    }

    private checkExpr(expr: ast.Expr, scope: Scope): string {
        const t = this.infer(expr, scope);
        expr.type = t;
        return t;
    }

    private infer(expr: ast.Expr, scope: Scope): string {
        switch (expr.kind) {
            case "int":
                return "int";
            case "float":
                return "float";
            case "bool":
                return "bool";
            case "string":
                return "string";
            case "error":
                return ERROR_TYPE;

            case "var": {
                const declared = scope.lookup(expr.name);
                if (declared) {
                    this.ref(expr, { kind: "symbol", symbol: declared });
                    return declared.type;
                }
                const constant = constantNamed(expr.name);
                if (constant) {
                    this.ref(expr, { kind: "constant", name: expr.name });
                    return constant.type;
                }
                this.error(expr, `use of undeclared name '${expr.name}'`, expr.line);
                return ERROR_TYPE;
            }

            case "unary": {
                const ot = this.checkExpr(expr.operand, scope);
                if (expr.op === "!") {
                    if (ot !== "bool" && ot !== ERROR_TYPE) {
                        this.error(expr, `'!' expects bool, found ${ot}`, expr.line);
                    }
                    return "bool";
                }
                if (ot !== ERROR_TYPE && !NUMERIC.has(ot)) {
                    this.error(expr, `unary '-' expects a number, found ${ot}`, expr.line);
                    return ERROR_TYPE;
                }
                return ot;
            }

            case "index":
                return this.checkIndexTarget(expr, scope);

            case "binary":
                return this.inferBinary(expr, scope);

            case "call":
                return this.inferCall(expr, scope);
        }
    }

    private inferBinary(expr: ast.BinaryExpr, scope: Scope): string {
        const op = expr.op;
        const lt = this.checkExpr(expr.left, scope);
        const rt = this.checkExpr(expr.right, scope);
        const known = lt !== ERROR_TYPE && rt !== ERROR_TYPE;

        if (op === "&&" || op === "||") {
            if (known && (lt !== "bool" || rt !== "bool")) {
                this.error(expr, `'${op}' expects bool operands, found ${lt} and ${rt}`, expr.line);
            }
            return "bool";
        }

        if (op === "==" || op === "!=") {
            if (known && (lt !== rt || !EQUATABLE.has(lt))) {
                this.error(expr, `'${op}' cannot compare ${lt} and ${rt}`, expr.line);
            }
            return "bool";
        }

        if (COMPARISON.has(op)) {
            if (known && (lt !== rt || !ORDERED.has(lt))) {
                this.error(expr, `'${op}' expects two ints or two floats, found ${lt} and ${rt}`, expr.line);
            }
            return "bool";
        }

        if (BITWISE.has(op)) {
            if (known && (lt !== "int" || rt !== "int")) {
                this.error(expr, `'${op}' expects two ints, found ${lt} and ${rt}`, expr.line);
            }
            return "int";
        }

        // arithmetic: + - * / %
        if (!known) {
            const other = lt === ERROR_TYPE ? rt : lt;
            return NUMERIC.has(other) ? other : ERROR_TYPE;
        }
        if (lt !== rt || !NUMERIC.has(lt)) {
            this.error(expr, `'${op}' expects two ints or two floats, found ${lt} and ${rt}`, expr.line);
            return ERROR_TYPE;
        }
        if (op === "%" && lt !== "int") {
            this.error(expr, "'%' is only defined for int", expr.line);
            return ERROR_TYPE;
        }
        return lt;
    }

    private inferCall(expr: ast.CallExpr, scope: Scope): string {
        const name = expr.callee;
        let params: string[];
        let ret: string;
        const builtin = builtinNamed(name);
        const fn = this.functions.get(name);
        if (builtin) {
            this.ref(expr.calleeSpan, { kind: "builtin", name });
            params = builtin.params.map((p) => p.type);
            ret = builtin.ret;
        } else if (fn) {
            this.ref(expr.calleeSpan, { kind: "symbol", symbol: fn });
            const decl = fn.decl as ast.FnDecl;
            if (!decl.signatureOk) {
                expr.args.forEach((arg) => this.checkExpr(arg, scope));
                return decl.retType;
            }
            params = decl.params.map((p) => p.type);
            ret = decl.retType;
        } else {
            this.error(expr.calleeSpan, `call to unknown function '${name}'`, expr.line);
            expr.args.forEach((arg) => this.checkExpr(arg, scope));
            return ERROR_TYPE;
        }

        if (expr.args.length !== params.length) {
            this.error(expr.calleeSpan,
                `'${name}' expects ${params.length} argument(s), got ${expr.args.length}`, expr.line);
            expr.args.forEach((arg) => this.checkExpr(arg, scope));
            return ret;
        }
        expr.args.forEach((arg, i) => {
            const at = this.checkExpr(arg, scope);
            if (at !== ERROR_TYPE && params[i] !== ERROR_TYPE && at !== params[i]) {
                this.error(arg, `argument ${i + 1} of '${name}' expects ${params[i]}, found ${at}`, arg.line);
            }
        });
        return ret;
    }
}

export function check(program: ast.Program, sourceLength: number): CheckResult {
    return new Checker(program, sourceLength).check();
}
