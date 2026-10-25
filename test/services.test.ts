import * as assert from "assert/strict";
import { describe, it } from "node:test";
import { analyze } from "../src/language/analyze";
import { completionsAt, hoverAt, semanticTokens, signatureHelpAt } from "../src/language/services";

/** Analyze `src` with a `|` marking the cursor; returns the analysis and the cursor offset. */
function at(src: string) {
    const offset = src.indexOf("|");
    return { a: analyze(src.slice(0, offset) + src.slice(offset + 1)), offset };
}

const PROGRAM = `// Scores and such.

let LIMIT = 10;      // most points per round
let score = 0;
let board: int[200];

// Adds points, up to LIMIT.
fn add(points: int) -> int {
    score = score + points;
    return score;
}

fn main() {
    let total = add(5);
    print("hi", 0, 0, RED);
    while true {
        let k = keys_down();
    }
}
`;

/** The offset of `word` within the first occurrence of `context` in PROGRAM. */
function find(context: string, word = context): number {
    const at = PROGRAM.indexOf(context);
    assert.ok(at >= 0 && context.includes(word), context);
    return at + context.indexOf(word);
}

describe("hover", () => {
    const hover = (context: string, word?: string) => hoverAt(analyze(PROGRAM), find(context, word))?.markdown ?? "";

    it("shows a built-in's signature and docs", () => {
        const md = hover("print");
        assert.match(md, /fn print\(text: string, x: int, y: int, color: int\)/);
        assert.match(md, /8x8 font/);
    });

    it("shows a constant's value", () => {
        assert.match(hover("RED"), /\(constant\) RED: int = 0xFF0000/);
    });

    it("shows a function's signature and the comment above it", () => {
        const md = hover("add(5)", "add");
        assert.match(md, /fn add\(points: int\) -> int/);
        assert.match(md, /Adds points, up to LIMIT\./);
    });

    it("shows a global's type and its trailing comment", () => {
        const md = hover("LIMIT");
        assert.match(md, /\(global\) let LIMIT: int/);
        assert.match(md, /most points per round/);
        assert.doesNotMatch(md, /Scores and such/);
    });

    it("shows an array's length", () => {
        assert.match(hover("board"), /\(global\) let board: int\[200\]/);
    });

    it("shows parameters and locals", () => {
        assert.match(hover("+ points", "points"), /\(parameter\) points: int/);
        assert.match(hover("total"), /\(local\) let total: int/);
    });

    it("explains keywords", () => {
        assert.match(hover("while"), /no `for` loop/);
    });

    it("has nothing for numbers and punctuation", () => {
        assert.equal(hover("200"), "");
    });
});

describe("completion", () => {
    const labels = (src: string) => {
        const { a, offset } = at(src);
        return completionsAt(a, offset).map((e) => e.label);
    };

    it("offers built-ins, constants, functions and the names in scope", () => {
        const got = labels(PROGRAM.replace("let k = keys_down();", "let k = keys_down();\n        |"));
        for (const name of ["print", "fill_rect", "KEY_A", "add", "total", "k", "score", "LIMIT", "while", "break"]) {
            assert.ok(got.includes(name), `missing ${name}`);
        }
        assert.ok(!got.includes("points"), "a parameter of another function");
        assert.ok(!got.includes("fn"), "fn inside a function");
    });

    it("only offers a local after its declaration", () => {
        const got = labels(PROGRAM.replace("let total", "|let total"));
        assert.ok(!got.includes("total"));
    });

    it("offers types after a colon or arrow", () => {
        assert.deepEqual(labels("fn main() {\n    let x: |\n}"), ["int", "float", "bool", "string"]);
        assert.deepEqual(labels("fn f() -> |"), ["int", "float", "bool", "string"]);
    });

    it("offers no built-ins at the top level", () => {
        const got = labels("|\nfn main() {}");
        assert.ok(got.includes("fn") && got.includes("let"));
        assert.ok(!got.includes("print"));
    });

    it("stays quiet in comments, strings and new names", () => {
        assert.deepEqual(labels("fn main() {\n    // pri|\n}"), []);
        assert.deepEqual(labels('fn main() {\n    print("pri|", 0, 0, RED);\n}'), []);
        assert.deepEqual(labels('fn main() {\n    print("pri|\n}'), []);
        assert.deepEqual(labels("fn main() {\n    let pri|\n}"), []);
    });

    it("inserts a call with placeholders", () => {
        const { a, offset } = at("fn main() {\n    fill|\n}");
        const entry = completionsAt(a, offset).find((e) => e.label === "fill_rect");
        assert.equal(entry?.snippet, "fill_rect(${1:x}, ${2:y}, ${3:w}, ${4:h}, ${5:color})");
    });
});

describe("signature help", () => {
    it("follows the argument under the cursor", () => {
        const { a, offset } = at('fn main() {\n    print("a", 1, |\n}');
        const help = signatureHelpAt(a, offset)!;
        assert.equal(help.label, "print(text: string, x: int, y: int, color: int)");
        assert.equal(help.activeParameter, 2);
        const [start, end] = help.parameters[2].range;
        assert.equal(help.label.slice(start, end), "y: int");
    });

    it("picks the innermost call", () => {
        const { a, offset } = at("fn f(n: int) -> int { return n; }\nfn main() {\n    print_int(f(|), 0, 0, RED);\n}");
        assert.equal(signatureHelpAt(a, offset)?.label, "f(n: int) -> int");
    });

    it("is gone after the call closes", () => {
        const { a, offset } = at("fn main() {\n    present();|\n}");
        assert.equal(signatureHelpAt(a, offset), null);
    });
});

describe("semantic tokens", () => {
    it("tells parameters, globals, built-ins and constants apart", () => {
        const tokens = semanticTokens(analyze(PROGRAM));
        const kind = (context: string, word?: string) => {
            const t = tokens.find((tok) => tok.start === find(context, word));
            return t ? [t.type, ...t.modifiers].join(" ") : "";
        };
        assert.equal(kind("fn add", "add"), "function declaration");
        assert.equal(kind("add(5)", "add"), "function");
        assert.equal(kind("add(points", "points"), "parameter declaration");
        assert.equal(kind("+ points", "points"), "parameter");
        assert.equal(kind("let LIMIT", "LIMIT"), "variable declaration readonly"); // never assigned
        assert.equal(kind("let score", "score"), "variable declaration");
        assert.equal(kind("print"), "function defaultLibrary");
        assert.equal(kind("RED"), "variable readonly");
    });
});
