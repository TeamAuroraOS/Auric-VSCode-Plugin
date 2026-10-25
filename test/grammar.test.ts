// Runs the TextMate grammar through vscode-textmate, the engine VS Code uses.

import * as assert from "assert/strict";
import * as fs from "fs";
import * as path from "path";
import { before, describe, it } from "node:test";
import * as oniguruma from "vscode-oniguruma";
import * as vsctm from "vscode-textmate";
import { BUILTINS, CONSTANTS } from "../src/language/prelude";

const ROOT = path.resolve(__dirname, "..", "..");
const GRAMMAR_PATH = path.join(ROOT, "syntaxes", "auric.tmLanguage.json");
const FIXTURES = path.join(ROOT, "test", "fixtures");

let grammar: vsctm.IGrammar;

before(async () => {
    const wasm = fs.readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"));
    await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
    const registry = new vsctm.Registry({
        onigLib: Promise.resolve({
            createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
            createOnigString: (s) => new oniguruma.OnigString(s),
        }),
        loadGrammar: async (scopeName) => scopeName === "source.auric"
            ? vsctm.parseRawGrammar(fs.readFileSync(GRAMMAR_PATH, "utf8"), GRAMMAR_PATH)
            : null,
    });
    grammar = (await registry.loadGrammar("source.auric"))!;
});

interface Tok {
    text: string;
    scopes: string[];
}

function tokenize(text: string): Tok[] {
    let stack = vsctm.INITIAL;
    const out: Tok[] = [];
    for (const line of text.split(/\r?\n/)) {
        const result = grammar.tokenizeLine(line, stack);
        for (const t of result.tokens) {
            out.push({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes });
        }
        stack = result.ruleStack;
    }
    return out;
}

/** The innermost scope of the first token whose text is `text`. */
function scopeOf(src: string, text: string): string {
    const tok = tokenize(src).find((t) => t.text === text);
    assert.ok(tok, `no token ${JSON.stringify(text)}`);
    return tok.scopes[tok.scopes.length - 1];
}

describe("grammar", () => {
    it("marks nothing invalid in the example programs", () => {
        for (const file of fs.readdirSync(FIXTURES)) {
            const bad = tokenize(fs.readFileSync(path.join(FIXTURES, file), "utf8"))
                .filter((t) => t.scopes.some((s) => s.startsWith("invalid")));
            assert.deepEqual(bad, [], file);
        }
    });

    it("colors each kind of token", () => {
        const src = [
            "// a comment",
            "let score: int = 0xFF00FF;",
            "fn add(points: int, scale: float) -> bool {",
            '    print("hi\\n", 1, 2.5, RED);',
            "    if score >= 10 && !done { return true; }",
            "    helper(score);",
            "}",
            "/* block */",
        ].join("\n");
        const expect: [string, string][] = [
            ["//", "punctuation.definition.comment.auric"],
            [" a comment", "comment.line.double-slash.auric"],
            ["let", "storage.type.auric"],
            ["score", "variable.other.declaration.auric"],
            ["int", "support.type.primitive.auric"],
            ["0xFF00FF", "constant.numeric.hex.auric"],
            ["fn", "storage.type.function.auric"],
            ["add", "entity.name.function.auric"],
            ["points", "variable.parameter.auric"],
            ["scale", "variable.parameter.auric"],
            ["->", "keyword.operator.arrow.auric"],
            ["bool", "support.type.primitive.auric"],
            ["print", "support.function.builtin.auric"],
            ["\\n", "constant.character.escape.auric"],
            ["hi", "string.quoted.double.auric"],
            ["2.5", "constant.numeric.float.auric"],
            ["RED", "variable.other.constant.auric"],
            ["if", "keyword.control.conditional.auric"],
            [">=", "keyword.operator.comparison.auric"],
            ["&&", "keyword.operator.logical.auric"],
            ["return", "keyword.control.flow.auric"],
            ["true", "constant.language.boolean.auric"],
            ["helper", "entity.name.function.call.auric"],
            [";", "punctuation.terminator.statement.auric"],
            [" block ", "comment.block.auric"],
        ];
        for (const [text, scope] of expect) {
            assert.equal(scopeOf(src, text), scope, text);
        }
    });

    it("marks what aurc rejects", () => {
        assert.equal(scopeOf("let x = 5 @ 3;", "@"), "invalid.illegal.character.auric");
        assert.equal(scopeOf("let x = 0x;", "0x"), "invalid.illegal.numeric.hex.auric");
    });

    it("knows exactly aurc's built-ins and constants", () => {
        const raw = JSON.parse(fs.readFileSync(GRAMMAR_PATH, "utf8"));
        const names = (key: string) => /\\b\((.*)\)\\b/.exec(raw.repository[key].match)![1].split("|").sort();
        assert.deepEqual(names("builtins"), Object.keys(BUILTINS).sort());
        assert.deepEqual(names("constants"), Object.keys(CONSTANTS).sort());
    });
});
