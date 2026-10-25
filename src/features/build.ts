import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { AURIC } from "./documents";

const DEVKITARM_URL = "https://devkitpro.org/wiki/Getting_Started";

interface Compiler {
    command: string;
    args: string[];
    cwd?: string;
}

interface RunResult {
    code: number | null;
    stdout: string;
    stderr: string;
    error?: NodeJS.ErrnoException;
}

const config = () => vscode.workspace.getConfiguration("auric");

/**
 * Forward slashes: Windows Python reads them, and so does the MSYS2 Python
 * that devkitPro puts on PATH, which takes "D:\x" for a relative path.
 */
const slashes = (p: string) => p.replace(/\\/g, "/");

function expandPath(value: string, file: string): string {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file)) ?? vscode.workspace.workspaceFolders?.[0];
    return value
        .replace(/^~(?=$|[\\/])/, os.homedir())
        .replace(/\$\{workspaceFolder\}/g, folder?.uri.fsPath ?? path.dirname(file));
}

const isAuricLang = (dir: string) => fs.existsSync(path.join(dir, "compiler", "aurc.py"));

function findAuricLang(file: string): string | undefined {
    const candidates: string[] = [];
    for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
        candidates.push(dir, path.join(dir, "auric-lang"));
        if (path.dirname(dir) === dir) {
            break;
        }
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        candidates.push(folder.uri.fsPath, path.join(folder.uri.fsPath, "auric-lang"));
    }
    return candidates.find(isAuricLang);
}

/** How to run aurc for `file`, or a reason it cannot be found. */
function findCompiler(file: string): Compiler | string {
    const exe = config().get<string>("compiler.path", "").trim();
    if (exe) {
        return { command: expandPath(exe, file), args: [] };
    }
    const python = config().get<string>("compiler.pythonPath", "").trim() || "python";
    const configured = config().get<string>("compiler.auricLangPath", "").trim();
    if (configured) {
        const dir = path.resolve(expandPath(configured, file));
        if (!isAuricLang(dir)) {
            return `auric.compiler.auricLangPath (${dir}) has no compiler/aurc.py in it.`;
        }
        return { command: python, args: ["-m", "compiler.aurc"], cwd: dir };
    }
    const found = findAuricLang(file);
    if (found) {
        return { command: python, args: ["-m", "compiler.aurc"], cwd: found };
    }
    return { command: "aurc", args: [] };
}

const quote = (arg: string) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);

function run(compiler: Compiler, args: string[], output: vscode.OutputChannel, token: vscode.CancellationToken,
    echoStdout: boolean): Promise<RunResult> {
    const all = [...compiler.args, ...args];
    // Batch files only run through the shell, which then needs the quoting.
    const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(compiler.command);
    output.appendLine(`> ${[compiler.command, ...all].map(quote).join(" ")}` + (compiler.cwd ? `   (in ${compiler.cwd})` : ""));
    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        const child = cp.spawn(shell ? quote(compiler.command) : compiler.command, shell ? all.map(quote) : all,
            { cwd: compiler.cwd, shell, windowsHide: true });
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
            if (echoStdout) {
                output.append(chunk);
            }
        });
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
            output.append(chunk);
        });
        const cancel = token.onCancellationRequested(() => child.kill());
        child.on("error", (error) => {
            cancel.dispose();
            resolve({ code: null, stdout, stderr, error });
        });
        child.on("close", (code) => {
            cancel.dispose();
            resolve({ code, stdout, stderr });
        });
    });
}

async function sourceDocument(uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
    const doc = uri instanceof vscode.Uri
        ? await vscode.workspace.openTextDocument(uri)
        : vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== AURIC) {
        vscode.window.showErrorMessage("Open an Auric (.aur) file first.");
        return undefined;
    }
    if (doc.uri.scheme !== "file") {
        vscode.window.showErrorMessage("Save the file to disk before compiling it.");
        return undefined;
    }
    if (!vscode.workspace.isTrusted) {
        vscode.window.showErrorMessage("Compiling runs aurc, which is turned off in untrusted workspaces.");
        return undefined;
    }
    if (doc.isDirty && !(await doc.save())) {
        return undefined;
    }
    return doc;
}

/** Explain a failed run; true when there was one. Notifications are not awaited, so the command ends. */
function reportFailure(result: RunResult, compiler: Compiler, output: vscode.OutputChannel): boolean {
    if (result.error) {
        const missing = result.error.code === "ENOENT";
        const message = missing
            ? `Could not find the Auric compiler (${compiler.command}). Set auric.compiler.path to aurc.exe, `
              + "or auric.compiler.auricLangPath to the auric-lang folder of an AuroraOS checkout."
            : `Could not run ${compiler.command}: ${result.error.message}`;
        vscode.window.showErrorMessage(message, "Open Settings").then((choice) => {
            if (choice) {
                vscode.commands.executeCommand("workbench.action.openSettings", "auric.compiler");
            }
        });
        return true;
    }
    if (result.code === 0) {
        return false;
    }
    output.show(true);
    const text = (result.stderr || result.stdout).trim();
    if (/arm-none-eabi-gcc was not found/.test(text)) {
        vscode.window.showErrorMessage("Building needs devkitARM (arm-none-eabi-gcc) on PATH.", "Get devkitARM")
            .then((choice) => {
                if (choice) {
                    vscode.env.openExternal(vscode.Uri.parse(DEVKITARM_URL));
                }
            });
        return true;
    }
    const lines = text.split(/\r?\n/).filter(Boolean);
    const summary = lines.find((l) => /error/i.test(l)) ?? lines[lines.length - 1] ?? `exit code ${result.code}`;
    vscode.window.showErrorMessage(`aurc failed: ${summary}`);
    return true;
}

async function build(output: vscode.OutputChannel, uri?: vscode.Uri): Promise<void> {
    const doc = await sourceDocument(uri);
    if (!doc) {
        return;
    }
    const file = doc.uri.fsPath;
    const compiler = findCompiler(file);
    if (typeof compiler === "string") {
        vscode.window.showErrorMessage(compiler);
        return;
    }
    const dir = path.dirname(file);
    const stem = path.basename(file, path.extname(file));
    const args = ["build", slashes(file)];
    const outDir = config().get<string>("build.outputDirectory", "").trim();
    if (outDir) {
        const target = path.resolve(dir, expandPath(outDir, file));
        fs.mkdirSync(target, { recursive: true });
        args.push("-o", slashes(path.join(target, `${stem}.bin`)));
    }
    const icon = path.join(dir, `${stem}.icon`);
    if (config().get<boolean>("build.useIconFile", true) && fs.existsSync(icon)) {
        args.push("--icon", slashes(icon));
    }
    args.push(...config().get<string[]>("build.extraArgs", []));

    output.appendLine("");
    const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Building ${path.basename(file)}`, cancellable: true },
        (_progress, token) => run(compiler, args, output, token, true));
    if (reportFailure(result, compiler, output)) {
        return;
    }
    const built = /^Built (.+)$/m.exec(result.stdout)?.[1]?.trim();
    const where = built ? path.resolve(compiler.cwd ?? dir, built) : undefined;
    vscode.window.showInformationMessage(
        `Built ${where ? path.basename(where) : stem + ".bin"}. Copy it to SD:\\Aurora\\Apps\\ to run it.`,
        ...(where ? ["Show in Folder"] : []),
    ).then((choice) => {
        if (choice && where) {
            vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(where));
        }
    });
}

async function showGeneratedC(output: vscode.OutputChannel, uri?: vscode.Uri): Promise<void> {
    const doc = await sourceDocument(uri);
    if (!doc) {
        return;
    }
    const compiler = findCompiler(doc.uri.fsPath);
    if (typeof compiler === "string") {
        vscode.window.showErrorMessage(compiler);
        return;
    }
    output.appendLine("");
    const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Generating C", cancellable: true },
        (_progress, token) => run(compiler, ["emit-c", slashes(doc.uri.fsPath)], output, token, false));
    if (reportFailure(result, compiler, output)) {
        return;
    }
    const c = await vscode.workspace.openTextDocument({ language: "c", content: result.stdout });
    await vscode.window.showTextDocument(c, { viewColumn: vscode.ViewColumn.Beside, preview: true });
}

export function registerBuildCommands(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel("Auric");
    context.subscriptions.push(
        output,
        vscode.commands.registerCommand("auric.build", (uri?: vscode.Uri) => build(output, uri)),
        vscode.commands.registerCommand("auric.showGeneratedC", (uri?: vscode.Uri) => showGeneratedC(output, uri)),
    );
}
