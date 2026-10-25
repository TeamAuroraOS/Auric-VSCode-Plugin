import * as vscode from "vscode";
import { registerBuildCommands } from "./features/build";
import { registerDiagnostics } from "./features/diagnostics";
import { registerLanguageFeatures } from "./features/languageFeatures";

export function activate(context: vscode.ExtensionContext): void {
    registerDiagnostics(context);
    registerLanguageFeatures(context);
    registerBuildCommands(context);
}

export function deactivate(): void {}
