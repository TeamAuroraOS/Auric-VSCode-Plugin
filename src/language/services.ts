// Editor features over an Analysis, independent of VS Code: hover text,
// completions, signature help and semantic tokens.

import { Analysis } from "./analyze";
import * as ast from "./ast";
import { ERROR_TYPE } from "./ast";
import { AuricSymbol, isArrayType, RefTarget, ScopeInfo } from "./checker";
import { Comment, KEYWORDS, T, Token } from "./lexer";
import { BUILTINS, builtinNamed, CONSTANTS, constantNamed, KEYWORD_DOCS, TYPE_NAMES } from "./prelude";

const displayType = (t: string) => (t === ERROR_TYPE ? "unknown" : t);
const code = (text: string) => "```auric\n" + text + "\n```";
const hasOwn = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * The identifier or keyword token at `offset`; with `touching`, also one the
 * offset sits just after (a cursor at the end of a word).
 */
export function wordTokenAt(a: Analysis, offset: number, touching = true): Token | undefined {
    return a.tokens.find((t) => t.start <= offset && (offset < t.end || (touching && offset === t.end))
        && (t.kind === T.IDENT || hasOwn(KEYWORDS, t.value)) && t.kind !== T.STRING);
}

export function builtinSignature(name: string): string {
    const b = BUILTINS[name];
    const params = b.params.map((p) => `${p.name}: ${p.type}`).join(", ");
    return `fn ${name}(${params})` + (b.ret === "void" ? "" : ` -> ${b.ret}`);
}

export function functionSignature(fn: ast.FnDecl): string {
    const params = fn.params.map((p) => `${p.name}: ${displayType(p.type)}`).join(", ");
    return `fn ${fn.name}(${params})` + (fn.retType === "void" ? "" : ` -> ${displayType(fn.retType)}`);
}

function variableType(symbol: AuricSymbol): string {
    const decl = symbol.decl as ast.LetStmt;
    if (symbol.kind !== "parameter" && decl.arraySize && isArrayType(symbol.type)) {
        return `${symbol.type.slice(0, -2)}[${decl.arraySize}]`;
    }
    return displayType(symbol.type);
}

/** The text of `//` or `/* *\/` comments, without their markers. */
function commentText(comments: Comment[]): string {
    return comments.map((c) => c.text.startsWith("//")
        ? c.text.replace(/^\/\/ ?/, "")
        : c.text.replace(/^\/\*+\s?/, "").replace(/\s*\*+\/$/, "").replace(/^[ \t]*\* ?/gm, ""))
        .join("\n").trim();
}

/** Comments on the lines right above a declaration on `line`, and one after it on that line. */
export function declarationDocs(a: Analysis, line: number, declStart: number): string {
    const ownLine = (c: Comment) => /^[ \t]*$/.test(a.text.slice(a.text.lastIndexOf("\n", c.start - 1) + 1, c.start));
    const above: Comment[] = [];
    let next = line;
    for (let i = a.comments.length - 1; i >= 0; i--) {
        const c = a.comments[i];
        if (c.start >= declStart) {
            continue;
        }
        if (c.endLine !== next - 1 || !ownLine(c)) {
            break;
        }
        above.unshift(c);
        next = c.line;
    }
    const after = a.comments.find((c) => c.line === line && c.start > declStart);
    return [commentText(above), after ? commentText([after]) : ""].filter(Boolean).join("\n\n");
}

function symbolMarkdown(a: Analysis, symbol: AuricSymbol): string {
    switch (symbol.kind) {
        case "function": {
            const fn = symbol.decl as ast.FnDecl;
            const docs = declarationDocs(a, fn.line, fn.start);
            return code(functionSignature(fn)) + (docs ? "\n\n" + docs : "");
        }
        case "parameter":
            return code(`(parameter) ${symbol.name}: ${variableType(symbol)}`);
        default: {
            const decl = symbol.decl as ast.LetStmt;
            const docs = declarationDocs(a, decl.line, decl.start);
            return code(`(${symbol.kind}) let ${symbol.name}: ${variableType(symbol)}`) + (docs ? "\n\n" + docs : "");
        }
    }
}

function builtinMarkdown(name: string): string {
    return code(builtinSignature(name)) + "\n\n" + BUILTINS[name].doc + "\n\n*Built-in function*";
}

function constantMarkdown(name: string): string {
    const c = CONSTANTS[name];
    return code(`(constant) ${name}: ${c.type} = ${c.value}`) + "\n\n" + c.doc;
}

function targetMarkdown(a: Analysis, target: RefTarget): string {
    switch (target.kind) {
        case "symbol":
            return symbolMarkdown(a, target.symbol);
        case "builtin":
            return builtinMarkdown(target.name);
        case "constant":
            return constantMarkdown(target.name);
    }
}

export interface HoverInfo {
    span: ast.Span;
    markdown: string;
}

export function hoverAt(a: Analysis, offset: number): HoverInfo | null {
    const tok = wordTokenAt(a, offset, false);
    if (!tok) {
        return null;
    }
    const span = { start: tok.start, end: tok.end };
    const ref = a.references.find((r) => r.span.start === tok.start);
    if (ref) {
        return { span, markdown: targetMarkdown(a, ref.target) };
    }
    const symbol = a.symbols.find((s) => s.span.start === tok.start);
    if (symbol) {
        return { span, markdown: symbolMarkdown(a, symbol) };
    }
    if (tok.kind === T.IDENT) {
        if (builtinNamed(tok.value)) {
            return { span, markdown: builtinMarkdown(tok.value) };
        }
        if (constantNamed(tok.value)) {
            return { span, markdown: constantMarkdown(tok.value) };
        }
        return null;
    }
    const isType = TYPE_NAMES.includes(tok.value);
    return { span, markdown: `**${tok.value}** *(${isType ? "type" : "keyword"})*\n\n${KEYWORD_DOCS[tok.value]}` };
}

export type CompletionKind = "keyword" | "type" | "function" | "builtin" | "constant" | "variable" | "parameter";

export interface CompletionEntry {
    label: string;
    kind: CompletionKind;
    detail: string;
    documentation?: string;
    /** Snippet text to insert instead of the label. */
    snippet?: string;
}

const STATEMENT_KEYWORDS = ["let", "if", "else", "while", "return", "break", "continue", "true", "false"];

export function inCommentOrString(a: Analysis, offset: number): boolean {
    if (a.comments.some((c) => c.start < offset && (offset < c.end || (offset === c.end && c.text.startsWith("//"))))) {
        return true;
    }
    if (a.tokens.some((t) => t.kind === T.STRING && !t.bad && t.start < offset && offset < t.end)) {
        return true;
    }
    // An unterminated string runs to the end of its line.
    return a.diagnostics.some((d) => d.stage === "lex" && /string literal/.test(d.message) && d.start < offset && offset <= d.end);
}

/** The variables visible at `offset`, innermost first. */
export function visibleSymbols(a: Analysis, offset: number): AuricSymbol[] {
    const contains = (s: ScopeInfo) => s.parent === null
        || (s.start < offset && (offset < s.end || s.end >= a.text.length));
    let inner: ScopeInfo | null = null;
    for (const s of a.scopes) {
        if (contains(s) && (!inner || s.end - s.start <= inner.end - inner.start)) {
            inner = s;
        }
    }
    const seen = new Set<string>();
    const out: AuricSymbol[] = [];
    for (let s = inner; s; s = s.parent) {
        for (const { symbol, visibleFrom } of s.entries) {
            if (visibleFrom <= offset && !seen.has(symbol.name)) {
                seen.add(symbol.name);
                out.push(symbol);
            }
        }
    }
    return out;
}

function callSnippet(name: string, params: string[]): string {
    return `${name}(${params.map((p, i) => `\${${i + 1}:${p}}`).join(", ")})`;
}

export function completionsAt(a: Analysis, offset: number): CompletionEntry[] {
    if (inCommentOrString(a, offset)) {
        return [];
    }
    const word = wordTokenAt(a, offset);
    const wordStart = word && word.start < offset ? word.start : offset;
    const before = [...a.tokens].reverse().find((t) => t.end <= wordStart && t.kind !== T.EOF);
    if (before?.kind === T.FN || before?.kind === T.LET) {
        return []; // naming something new
    }
    if (before?.kind === T.COLON || before?.kind === T.ARROW) {
        return TYPE_NAMES.map((t) => ({ label: t, kind: "type" as const, detail: "type", documentation: KEYWORD_DOCS[t] }));
    }
    const wordEnd = word && word.start < offset ? word.end : offset;
    const callFollows = a.text.slice(wordEnd).trimStart().startsWith("(");
    const inFunction = a.program.functions.some((fn) => fn.body && fn.body.start < offset
        && (offset < fn.body.end || fn.body.end >= a.text.length));

    const entries: CompletionEntry[] = [];
    for (const kw of inFunction ? STATEMENT_KEYWORDS : ["fn", "let", "true", "false"]) {
        entries.push({ label: kw, kind: "keyword", detail: "keyword", documentation: KEYWORD_DOCS[kw] });
    }
    for (const symbol of visibleSymbols(a, offset)) {
        entries.push({
            label: symbol.name,
            kind: symbol.kind === "parameter" ? "parameter" : "variable",
            detail: `(${symbol.kind}) ${variableType(symbol)}`,
            documentation: symbolMarkdown(a, symbol),
        });
    }
    for (const [name, c] of Object.entries(CONSTANTS)) {
        entries.push({ label: name, kind: "constant", detail: `${c.type} = ${c.value}`, documentation: c.doc });
    }
    if (inFunction) {
        for (const [name, b] of Object.entries(BUILTINS)) {
            entries.push({
                label: name,
                kind: "builtin",
                detail: builtinSignature(name),
                documentation: b.doc,
                snippet: callFollows ? undefined : callSnippet(name, b.params.map((p) => p.name)),
            });
        }
        for (const symbol of a.functions.values()) {
            const fn = symbol.decl as ast.FnDecl;
            entries.push({
                label: fn.name,
                kind: "function",
                detail: functionSignature(fn),
                documentation: declarationDocs(a, fn.line, fn.start) || undefined,
                snippet: callFollows ? undefined : callSnippet(fn.name, fn.params.map((p) => p.name)),
            });
        }
    }
    return entries;
}

export interface SignatureHelpInfo {
    label: string;
    documentation?: string;
    /** Each parameter's [start, end) within `label`. */
    parameters: { range: [number, number]; documentation?: string }[];
    activeParameter: number;
}

export function signatureHelpAt(a: Analysis, offset: number): SignatureHelpInfo | null {
    if (inCommentOrString(a, offset)) {
        return null;
    }
    // Walk back to the unclosed `(` of the call around the cursor, counting commas.
    let i = a.tokens.findIndex((t) => t.end > offset || t.kind === T.EOF) - 1;
    let depth = 0;
    let commas = 0;
    for (; i >= 0; i--) {
        const t = a.tokens[i];
        if (t.kind === T.RPAREN || t.kind === T.RBRACKET) {
            depth += 1;
        } else if (t.kind === T.LBRACKET) {
            depth = Math.max(0, depth - 1); // at depth 0: the cursor is in an index inside the call
        } else if (t.kind === T.LPAREN) {
            if (depth === 0) {
                break;
            }
            depth -= 1;
        } else if (depth === 0 && t.kind === T.COMMA) {
            commas += 1;
        } else if (t.kind === T.SEMI || t.kind === T.LBRACE || t.kind === T.RBRACE) {
            return null;
        }
    }
    const callee = i > 0 ? a.tokens[i - 1] : undefined;
    if (!callee || callee.kind !== T.IDENT) {
        return null;
    }

    let label: string;
    let params: { text: string; doc?: string }[];
    let documentation: string | undefined;
    const builtin = builtinNamed(callee.value);
    const fn = a.functions.get(callee.value)?.decl as ast.FnDecl | undefined;
    if (builtin) {
        params = builtin.params.map((p) => ({ text: `${p.name}: ${p.type}` }));
        label = `${callee.value}(`;
        documentation = builtin.doc;
    } else if (fn) {
        params = fn.params.map((p) => ({ text: `${p.name}: ${displayType(p.type)}` }));
        label = `${fn.name}(`;
        documentation = declarationDocs(a, fn.line, fn.start) || undefined;
    } else {
        return null;
    }
    const parameters: SignatureHelpInfo["parameters"] = [];
    params.forEach((p, k) => {
        if (k > 0) {
            label += ", ";
        }
        parameters.push({ range: [label.length, label.length + p.text.length], documentation: p.doc });
        label += p.text;
    });
    const ret = builtin ? builtin.ret : fn!.retType;
    label += ")" + (ret === "void" ? "" : ` -> ${displayType(ret)}`);
    return { label, documentation, parameters, activeParameter: Math.min(commas, Math.max(0, params.length - 1)) };
}

export type SemanticType = "function" | "parameter" | "variable";
export type SemanticModifier = "declaration" | "readonly" | "defaultLibrary";

export interface SemanticToken {
    start: number;
    length: number;
    type: SemanticType;
    modifiers: SemanticModifier[];
}

const constantLike = (s: AuricSymbol) => s.kind === "global" && !s.reassigned && !isArrayType(s.type);

function symbolToken(span: ast.Span, symbol: AuricSymbol, declaration: boolean): SemanticToken {
    const modifiers: SemanticModifier[] = declaration ? ["declaration"] : [];
    if (constantLike(symbol)) {
        modifiers.push("readonly");
    }
    const type: SemanticType = symbol.kind === "function" ? "function"
        : symbol.kind === "parameter" ? "parameter" : "variable";
    return { start: span.start, length: span.end - span.start, type, modifiers };
}

export function semanticTokens(a: Analysis): SemanticToken[] {
    const tokens: SemanticToken[] = a.symbols.map((s) => symbolToken(s.span, s, true));
    for (const ref of a.references) {
        const length = ref.span.end - ref.span.start;
        switch (ref.target.kind) {
            case "symbol":
                tokens.push(symbolToken(ref.span, ref.target.symbol, false));
                break;
            case "builtin":
                tokens.push({ start: ref.span.start, length, type: "function", modifiers: ["defaultLibrary"] });
                break;
            case "constant":
                // Not "defaultLibrary": themes map variable.readonly.defaultLibrary to support.constant,
                // which most leave uncolored, while variable.readonly is colored as a constant.
                tokens.push({ start: ref.span.start, length, type: "variable", modifiers: ["readonly"] });
                break;
        }
    }
    tokens.sort((x, y) => x.start - y.start);
    return tokens.filter((t, i) => t.length > 0 && (i === 0 || t.start !== tokens[i - 1].start));
}
