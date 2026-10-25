import * as ast from "./ast";
import { check, CheckResult } from "./checker";
import { AuricDiagnostic } from "./diagnostic";
import { Comment, Token, tokenize } from "./lexer";
import { parse } from "./parser";

export interface Analysis extends Omit<CheckResult, "diagnostics"> {
    text: string;
    tokens: Token[];
    comments: Comment[];
    program: ast.Program;
    /** Every lexer, parser and type error, in source order. */
    diagnostics: AuricDiagnostic[];
}

export function analyze(text: string): Analysis {
    const lexed = tokenize(text);
    const parsed = parse(lexed.tokens);
    const checked = check(parsed.program, text.length);
    // aurc lexes the whole file before parsing, so it never reports a syntax
    // error beside a lexical one; on the same line it is most likely caused by it.
    const lineOf = (offset: number) => text.slice(0, offset).split("\n").length;
    const lexLines = new Set(lexed.diagnostics.map((d) => lineOf(d.start)));
    const syntax = [
        ...lexed.diagnostics,
        ...parsed.diagnostics.filter((d) => !lexLines.has(lineOf(d.start))),
    ];
    // A line with a syntax error is half-written; its expressions may be cut short.
    const syntaxLines = new Set(syntax.map((d) => lineOf(d.start)));
    const types = checked.diagnostics.filter((d) => !syntaxLines.has(lineOf(d.start)));
    const diagnostics = [...syntax, ...hideCascades(parsed.program, text, syntax, types)]
        .sort((a, b) => a.start - b.start);
    return {
        ...checked,
        text,
        tokens: lexed.tokens,
        comments: lexed.comments,
        program: parsed.program,
        diagnostics,
    };
}

const UNDECLARED = /^(use of undeclared name|assignment to undeclared variable|call to unknown function|program has no )/;
/** What a lost declaration, a lost loop header or misplaced braces cause. */
const CASCADE = new RegExp(UNDECLARED.source + "|^'(break|continue)' outside of a loop|is already declared in this scope$");

/**
 * aurc only type-checks a program that parses. Here type errors are found in
 * a program with syntax errors too, but code after a syntax error may have
 * lost a declaration (or a `while`, or a brace), so these are left out:
 *   - in a function, errors of those kinds from the line of its first syntax
 *     error on (all of its body when its signature is broken);
 *   - for a global, all type errors when a syntax error lies between the
 *     functions around it (its `let` may be the rest of a function a stray
 *     `}` closed early);
 *   - anywhere, "undeclared" and "unknown function" errors when a syntax error
 *     outside function bodies may have swallowed the declaration.
 */
function hideCascades(program: ast.Program, text: string, syntax: AuricDiagnostic[],
    types: AuricDiagnostic[]): AuricDiagnostic[] {
    if (syntax.length === 0) {
        return types;
    }
    const lineStart = (offset: number) => text.lastIndexOf("\n", offset - 1) + 1;
    const fns = program.functions.map((fn) => ({ fn, cut: fn.signatureOk ? Infinity : fn.start }));
    const topLevel: number[] = [];
    for (const d of syntax) {
        const owner = fns.find(({ fn }) => fn.body && d.start >= fn.body.start && d.start <= fn.body.end);
        if (owner) {
            owner.cut = Math.min(owner.cut, lineStart(d.start));
        } else {
            topLevel.push(d.start);
        }
    }
    return types.filter((d) => {
        if (topLevel.length > 0 && UNDECLARED.test(d.message)) {
            return false;
        }
        const owner = fns.find(({ fn }) => d.start >= fn.start && d.start <= fn.end);
        if (owner) {
            return d.start < owner.cut || !CASCADE.test(d.message);
        }
        const before = Math.max(0, ...fns.filter(({ fn }) => fn.end <= d.start).map(({ fn }) => fn.end));
        const after = Math.min(text.length, ...fns.filter(({ fn }) => fn.start > d.start).map(({ fn }) => fn.start));
        return !topLevel.some((offset) => offset >= before && offset <= after);
    });
}
