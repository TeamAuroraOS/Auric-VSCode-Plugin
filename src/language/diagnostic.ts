export type Stage = "lex" | "parse" | "type";

/** An error in an Auric program, with the message aurc prints for it. */
export interface AuricDiagnostic {
    /** UTF-16 offsets of the text to underline. */
    start: number;
    end: number;
    message: string;
    stage: Stage;
    /** The 1-based line aurc reports for this error (0 when it reports none). */
    compilerLine: number;
    /** The 1-based column aurc reports (0 when it reports none). */
    compilerCol: number;
    /** A suggestion shown after aurc's message. */
    hint?: string;
}

/** Python's repr() of a string, as aurc's messages quote tokens with it. */
export function pyRepr(s: string): string {
    const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
    let out = quote;
    for (const ch of s) {
        const cp = ch.codePointAt(0)!;
        if (ch === quote || ch === "\\") {
            out += "\\" + ch;
        } else if (ch === "\n") {
            out += "\\n";
        } else if (ch === "\r") {
            out += "\\r";
        } else if (ch === "\t") {
            out += "\\t";
        } else if (cp < 0x20 || (cp >= 0x7f && cp <= 0xa0) || cp === 0xad) {
            out += "\\x" + cp.toString(16).padStart(2, "0");
        } else if (/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u.test(ch) && ch !== " ") {
            out += cp > 0xffff ? "\\U" + cp.toString(16).padStart(8, "0") : "\\u" + cp.toString(16).padStart(4, "0");
        } else {
            out += ch;
        }
    }
    return out + quote;
}
