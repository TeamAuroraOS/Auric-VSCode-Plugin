import * as assert from "assert/strict";
import * as fs from "fs";
import * as path from "path";
import { describe, it } from "node:test";
import { analyze } from "../src/language/analyze";

const FIXTURES = path.resolve(__dirname, "..", "..", "test", "fixtures");

/** Each error as "line: message [underlined text]" (line of the underline, 1-based). */
function errors(src: string): string[] {
    return analyze(src).diagnostics.map((d) => {
        const line = src.slice(0, d.start).split("\n").length;
        const hint = d.hint ? ` (${d.hint})` : "";
        return `${line}: ${d.message}${hint} [${src.slice(d.start, d.end)}]`;
    });
}

/** Wrap statements in `fn main() { ... }`, one per line, so line 2 is the first. */
const main = (...lines: string[]) => ["fn main() {", ...lines.map((l) => "    " + l), "}"].join("\n");

describe("valid programs", () => {
    for (const file of fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".aur"))) {
        it(`${file} has no errors`, () => {
            assert.deepEqual(errors(fs.readFileSync(path.join(FIXTURES, file), "utf8")), []);
        });
    }

    it("accepts names that are also JavaScript object properties", () => {
        assert.deepEqual(errors(main("let constructor = 1;", "let toString = constructor + 1;")), []);
    });

    it("accepts CRLF line ends", () => {
        assert.deepEqual(errors(main("let x = 1;", "x = x + 1;").replace(/\n/g, "\r\n")), []);
    });
});

describe("aurc's errors", () => {
    const cases: [string, string, string][] = [
        ["lexer: stray character", main("let x = 5 @ 3;"), "2: unexpected character '@' [@]"],
        ["lexer: newline in a string", main('print("hi, 0, 0, WHITE);'), '2: newline in string literal ["hi, 0, 0, WHITE);]'],
        ["lexer: malformed hex", main("let c = 0x;"), "2: malformed hex literal [0x]"],
        ["lexer: unterminated block comment", "/* never ends\nfn main() {}", "1: unterminated block comment [/* never ends\nfn main() {}]"],
        ["missing semicolon", main("let x = 5", 'print("hi", 0, 0, WHITE);'), "2: expected ';', found 'print' [5]"],
        ["missing type", main("let x: = 5;"), "2: expected a type, found '=' [=]"],
        ["array length 0", "let a: int[0];\nfn main() {}", "1: array length must be at least 1 [0]"],
        ["statement at top level", 'print("hi", 0, 0, WHITE);\nfn main() {}', "1: expected a function or global declaration, found 'print' [print]"],
        ["undeclared name", main('print(nam, 0, 0, WHITE);'), "2: use of undeclared name 'nam' [nam]"],
        ["assignment to undeclared", main("y = 1;"), "2: assignment to undeclared variable 'y' [y]"],
        ["declared type mismatch", main("let x: int = 1.5;"), "2: variable 'x' declared as int but initialized with float [1.5]"],
        ["int and float mixed", main("let y = 1 + 2.0;"), "2: '+' expects two ints or two floats, found int and float [1 + 2.0]"],
        ["modulo of floats", main("let y = 1.0 % 2.0;"), "2: '%' is only defined for int [1.0 % 2.0]"],
        ["bitwise on bool", main("let y = true & false;"), "2: '&' expects two ints, found bool and bool [true & false]"],
        ["comparing different types", main('let b = 1 == "1";'), "2: '==' cannot compare int and string [1 == \"1\"]"],
        ["not on int", main("let b = !1;"), "2: '!' expects bool, found int [!1]"],
        ["negating a string", main('let s = -"a";'), "2: unary '-' expects a number, found string [-\"a\"]"],
        ["argument count", main('print("hi");'), "2: 'print' expects 4 argument(s), got 1 [print]"],
        ["argument type", main("print(5, 0, 0, WHITE);"), "2: argument 1 of 'print' expects string, found int [5]"],
        ["unknown function", main("jump();"), "2: call to unknown function 'jump' [jump]"],
        ["condition not bool", main("if 1 { }"), "2: if condition must be bool, found int [1]"],
        ["while condition not bool", main("while 0 { }"), "2: while condition must be bool, found int [0]"],
        ["break outside a loop", main("break;"), "2: 'break' outside of a loop [break]"],
        ["indexing a non-array", main("let x = 1;", "x[0] = 2;"), "3: 'x' is int, not an array, so it cannot be indexed [x]"],
        ["float index", main("let a: int[4];", "a[1.5] = 2;"), "3: array index must be int, found float [1.5]"],
        ["element type", main("let a: int[4];", "a[0] = true;"), "3: cannot assign bool to an element of 'a' of type int [true]"],
        ["assigning another type", main("let x = 1;", 'x = "one";'), "3: cannot assign string to 'x' of type int [\"one\"]"],
        ["void bound to a variable", main("let x = present();"), "2: cannot bind a void value to a variable [present()]"],
        ["redeclared in one scope", main("let x = 1;", "let x = 2;"), "3: 'x' is already declared in this scope [x]"],
        ["predefined name", main("let RED = 1;"), "2: 'RED' is a predefined name and cannot be used as a variable [RED]"],
        ["return value from void", "fn f() { return 1; }\nfn main() {}", "1: return with a value in a void function [1]"],
        ["return nothing from int", "fn f() -> int { return; }\nfn main() {}", "1: return without a value in a function returning int [return]"],
        ["wrong return type", "fn f() -> int { return 1.0; }\nfn main() {}", "1: returning float from a function declared to return int [1.0]"],
        ["missing main", "fn start() {}", "1: program has no 'fn main()' entry point []"],
        ["main with parameters", "fn main(x: int) {}", "1: 'fn main' must take no parameters [x]"],
        ["main returning a value", "fn main() -> int { return 0; }", "1: 'fn main' must not return a value [int]"],
        ["duplicate function", "fn main() {}\nfn main() {}", "2: function 'main' is defined more than once [main]"],
        ["redefining a built-in", "fn print() {}\nfn main() {}", "1: 'print' is a built-in and cannot be redefined [print]"],
        ["global not constant", "let n = rand(5);\nfn main() {}", "1: global 'n' must be initialized with a constant expression (literals, predefined constants, and arithmetic on them) [rand(5)]"],
        ["global named like a function", "let main = 1;\nfn main() {}", "1: 'main' is already declared as a function [main]"],
    ];
    for (const [name, src, expected] of cases) {
        it(name, () => assert.deepEqual(errors(src), [expected]));
    }
});

describe("while typing: one mistake, one error", () => {
    it("a half-typed name", () => {
        assert.deepEqual(errors(main("pri")), ["2: expected ';', found '}' [i]"]);
    });

    it("a half-typed call", () => {
        // aurc reads `clear(BLACK)` as the next argument.
        assert.deepEqual(errors(main('print("hi", 0,', "clear(BLACK);")), ["3: expected ')', found ';' [;]"]);
    });

    it("a half-typed if", () => {
        // aurc reads `if x > x` and then finds the `=`.
        assert.deepEqual(errors(main("let x = 1;", "if x > ", "x = 2;")), ["4: expected '{', found '=' [=]"]);
    });

    it("a missing ')' leaves the next line alone", () => {
        assert.deepEqual(errors(main('print("hi", 0, 0, WHITE;', "let y: int = 1.5;")), [
            "2: expected ')', found ';' [;]",
            "3: variable 'y' declared as int but initialized with float [1.5]",
        ]);
    });

    it("a broken loop header hides the 'break' it leaves outside a loop", () => {
        assert.deepEqual(errors(main("let i = 0;", "while i <", "{", "    break;", "}")),
            ["3: expected an expression, found '{' [<]"]);
    });

    it("a ';' inside a call", () => {
        assert.deepEqual(errors(main('print("hi"; 0, 0, WHITE);')), ["2: expected ')', found ';' [;]"]);
    });

    it("a string left open", () => {
        assert.deepEqual(errors(main('let s = "abc', "let t = 1;")), ['2: newline in string literal ["abc]']);
    });

    it("a '}' missing before the next function", () => {
        const src = 'fn a() {\n    print("a", 0, 0, WHITE);\n\nfn main() {\n    a();\n}';
        assert.deepEqual(errors(src),
            ["4: expected an expression, found 'fn' (is a '}' missing before this function?) [fn]"]);
    });

    it("a '}' too many", () => {
        assert.deepEqual(errors(main("let x = 1;", "}", "x = 2;")),
            ["4: expected a function or global declaration, found 'x' [x]"]);
    });

    it("a '{' missing after if, with the body indented", () => {
        assert.deepEqual(errors(main("let x = 1;", "if x > 0", "    x = 2;", "}")),
            ["3: expected '{', found 'x' [0]"]);
    });

    it("a C-style if without braces", () => {
        assert.deepEqual(errors(main("let x = 1;", "if x > 0 x = 2;", "x = 3;")),
            ["3: expected '{', found 'x' [x]"]);
    });

    it("junk before a function's '{'", () => {
        const src = "fn is_even(n: int) ) -> bool {\n    return n % 2 == 0;\n}\nfn main() {\n    if is_even(2) { }\n}";
        assert.deepEqual(errors(src), ["1: expected '{', found ')' [)]"]);
    });

    it("a broken signature hides the unknown names it causes", () => {
        const src = "fn add(a: int, b) -> int {\n    return a + b;\n}\nfn main() {\n    let s = add(1, 2);\n}";
        assert.deepEqual(errors(src), ["1: expected ':', found ')' [)]"]);
    });

    it("a broken let still declares its name", () => {
        assert.deepEqual(errors(main("let x = ;", "x = 2;")), ["2: expected an expression, found ';' [;]"]);
    });

    it("a let cut short does not give its variable the wrong type", () => {
        assert.deepEqual(errors(main("let a: int[4];", "let v = a a[0];", "v = v + 1;")),
            ["3: expected ';', found 'a' [a]"]);
    });

    it("a let missing only its ';' keeps its type", () => {
        assert.deepEqual(errors(main("let v = 1.5", "let w: int = v;")), [
            "2: expected ';', found 'let' [5]",
            "3: variable 'w' declared as int but initialized with float [v]",
        ]);
    });
});

describe("several errors at once", () => {
    it("reports independent type errors together", () => {
        assert.deepEqual(errors(main("let a: int = 1.5;", "let b = c;", 'print(1, 0, 0, RED);')), [
            "2: variable 'a' declared as int but initialized with float [1.5]",
            "3: use of undeclared name 'c' [c]",
            "4: argument 1 of 'print' expects string, found int [1]",
        ]);
    });

    it("keeps type errors in other functions beside a syntax error", () => {
        const src = "fn f() {\n    let x: int = true;\n}\nfn main() {\n    let y = 1\n}";
        assert.deepEqual(errors(src), [
            "2: variable 'x' declared as int but initialized with bool [true]",
            "5: expected ';', found '}' [1]",
        ]);
    });

    it("reports the same mistake at each use", () => {
        assert.deepEqual(errors(main("x = 1;", "x = 2;")), [
            "2: assignment to undeclared variable 'x' [x]",
            "3: assignment to undeclared variable 'x' [x]",
        ]);
    });
});

describe("aurc positions", () => {
    it("keeps aurc's line and column for syntax errors", () => {
        const [d] = analyze(main("let x = 5", "clear(BLACK);")).diagnostics;
        assert.equal(d.compilerLine, 3);
        assert.equal(d.compilerCol, 5);
    });

    it("keeps aurc's line for type errors", () => {
        const [d] = analyze(main("let x = 1 +", "    2.0;")).diagnostics;
        assert.equal(d.message, "'+' expects two ints or two floats, found int and float");
        assert.equal(d.compilerLine, 2);
    });
});
