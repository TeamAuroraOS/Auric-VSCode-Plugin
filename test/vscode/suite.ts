// End-to-end checks inside VS Code; run by test/vscode/run.ts.

import * as assert from "assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const FIXTURES = path.resolve(__dirname, "..", "..", "..", "test", "fixtures");

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 10000): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const value = probe();
        if (value !== undefined) {
            return value;
        }
        if (Date.now() > end) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise((r) => setTimeout(r, 100));
    }
}

function positionOf(doc: vscode.TextDocument, needle: string, delta = 0): vscode.Position {
    const offset = doc.getText().indexOf(needle);
    assert.ok(offset >= 0, `no ${needle}`);
    return doc.positionAt(offset + delta);
}

const hoverText = (hovers: vscode.Hover[]) => hovers.flatMap((h) => h.contents)
    .map((c) => (typeof c === "string" ? c : c.value)).join("\n");

const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

let snake: vscode.TextDocument;

test("opens .aur files as Auric and activates", async () => {
    snake = await vscode.workspace.openTextDocument(path.join(FIXTURES, "snake.aur"));
    await vscode.window.showTextDocument(snake);
    assert.equal(snake.languageId, "auric");
    const ext = vscode.extensions.getExtension("DisLoPik.auric");
    assert.ok(ext, "extension not found");
    await waitFor("activation", () => (ext.isActive ? true : undefined));
});

test("a valid program has no problems", async () => {
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(vscode.languages.getDiagnostics(snake.uri), []);
});

test("reports aurc's errors and follows edits", async () => {
    const doc = await vscode.workspace.openTextDocument({
        language: "auric",
        content: "fn main() {\n    let x: int = 1.5;\n    print(nam, 0, 0, RED);\n}\n",
    });
    const editor = await vscode.window.showTextDocument(doc);
    const diags = await waitFor("diagnostics", () => {
        const d = vscode.languages.getDiagnostics(doc.uri);
        return d.length ? d : undefined;
    });
    assert.deepEqual(diags.map((d) => [d.range.start.line, d.message, d.severity]), [
        [1, "variable 'x' declared as int but initialized with float", vscode.DiagnosticSeverity.Error],
        [2, "use of undeclared name 'nam'", vscode.DiagnosticSeverity.Error],
    ]);
    assert.equal(doc.getText(diags[0].range), "1.5");
    assert.equal(diags[0].source, "auric");

    await editor.edit((e) => e.replace(diags[0].range, "1"));
    await waitFor("one diagnostic left", () => (vscode.languages.getDiagnostics(doc.uri).length === 1 ? true : undefined));
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
});

test("hover shows signatures and docs", async () => {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider", snake.uri, positionOf(snake, "fill_rect(", 2));
    assert.match(hoverText(hovers), /fn fill_rect\(x: int, y: int, w: int, h: int, color: int\)/);
    const mine = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider", snake.uri, positionOf(snake, "steer(0)", 1));
    assert.match(hoverText(mine), /fn steer\(d: int\)/);
});

test("completion offers built-ins, globals and snippets", async () => {
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        "vscode.executeCompletionItemProvider", snake.uri, positionOf(snake, "    frame = frame + 1;"));
    const labels = list.items.map((i) => (typeof i.label === "string" ? i.label : i.label.label));
    for (const name of ["fill_rect", "snake_len", "KEY_START", "place_food", "gameloop"]) {
        assert.ok(labels.includes(name), `missing ${name}`);
    }
});

test("signature help follows the arguments", async () => {
    const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
        "vscode.executeSignatureHelpProvider", snake.uri, positionOf(snake, "HUD_Y + 4, C_TEXT"));
    assert.equal(help.signatures[help.activeSignature].label, "print(text: string, x: int, y: int, color: int)");
    assert.equal(help.activeParameter, 2);
});

test("semantic tokens tell names apart", async () => {
    const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>(
        "vscode.provideDocumentSemanticTokensLegend", snake.uri);
    const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>(
        "vscode.provideDocumentSemanticTokens", snake.uri);
    assert.deepEqual(legend.tokenTypes, ["function", "parameter", "variable"]);
    assert.ok(tokens.data.length >= 5 * 100, `only ${tokens.data.length / 5} tokens`);
});

const auricLang = process.env.AURIC_LANG ?? "";
const haveCompiler = fs.existsSync(path.join(auricLang, "compiler", "aurc.py"));

test("Show Generated C runs aurc emit-c", async () => {
    if (!haveCompiler) {
        console.log("    (skipped: no auric-lang)");
        return;
    }
    await vscode.workspace.getConfiguration("auric").update(
        "compiler.auricLangPath", auricLang, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("auric.showGeneratedC", vscode.Uri.file(path.join(FIXTURES, "hello.aur")));
    const c = await waitFor("the C document", () => vscode.workspace.textDocuments.find(
        (d) => d.languageId === "c" && d.getText().includes("Generated by aurc")));
    assert.match(c.getText(), /au_main/);
});

test("Build App produces an AUR1 container", async () => {
    if (!haveCompiler) {
        console.log("    (skipped: no auric-lang)");
        return;
    }
    const outDir = process.env.AURIC_TEST_OUT!;
    await vscode.workspace.getConfiguration("auric").update(
        "build.outputDirectory", outDir, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("auric.build", vscode.Uri.file(path.join(FIXTURES, "hello.aur")));
    const bin = path.join(outDir, "hello.bin");
    assert.ok(fs.existsSync(bin), "no hello.bin (is devkitARM on PATH?)");
    assert.equal(fs.readFileSync(bin).subarray(0, 4).toString("latin1"), "AUR1");
});

export async function run(): Promise<void> {
    let failed = 0;
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log(`  ok   ${name}`);
        } catch (err) {
            failed += 1;
            console.log(`  FAIL ${name}\n${(err as Error).stack}`);
        }
    }
    if (failed) {
        throw new Error(`${failed} of ${tests.length} VS Code tests failed`);
    }
    console.log(`  all ${tests.length} VS Code tests passed`);
}
