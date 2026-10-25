// Auric parser, a port of auric-lang/compiler/parser.py: recursive descent with
// one token of lookahead and a precedence climb for expressions. aurc stops at
// the first syntax error; this parser reports it, skips to a point it can
// resume from, and carries on, so one mistake does not hide the rest.

import * as ast from "./ast";
import { ERROR_TYPE } from "./ast";
import { AuricDiagnostic, pyRepr } from "./diagnostic";
import { T, Token } from "./lexer";

const TYPE_KEYWORDS = new Map<T, string>([
    [T.KW_INT, "int"],
    [T.KW_FLOAT, "float"],
    [T.KW_BOOL, "bool"],
    [T.KW_STRING, "string"],
]);

// Low to high, matching C: || && | ^ & ==/!= relational shifts +- */%
const BINARY_TIERS: Map<T, string>[] = [
    new Map([[T.OR, "||"]]),
    new Map([[T.AND, "&&"]]),
    new Map([[T.BITOR, "|"]]),
    new Map([[T.BITXOR, "^"]]),
    new Map([[T.BITAND, "&"]]),
    new Map([[T.EQ, "=="], [T.NE, "!="]]),
    new Map([[T.LT, "<"], [T.LE, "<="], [T.GT, ">"], [T.GE, ">="]]),
    new Map([[T.SHL, "<<"], [T.SHR, ">>"]]),
    new Map([[T.PLUS, "+"], [T.MINUS, "-"]]),
    new Map([[T.STAR, "*"], [T.SLASH, "/"], [T.PERCENT, "%"]]),
];

const STATEMENT_START = new Set([T.LET, T.IF, T.WHILE, T.RETURN, T.BREAK, T.CONTINUE]);

/** Thrown after a syntax error has been recorded, to unwind to a recovery point. */
class ParseAbort {
    constructor(readonly partial: ast.LetStmt | null = null) {}
}

/** Decimal digits of any script as ASCII, as Python's int() reads them. */
function asciiDigits(text: string): string {
    return text.replace(/\p{Nd}/gu, (ch) => {
        let zero = ch.codePointAt(0)!;
        while (/^\p{Nd}$/u.test(String.fromCodePoint(zero - 1))) {
            zero -= 1;
        }
        return String((ch.codePointAt(0)! - zero) % 10);
    });
}

export interface ParseResult {
    program: ast.Program;
    diagnostics: AuricDiagnostic[];
}

class Parser {
    private pos = 0;
    /** `(` and `[` consumed but not yet closed, to tell where a broken statement ends. */
    private openParens = 0;
    /** Where the statement (or top-level item) being parsed starts. */
    private stmtStart = 0;
    private readonly diagnostics: AuricDiagnostic[] = [];
    /** Token indexes already reported, so recovery never stacks errors on one token. */
    private readonly reported = new Set<number>();

    constructor(private readonly tokens: Token[]) {}

    private get cur(): Token {
        return this.tokens[this.pos];
    }

    private peek(ahead = 1): Token {
        return this.tokens[Math.min(this.pos + ahead, this.tokens.length - 1)];
    }

    private at(kind: T): boolean {
        return this.cur.kind === kind;
    }

    private advance(): Token {
        const tok = this.tokens[this.pos];
        if (tok.kind !== T.EOF) {
            this.pos += 1;
        }
        return tok;
    }

    private get prev(): Token | null {
        return this.pos > 0 ? this.tokens[this.pos - 1] : null;
    }

    private prevEnd(): number {
        return this.prev?.end ?? 0;
    }

    private atNewLine(): boolean {
        const prev = this.prev;
        return prev !== null && (this.cur.kind === T.EOF || this.cur.line > prev.line);
    }

    private static describe(tok: Token): string {
        return tok.kind === T.EOF ? "end of file" : pyRepr(tok.value);
    }

    /**
     * Record an error at the current token, as aurc reports it. When that token
     * starts a later line than the one before it, the problem is almost always
     * at the end of the previous line (a missing `;`, say), so that is what gets
     * underlined; the message still names the token aurc found.
     */
    private report(message: string, opts: { underlinePrevious?: boolean; hint?: string } = {}): void {
        const tok = this.cur;
        const prev = this.prev;
        // The lexer already reported a bad token, and what it breaks right after it.
        if (tok.kind === T.INVALID || tok.bad || prev?.bad || this.reported.has(this.pos)) {
            return;
        }
        this.reported.add(this.pos);
        let start = tok.start;
        let end = tok.end;
        if (opts.underlinePrevious !== false && prev && this.atNewLine() && this.pos !== this.stmtStart) {
            start = Math.max(prev.start, prev.end - 1);
            end = prev.end;
        }
        this.diagnostics.push({
            start, end, message, stage: "parse", compilerLine: tok.line, compilerCol: tok.col, hint: opts.hint,
        });
    }

    private fail(message: string, opts: { underlinePrevious?: boolean } = {}): never {
        this.report(message, opts);
        throw new ParseAbort();
    }

    private expect(kind: T, what: string): Token {
        if (!this.at(kind)) {
            this.fail(`expected ${what}, found ${Parser.describe(this.cur)}`);
        }
        return this.advance();
    }

    /** `fn name`: the start of a function rather than a stray keyword. */
    private atFunction(): boolean {
        return this.at(T.FN) && this.peek().kind === T.IDENT;
    }

    parse(): ParseResult {
        const program: ast.Program = { functions: [], globals: [] };
        while (!this.at(T.EOF)) {
            const startPos = this.pos;
            const isLet = this.at(T.LET);
            this.stmtStart = startPos;
            try {
                if (this.at(T.FN)) {
                    program.functions.push(this.fnDecl());
                } else if (isLet) {
                    program.globals.push(this.letStmt());
                } else {
                    this.fail(`expected a function or global declaration, found ${Parser.describe(this.cur)}`,
                        { underlinePrevious: false });
                }
            } catch (e) {
                if (!(e instanceof ParseAbort)) {
                    throw e;
                }
                this.openParens = 0;
                if (e.partial) {
                    program.globals.push(e.partial);
                }
                if (isLet && this.pos !== startPos && this.atNewLine()) {
                    continue; // only the `;` is missing: resume at the next line
                }
                // Statements here are most likely the rest of a function whose
                // body a stray `}` closed early, so skip to the next function.
                this.syncTopLevel(startPos, isLet);
            }
        }
        return { program, diagnostics: this.diagnostics };
    }

    /** Skip to the next `fn` (and, after a broken global, `let`) outside any braces. */
    private syncTopLevel(startPos: number, stopAtLet: boolean): void {
        let depth = 0;
        while (!this.at(T.EOF)) {
            const kind = this.cur.kind;
            if (depth === 0 && this.pos !== startPos && (kind === T.FN || (stopAtLet && kind === T.LET))) {
                return;
            }
            if (kind === T.LBRACE) {
                depth += 1;
            } else if (kind === T.RBRACE && depth > 0) {
                depth -= 1;
            }
            this.advance();
        }
    }

    /**
     * Skip the rest of a statement that failed at the current token, which had
     * `openParens` brackets open: through its `;`, or up to the `}` closing the
     * block or the next statement. A braced block inside it is skipped whole
     * (with any `else` after it).
     */
    private syncStatement(startPos: number, openParens: number): void {
        const errorPos = this.pos;
        if (errorPos === startPos && this.at(T.INVALID)) {
            this.advance(); // a stray character: drop just it
            return;
        }
        if (errorPos !== startPos && this.atNewLine()) {
            return; // the statement only lacks its end (`;`, `)`): resume at the next line
        }
        const errorLine = this.cur.line;
        let parens = openParens;
        let braces = 0;
        while (!this.at(T.EOF)) {
            const kind = this.cur.kind;
            const next = this.peek();
            const sameLineNext = next.kind !== T.EOF && next.line === this.cur.line;
            if (braces === 0) {
                // A `;` inside the broken call ends the statement only at the end of its line.
                if (kind === T.SEMI && (parens === 0 || !sameLineNext)) {
                    this.advance();
                    return;
                }
                if (kind === T.RBRACE) {
                    // A `}` right where the error is, with more of the line after it, is a stray one.
                    const stray = this.pos === errorPos && sameLineNext && next.kind !== T.ELSE && next.kind !== T.RBRACE;
                    if (!stray) {
                        return;
                    }
                    this.advance();
                    continue;
                }
                if ((STATEMENT_START.has(kind) || this.atFunction())
                    && (this.cur.line > errorLine || (parens === 0 && this.pos !== errorPos))) {
                    return;
                }
            }
            switch (kind) {
                case T.LPAREN:
                case T.LBRACKET:
                    parens += 1;
                    break;
                case T.RPAREN:
                case T.RBRACKET:
                    parens = Math.max(0, parens - 1);
                    break;
                case T.LBRACE:
                    braces += 1;
                    break;
                case T.RBRACE:
                    braces -= 1;
                    if (braces === 0) {
                        this.advance();
                        if (!this.at(T.ELSE)) {
                            return;
                        }
                        continue;
                    }
                    break;
            }
            this.advance();
        }
    }

    private type(): string {
        const name = TYPE_KEYWORDS.get(this.cur.kind);
        if (name === undefined) {
            this.fail(`expected a type, found ${Parser.describe(this.cur)}`);
        }
        this.advance();
        return name;
    }

    private nextLineStart(from: number, line: number): number {
        while (this.tokens[from].kind !== T.EOF && this.tokens[from].line <= line) {
            from += 1;
        }
        return from;
    }

    /**
     * The header `opener` starts is not followed by its `{` (a broken signature,
     * or a missing `{`; already reported). Decide how its block goes on:
     *   "brace"   - a `{` further along `line`, after some junk: skipped to it;
     *   "implied" - the body follows without its `{`: on this line up to a
     *               final `}`, or on the lines below, indented deeper, up to a
     *               `}` level with the header (the rest of `line` is skipped);
     *   "none"    - neither, e.g. a C-style `if x > 0 foo();`.
     * Each token skipped is passed to `onSkip`.
     */
    private recoverMissingBrace(opener: Token, line: number, onSkip: (tok: Token) => void = () => undefined)
        : "brace" | "implied" | "none" {
        if (this.at(T.EOF) || this.atFunction()) {
            return "none";
        }
        const lineEnd = this.nextLineStart(this.pos, line);
        const skipTo = (index: number) => {
            while (this.pos < index) {
                onSkip(this.advance());
            }
        };
        for (let i = this.pos; i < lineEnd; i++) {
            if (this.tokens[i].kind === T.LBRACE) {
                skipTo(i);
                return "brace";
            }
            if (this.tokens[i].kind === T.FN && this.tokens[i + 1].kind === T.IDENT) {
                return "none"; // the next function's `{`, not this one's
            }
        }
        if (lineEnd > this.pos && this.tokens[lineEnd - 1].kind === T.RBRACE) {
            return "implied";
        }
        // The header line's indentation, from its first token.
        let first = this.tokens.indexOf(opener);
        while (first > 0 && this.tokens[first - 1].line === opener.line) {
            first -= 1;
        }
        const indent = this.tokens[first].col;
        for (let i = lineEnd; this.tokens[i].kind !== T.EOF; i = this.nextLineStart(i, this.tokens[i].line)) {
            const tok = this.tokens[i];
            if (tok.col <= indent) {
                if (tok.kind === T.RBRACE && tok.col === indent && i > lineEnd) {
                    skipTo(lineEnd);
                    return "implied";
                }
                return "none";
            }
        }
        return "none";
    }

    /** For recoverMissingBrace: take a `-> type` skipped over as `fn`'s return type. */
    private pickUpReturnType(fn: ast.FnDecl): (tok: Token) => void {
        return (tok) => {
            const retType = TYPE_KEYWORDS.get(this.cur.kind);
            if (tok.kind === T.ARROW && retType !== undefined) {
                fn.retType = retType;
                fn.retTypeSpan = { start: this.cur.start, end: this.cur.end };
            }
        };
    }

    private fnDecl(): ast.FnDecl {
        const kw = this.advance();
        const name = this.expect(T.IDENT, "function name");
        const fn: ast.FnDecl = {
            name: name.value,
            nameSpan: { start: name.start, end: name.end },
            params: [],
            retType: "void",
            retTypeSpan: null,
            body: null,
            signatureOk: true,
            line: kw.line,
            start: kw.start,
            end: name.end,
        };
        try {
            this.expect(T.LPAREN, "'('");
            if (!this.at(T.RPAREN)) {
                this.param(fn.params);
                while (this.at(T.COMMA)) {
                    this.advance();
                    this.param(fn.params);
                }
            }
            this.expect(T.RPAREN, "')'");
            if (this.at(T.ARROW)) {
                this.advance();
                const typeTok = this.cur;
                fn.retType = ERROR_TYPE;
                fn.retType = this.type();
                fn.retTypeSpan = { start: typeTok.start, end: typeTok.end };
            }
        } catch (e) {
            if (!(e instanceof ParseAbort)) {
                throw e;
            }
            // Calls to a function whose signature is broken are not checked.
            fn.signatureOk = false;
        }
        let how: "brace" | "implied" | "none" = "brace";
        if (!fn.signatureOk) {
            how = this.recoverMissingBrace(kw, this.cur.line, this.pickUpReturnType(fn));
        } else if (!this.at(T.LBRACE)) {
            this.report(`expected '{', found ${Parser.describe(this.cur)}`);
            if (!this.at(T.EOF) && !this.atFunction()) {
                // Junk in the header: calls to the function are not checked either.
                fn.signatureOk = false;
                how = this.recoverMissingBrace(kw, this.prev!.line, this.pickUpReturnType(fn));
            } else {
                how = "none";
            }
        }
        if (!fn.signatureOk && fn.retType === "void" && fn.retTypeSpan === null) {
            fn.retType = ERROR_TYPE; // its `-> type` may be in what was skipped
        }
        if (how === "none") {
            this.syncTopLevel(-1, false);
            fn.end = this.prevEnd();
            return fn;
        }
        fn.body = this.block(how === "implied");
        fn.end = fn.body.end;
        return fn;
    }

    /** Parse `name: type` into `into`, adding it before its type so a broken type still declares it. */
    private param(into: ast.Param[]): void {
        const name = this.expect(T.IDENT, "parameter name");
        const param: ast.Param = {
            name: name.value, nameSpan: { start: name.start, end: name.end }, type: ERROR_TYPE, line: name.line,
        };
        into.push(param);
        this.expect(T.COLON, "':'");
        param.type = this.type();
    }

    /** The block after an `if`, `else` or `while` header that `opener` starts. */
    private bodyBlock(opener: Token): ast.Block {
        if (this.at(T.LBRACE)) {
            return this.block();
        }
        this.report(`expected '{', found ${Parser.describe(this.cur)}`);
        const how = this.recoverMissingBrace(opener, this.prev!.line);
        if (how === "none") {
            throw new ParseAbort();
        }
        return this.block(how === "implied");
    }

    /**
     * A `{ ... }` block, or with `implied` one whose `{` is missing and starts
     * at the current token. Only throws when a `{` is expected and missing; a
     * missing `}` is reported and the block returned.
     */
    private block(implied = false): ast.Block {
        const lb = implied ? this.cur : this.expect(T.LBRACE, "'{'");
        const block: ast.Block = {
            kind: "block", statements: [], line: lb.line, start: lb.start, end: implied ? lb.start : lb.end,
        };
        while (!this.at(T.RBRACE) && !this.at(T.EOF)) {
            if (this.atFunction()) {
                // aurc parses `fn` here as an expression; the body above is missing its `}`.
                this.report("expected an expression, found 'fn'", {
                    underlinePrevious: false,
                    hint: "is a '}' missing before this function?",
                });
                block.end = this.cur.start;
                return block;
            }
            const startPos = this.pos;
            const parens = this.openParens;
            this.stmtStart = startPos;
            try {
                block.statements.push(this.stmt());
            } catch (e) {
                if (!(e instanceof ParseAbort)) {
                    throw e;
                }
                if (e.partial) {
                    block.statements.push(e.partial);
                }
                const open = this.openParens - parens;
                this.openParens = parens;
                this.syncStatement(startPos, open);
            }
        }
        if (this.at(T.RBRACE)) {
            block.end = this.advance().end;
        } else {
            this.report(`expected '}', found ${Parser.describe(this.cur)}`);
            block.end = this.cur.end;
        }
        return block;
    }

    private stmt(): ast.Stmt {
        switch (this.cur.kind) {
            case T.LET:
                return this.letStmt();
            case T.IF:
                return this.ifStmt();
            case T.WHILE:
                return this.whileStmt();
            case T.RETURN:
                return this.returnStmt();
            case T.BREAK:
            case T.CONTINUE: {
                const kw = this.advance();
                this.expect(T.SEMI, "';'");
                return { kind: kw.kind === T.BREAK ? "break" : "continue", line: kw.line, start: kw.start, end: kw.end };
            }
            case T.LBRACE:
                // Not a statement to aurc; parsed as a block to keep the braces paired.
                this.report("expected an expression, found '{'", { underlinePrevious: false });
                return this.block();
        }
        if (this.at(T.IDENT) && this.peek().kind === T.ASSIGN) {
            return this.assignStmt();
        }
        return this.exprStmt();
    }

    private letStmt(): ast.LetStmt {
        const kw = this.advance();
        const name = this.expect(T.IDENT, "variable name");
        const stmt: ast.LetStmt = {
            kind: "let",
            name: name.value,
            nameSpan: { start: name.start, end: name.end },
            declType: null,
            typeSpan: null,
            value: null,
            arraySize: null,
            line: kw.line,
            start: kw.start,
            end: name.end,
        };
        try {
            if (this.at(T.COLON)) {
                this.advance();
                const typeTok = this.cur;
                const declType = this.type();
                stmt.declType = declType;
                stmt.typeSpan = { start: typeTok.start, end: typeTok.end };
                if (this.at(T.LBRACKET)) { // `let board: int[200];`
                    this.advance();
                    stmt.declType = declType + "[]";
                    stmt.arraySize = 0;
                    if (this.at(T.INT)) {
                        const size = BigInt(asciiDigits(this.cur.value));
                        if (size <= 0n) {
                            this.report("array length must be at least 1", { underlinePrevious: false });
                        }
                        stmt.arraySize = Number(size);
                    }
                    this.expect(T.INT, "array length");
                    this.expect(T.RBRACKET, "']'");
                    stmt.typeSpan = { start: typeTok.start, end: this.prevEnd() };
                }
            }
            if (stmt.arraySize !== null) {
                // Arrays are always zero-filled; there is no initializer syntax.
                this.expect(T.SEMI, "';'");
                stmt.end = this.prevEnd();
                return stmt;
            }
            this.expect(T.ASSIGN, "'='");
            stmt.value = this.expr();
            this.expect(T.SEMI, "';'");
            stmt.end = this.prevEnd();
            return stmt;
        } catch (e) {
            if (!(e instanceof ParseAbort)) {
                throw e;
            }
            // Keep the declaration so later uses of the name are not errors too.
            if (stmt.arraySize === null && stmt.value === null) {
                stmt.value = { kind: "error", line: kw.line, start: this.cur.start, end: this.cur.start };
            } else if (stmt.value !== null && !this.atNewLine()) {
                stmt.incomplete = true; // more of the line follows: only the `;` is missing if it ends there
            }
            stmt.end = this.prevEnd();
            throw new ParseAbort(stmt);
        }
    }

    private assignStmt(): ast.AssignStmt {
        const name = this.advance();
        this.expect(T.ASSIGN, "'='");
        const value = this.expr();
        this.expect(T.SEMI, "';'");
        return {
            kind: "assign", name: name.value, nameSpan: { start: name.start, end: name.end }, value,
            line: name.line, start: name.start, end: this.prevEnd(),
        };
    }

    private ifStmt(): ast.IfStmt {
        const kw = this.advance();
        const cond = this.expr();
        const thenBlock = this.bodyBlock(kw);
        let elseBlock: ast.Block | ast.IfStmt | null = null;
        if (this.at(T.ELSE)) {
            const elseKw = this.advance();
            elseBlock = this.at(T.IF) ? this.ifStmt() : this.bodyBlock(elseKw);
        }
        return { kind: "if", cond, thenBlock, elseBlock, line: kw.line, start: kw.start, end: this.prevEnd() };
    }

    private whileStmt(): ast.WhileStmt {
        const kw = this.advance();
        const cond = this.expr();
        const body = this.bodyBlock(kw);
        return { kind: "while", cond, body, line: kw.line, start: kw.start, end: body.end };
    }

    private returnStmt(): ast.ReturnStmt {
        const kw = this.advance();
        let value: ast.Expr | null = null;
        if (!this.at(T.SEMI)) {
            value = this.expr();
        }
        this.expect(T.SEMI, "';'");
        return {
            kind: "return", keyword: { start: kw.start, end: kw.end }, value,
            line: kw.line, start: kw.start, end: this.prevEnd(),
        };
    }

    private exprStmt(): ast.Stmt {
        const expr = this.expr();
        // `name[i] = value;`, only detectable after parsing the index.
        if (expr.kind === "index" && this.at(T.ASSIGN)) {
            this.advance();
            const value = this.expr();
            this.expect(T.SEMI, "';'");
            return { kind: "indexAssign", target: expr, value, line: expr.line, start: expr.start, end: this.prevEnd() };
        }
        this.expect(T.SEMI, "';'");
        return { kind: "expr", expr, line: expr.line, start: expr.start, end: this.prevEnd() };
    }

    private expr(): ast.Expr {
        return this.binary(0);
    }

    private binary(tier: number): ast.Expr {
        if (tier >= BINARY_TIERS.length) {
            return this.unary();
        }
        const ops = BINARY_TIERS[tier];
        let left = this.binary(tier + 1);
        while (ops.has(this.cur.kind)) {
            const opTok = this.advance();
            const right = this.binary(tier + 1);
            left = {
                kind: "binary", op: ops.get(opTok.kind)!, left, right,
                line: opTok.line, start: left.start, end: right.end,
            };
        }
        return left;
    }

    private unary(): ast.Expr {
        if (this.at(T.NOT) || this.at(T.MINUS)) {
            const opTok = this.advance();
            const operand = this.unary();
            return { kind: "unary", op: opTok.value, operand, line: opTok.line, start: opTok.start, end: operand.end };
        }
        return this.primary();
    }

    private primary(): ast.Expr {
        const tok = this.cur;
        const base = { line: tok.line, start: tok.start, end: tok.end };
        switch (tok.kind) {
            case T.INT:
                this.advance();
                return { kind: "int", value: tok.value, ...base };
            case T.FLOAT:
                this.advance();
                return { kind: "float", value: tok.value, ...base };
            case T.STRING:
                this.advance();
                return { kind: "string", value: tok.value, ...base };
            case T.TRUE:
            case T.FALSE:
                this.advance();
                return { kind: "bool", value: tok.kind === T.TRUE, ...base };
            case T.LPAREN: {
                this.advance();
                this.openParens += 1;
                const inner = this.expr();
                const rp = this.expect(T.RPAREN, "')'");
                this.openParens -= 1;
                inner.start = tok.start;
                inner.end = rp.end;
                return inner;
            }
            case T.IDENT: {
                this.advance();
                if (this.at(T.LPAREN)) {
                    return this.call(tok);
                }
                if (this.at(T.LBRACKET)) {
                    this.advance();
                    this.openParens += 1;
                    const index = this.expr();
                    const rb = this.expect(T.RBRACKET, "']'");
                    this.openParens -= 1;
                    return {
                        kind: "index", name: tok.value, nameSpan: { start: tok.start, end: tok.end }, index,
                        line: tok.line, start: tok.start, end: rb.end,
                    };
                }
                return { kind: "var", name: tok.value, ...base };
            }
        }
        this.fail(`expected an expression, found ${Parser.describe(tok)}`);
    }

    private call(callee: Token): ast.CallExpr {
        this.expect(T.LPAREN, "'('");
        this.openParens += 1;
        const args: ast.Expr[] = [];
        if (!this.at(T.RPAREN)) {
            args.push(this.expr());
            while (this.at(T.COMMA)) {
                this.advance();
                args.push(this.expr());
            }
        }
        const rp = this.expect(T.RPAREN, "')'");
        this.openParens -= 1;
        return {
            kind: "call", callee: callee.value, calleeSpan: { start: callee.start, end: callee.end }, args,
            line: callee.line, start: callee.start, end: rp.end,
        };
    }
}

export function parse(tokens: Token[]): ParseResult {
    return new Parser(tokens).parse();
}
