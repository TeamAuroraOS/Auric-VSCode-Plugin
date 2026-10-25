// Differential test of the TypeScript checker against the real aurc front end.
//
//   npm run test:parity [-- <auric-lang dir>]
//
// Mutates the fixture programs (deleting, duplicating, swapping and replacing
// tokens, truncating, ...) and checks every mutant both ways:
//   * aurc accepts it            -> the extension reports nothing;
//   * aurc raises "msg" at line N -> the extension reports "msg" at line N too
//     (aurc stops at its first error; the extension may report more).
// Python comes from $PYTHON (default "python"); auric-lang from the argument,
// $AURIC_LANG, or ../aurora/auric-lang.

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { analyze } from "../src/language/analyze";
import { AuricDiagnostic } from "../src/language/diagnostic";
import { T, tokenize } from "../src/language/lexer";
import { BUILTINS, CONSTANTS } from "../src/language/prelude";

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURES = path.join(ROOT, "test", "fixtures");
const MUTANTS_PER_PROGRAM = Number(process.env.MUTANTS ?? 1500);

const auricLang = path.resolve(process.argv[2] ?? process.env.AURIC_LANG ?? path.join(ROOT, "..", "aurora", "auric-lang"));
const python = process.env.PYTHON ?? "python";

// mulberry32: a small seeded PRNG, so runs are repeatable.
function prng(seed: number): () => number {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const POOL = [
    ";", "{", "}", "(", ")", "[", "]", ",", ":", "->", "=", "==", "!=", "+", "-", "*", "/", "%",
    "&&", "||", "!", "<", "<=", "<<", ">>", "&", "|", "^", "0", "1", "7", "1.5", "0xFF", "\"s\"",
    "true", "false", "x", "y", "fn", "let", "if", "else", "while", "return", "break", "continue",
    "int", "float", "bool", "string", "print", "rand", "millis", "clear", "RED", "KEY_A", "main",
    "@", "#", "0x", "\"open", "/*", "*/", ".", "constructor", "toString",
];
const NAMES = [...Object.keys(BUILTINS), ...Object.keys(CONSTANTS), "x", "undefined_name", "main"];

function mutate(src: string, rand: () => number): string {
    const tokens = tokenize(src).tokens.filter((t) => t.kind !== T.EOF);
    const pick = <V>(items: V[]): V => items[Math.floor(rand() * items.length)];
    const tok = pick(tokens);
    const splice = (start: number, end: number, text: string) => src.slice(0, start) + text + src.slice(end);
    switch (Math.floor(rand() * 9)) {
        case 0: // delete a token
            return splice(tok.start, tok.end, "");
        case 1: // duplicate a token
            return splice(tok.end, tok.end, " " + src.slice(tok.start, tok.end));
        case 2: // replace a token
            return splice(tok.start, tok.end, pick(POOL));
        case 3: { // replace a name with another
            const idents = tokens.filter((t) => t.kind === T.IDENT);
            const target = idents.length ? pick(idents) : tok;
            const others = [...new Set(idents.map((t) => t.value)), ...NAMES];
            return splice(target.start, target.end, pick(others));
        }
        case 4: { // swap with the next token
            const i = tokens.indexOf(tok);
            const next = tokens[i + 1];
            if (!next) {
                return splice(tok.start, tok.end, "");
            }
            return src.slice(0, tok.start) + src.slice(next.start, next.end) + src.slice(tok.end, next.start)
                + src.slice(tok.start, tok.end) + src.slice(next.end);
        }
        case 5: // insert a token
            return splice(tok.start, tok.start, pick(POOL) + " ");
        case 6: { // delete a line
            const lines = src.split("\n");
            lines.splice(Math.floor(rand() * lines.length), 1);
            return lines.join("\n");
        }
        case 7: // truncate, as while typing
            return src.slice(0, tok.end);
        default: // change a literal's or a type's kind
            return splice(tok.start, tok.end, pick(["1", "1.0", "\"t\"", "true", "int", "float", "bool", "string"]));
    }
}

interface AurcResult {
    ok?: boolean;
    crash?: string;
    stage?: string;
    message?: string;
    line?: number;
    col?: number;
}

function matches(d: AuricDiagnostic, r: AurcResult): boolean {
    if (d.message !== r.message || d.stage !== r.stage || d.compilerLine !== r.line) {
        return false;
    }
    return d.stage === "type" || d.compilerCol === r.col;
}

function main(): void {
    if (!fs.existsSync(path.join(auricLang, "compiler", "typecheck.py"))) {
        console.error(`auric-lang not found at ${auricLang}; pass its path or set AURIC_LANG.`);
        process.exit(2);
    }
    const programs = fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".aur"))
        .map((f) => fs.readFileSync(path.join(FIXTURES, f), "utf8").replace(/\r\n/g, "\n"));
    const rand = prng(20261024);
    const sources: string[] = [...programs];
    for (const program of programs) {
        for (let i = 0; i < MUTANTS_PER_PROGRAM; i++) {
            let mutant = mutate(program, rand);
            if (rand() < 0.25) {
                mutant = mutate(mutant, rand); // two mistakes at once
            }
            sources.push(mutant);
        }
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auric-parity-"));
    const sourcesPath = path.join(dir, "sources.json");
    const resultsPath = path.join(dir, "results.json");
    fs.writeFileSync(sourcesPath, JSON.stringify(sources));
    // Forward slashes: both Windows Python and MSYS2's (devkitPro's) Python read them.
    // The script goes by a relative path, as MSYS2's Python treats "D:/..." as relative.
    const args = [auricLang, sourcesPath, resultsPath].map((p) => p.replace(/\\/g, "/"));
    const run = spawnSync(python, ["-I", "scripts/aurc_check.py", ...args], { encoding: "utf8", cwd: ROOT });
    if (run.status !== 0) {
        console.error(`${python} failed:\n${run.stderr}`);
        process.exit(2);
    }
    const results: AurcResult[] = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
    fs.rmSync(dir, { recursive: true, force: true });

    let accepted = 0;
    let rejected = 0;
    let crashed = 0;
    let firstSame = 0;
    let extra = 0;
    const failures: string[] = [];
    sources.forEach((src, i) => {
        const r = results[i];
        let ours: AuricDiagnostic[];
        try {
            ours = analyze(src).diagnostics;
        } catch (e) {
            failures.push(`#${i}: the extension crashed: ${(e as Error).stack}\n${src}`);
            return;
        }
        if (r.crash) {
            crashed += 1;
            return;
        }
        if (r.ok) {
            accepted += 1;
            if (ours.length) {
                failures.push(`#${i}: aurc accepts it, the extension reports ` +
                    ours.map((d) => `[${d.compilerLine}] ${d.message}`).join("; ") + `\n${src}`);
            }
            return;
        }
        rejected += 1;
        if (!ours.some((d) => matches(d, r))) {
            failures.push(`#${i}: aurc: ${r.stage} error (line ${r.line}, col ${r.col}): ${r.message}\n` +
                `extension: ${ours.map((d) => `${d.stage} [${d.compilerLine}:${d.compilerCol}] ${d.message}`).join("; ") || "nothing"}` +
                `\n${src}`);
            return;
        }
        if (matches(ours[0], r)) {
            firstSame += 1;
        }
        if (ours.length > 1) {
            extra += 1;
        }
    });

    console.log(`${sources.length} programs: aurc accepted ${accepted}, rejected ${rejected}, crashed on ${crashed}.`);
    console.log(`Rejected ones where the extension's first error is aurc's: ${firstSame}/${rejected}; ` +
        `with errors beyond aurc's first: ${extra}.`);
    if (failures.length) {
        console.log(`\n${failures.length} mismatches. First ones:\n`);
        console.log(failures.slice(0, 8).join("\n\n----\n\n"));
        process.exit(1);
    }
    console.log("No mismatches.");
}

main();
