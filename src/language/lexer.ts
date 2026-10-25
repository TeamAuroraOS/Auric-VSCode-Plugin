// Auric lexer, a port of auric-lang/compiler/lexer.py. Where aurc stops at the
// first error, this one reports it and carries on, so the parser can find more.

import { AuricDiagnostic, pyRepr } from "./diagnostic";

export enum T {
    INT, FLOAT, STRING, IDENT,
    FN, LET, IF, ELSE, WHILE, RETURN, BREAK, CONTINUE, TRUE, FALSE,
    KW_INT, KW_FLOAT, KW_BOOL, KW_STRING,
    LPAREN, RPAREN, LBRACE, RBRACE, LBRACKET, RBRACKET,
    COMMA, COLON, SEMI, ARROW, ASSIGN,
    PLUS, MINUS, STAR, SLASH, PERCENT,
    EQ, NE, LT, LE, GT, GE, AND, OR, NOT,
    BITAND, BITOR, BITXOR, SHL, SHR,
    /** A character aurc rejects; already reported by the lexer. */
    INVALID,
    EOF,
}

export const KEYWORDS: Record<string, T> = {
    fn: T.FN,
    let: T.LET,
    if: T.IF,
    else: T.ELSE,
    while: T.WHILE,
    return: T.RETURN,
    break: T.BREAK,
    continue: T.CONTINUE,
    true: T.TRUE,
    false: T.FALSE,
    int: T.KW_INT,
    float: T.KW_FLOAT,
    bool: T.KW_BOOL,
    string: T.KW_STRING,
};

const TWO_CHAR: Record<string, T> = {
    "->": T.ARROW, "==": T.EQ, "!=": T.NE, "<=": T.LE, ">=": T.GE,
    "&&": T.AND, "||": T.OR, "<<": T.SHL, ">>": T.SHR,
};

const ONE_CHAR: Record<string, T> = {
    "(": T.LPAREN, ")": T.RPAREN, "{": T.LBRACE, "}": T.RBRACE,
    "[": T.LBRACKET, "]": T.RBRACKET,
    ",": T.COMMA, ":": T.COLON, ";": T.SEMI, "=": T.ASSIGN,
    "+": T.PLUS, "-": T.MINUS, "*": T.STAR, "/": T.SLASH,
    "%": T.PERCENT, "<": T.LT, ">": T.GT, "!": T.NOT,
    "&": T.BITAND, "|": T.BITOR, "^": T.BITXOR,
};

const ESCAPES: Record<string, string> = {
    n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "0": "\0",
};

export interface Token {
    kind: T;
    /** The raw lexeme; for STRING the decoded text, for INT the decimal value (aurc decodes 0x..). */
    value: string;
    /** UTF-16 offsets into the source. */
    start: number;
    end: number;
    /** 1-based line and column, counted as aurc counts them. */
    line: number;
    col: number;
    /** The lexer reported this token (an unterminated string, a malformed hex literal). */
    bad?: boolean;
}

export interface Comment {
    start: number;
    end: number;
    line: number;
    endLine: number;
    text: string;
}

export interface LexResult {
    tokens: Token[];
    comments: Comment[];
    diagnostics: AuricDiagnostic[];
}

// Python's str.isdigit / isalpha / isalnum, closely enough for source text.
const isDigit = (c: string) => c !== "" && /^\p{Nd}$/u.test(c);
const isAlpha = (c: string) => c !== "" && /^\p{L}$/u.test(c);
const isAlnum = (c: string) => c !== "" && /^[\p{L}\p{N}]$/u.test(c);
const HEX_DIGITS = "0123456789abcdefABCDEF";

class Lexer {
    private i = 0;
    private line = 1;
    private col = 1;
    private readonly tokens: Token[] = [];
    private readonly comments: Comment[] = [];
    private readonly diagnostics: AuricDiagnostic[] = [];
    /** After an unterminated string the rest of its line is lexed as code, without reporting errors up to here. */
    private quietUntil = -1;

    constructor(private readonly src: string) {}

    /** The code point at UTF-16 offset `at`, or "" past the end. */
    private charAt(at: number): string {
        if (at >= this.src.length) {
            return "";
        }
        return String.fromCodePoint(this.src.codePointAt(at)!);
    }

    private peek(ahead = 0): string {
        let at = this.i;
        for (let k = 0; k < ahead && at < this.src.length; k++) {
            at += this.charAt(at).length;
        }
        return this.charAt(at);
    }

    private advance(): string {
        const c = this.charAt(this.i);
        this.i += c.length;
        if (c === "\n") {
            this.line += 1;
            this.col = 1;
        } else {
            this.col += 1;
        }
        return c;
    }

    private atEnd(): boolean {
        return this.i >= this.src.length;
    }

    /** Report an error at aurc's current position, underlining start..end. */
    private error(message: string, start: number, end: number): void {
        if (start < this.quietUntil) {
            return;
        }
        this.diagnostics.push({
            start, end, message, stage: "lex", compilerLine: this.line, compilerCol: this.col,
        });
    }

    private push(kind: T, value: string, start: number, line: number, col: number): void {
        this.tokens.push({ kind, value, start, end: this.i, line, col });
    }

    private skipTrivia(): void {
        while (!this.atEnd()) {
            const c = this.peek();
            if (c === " " || c === "\t" || c === "\r" || c === "\n") {
                this.advance();
            } else if (c === "/" && this.peek(1) === "/") {
                const start = this.i;
                const line = this.line;
                while (!this.atEnd() && this.peek() !== "\n") {
                    this.advance();
                }
                this.comments.push({ start, end: this.i, line, endLine: line, text: this.src.slice(start, this.i) });
            } else if (c === "/" && this.peek(1) === "*") {
                const start = this.i;
                const line = this.line;
                this.advance();
                this.advance();
                while (!this.atEnd() && !(this.peek() === "*" && this.peek(1) === "/")) {
                    this.advance();
                }
                if (this.atEnd()) {
                    this.error("unterminated block comment", start, this.i);
                } else {
                    this.advance();
                    this.advance();
                }
                this.comments.push({ start, end: this.i, line, endLine: this.line, text: this.src.slice(start, this.i) });
            } else {
                break;
            }
        }
    }

    private number(): void {
        const start = this.i;
        const line = this.line;
        const col = this.col;
        while (isDigit(this.peek())) {
            this.advance();
        }
        let isFloat = false;
        if (this.peek() === "." && isDigit(this.peek(1))) {
            isFloat = true;
            this.advance();
            while (isDigit(this.peek())) {
                this.advance();
            }
        }
        const text = this.src.slice(start, this.i);
        if (!isFloat && text === "0" && (this.peek() === "x" || this.peek() === "X")) {
            this.advance();
            const hstart = this.i;
            while (this.peek() !== "" && HEX_DIGITS.includes(this.peek())) {
                this.advance();
            }
            if (this.i === hstart) {
                this.error("malformed hex literal", start, this.i);
                this.push(T.INT, "0", start, line, col);
                this.tokens[this.tokens.length - 1].bad = true;
                return;
            }
            this.push(T.INT, BigInt("0x" + this.src.slice(hstart, this.i)).toString(), start, line, col);
            return;
        }
        this.push(isFloat ? T.FLOAT : T.INT, text, start, line, col);
    }

    private string(): void {
        const start = this.i;
        const line = this.line;
        const col = this.col;
        this.advance();
        let out = "";
        for (;;) {
            if (this.atEnd()) {
                // aurc also crashes on a `\` at the very end; unterminated all the same.
                this.unterminated("unterminated string literal", start, this.i, line, col);
                return;
            }
            const c = this.advance();
            if (c === '"') {
                break;
            }
            if (c === "\\" && !this.atEnd()) {
                const esc = this.advance();
                out += Object.prototype.hasOwnProperty.call(ESCAPES, esc) ? ESCAPES[esc] : esc;
            } else if (c === "\n") {
                let end = this.i - 1;
                if (this.src[end - 1] === "\r") {
                    end -= 1;
                }
                this.unterminated("newline in string literal", start, end, line, col);
                return;
            } else if (c !== "\\") {
                out += c;
            }
        }
        this.push(T.STRING, out, start, line, col);
    }

    /**
     * Report a string with no closing quote over start..end, then go on lexing
     * just after its opening quote: the rest of the line is more likely code
     * (a `)` or `{` the program needs) than text.
     */
    private unterminated(message: string, start: number, end: number, line: number, col: number): void {
        this.error(message, start, end);
        this.quietUntil = end;
        this.i = start + 1;
        this.line = line;
        this.col = col + 1;
        this.tokens.push({ kind: T.STRING, value: "", start, end: this.i, line, col, bad: true });
    }

    private ident(): void {
        const start = this.i;
        const line = this.line;
        const col = this.col;
        while (isAlnum(this.peek()) || this.peek() === "_") {
            this.advance();
        }
        const text = this.src.slice(start, this.i);
        this.push(Object.prototype.hasOwnProperty.call(KEYWORDS, text) ? KEYWORDS[text] : T.IDENT, text, start, line, col);
    }

    tokenize(): LexResult {
        for (;;) {
            this.skipTrivia();
            if (this.atEnd()) {
                this.push(T.EOF, "", this.i, this.line, this.col);
                return { tokens: this.tokens, comments: this.comments, diagnostics: this.diagnostics };
            }
            const c = this.peek();
            const start = this.i;
            const line = this.line;
            const col = this.col;
            if (isDigit(c)) {
                this.number();
            } else if (c === '"') {
                this.string();
            } else if (isAlpha(c) || c === "_") {
                this.ident();
            } else {
                const pair = c + this.peek(1);
                if (Object.prototype.hasOwnProperty.call(TWO_CHAR, pair)) {
                    this.advance();
                    this.advance();
                    this.push(TWO_CHAR[pair], pair, start, line, col);
                } else if (Object.prototype.hasOwnProperty.call(ONE_CHAR, c)) {
                    this.advance();
                    this.push(ONE_CHAR[c], c, start, line, col);
                } else {
                    this.error(`unexpected character ${pyRepr(c)}`, start, start + c.length);
                    this.advance();
                    this.push(T.INVALID, c, start, line, col);
                }
            }
        }
    }
}

export function tokenize(src: string): LexResult {
    return new Lexer(src).tokenize();
}
